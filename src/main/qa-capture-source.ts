/**
 * qa-capture-source.ts — the QA-identity-only file-fed microphone.
 *
 * Hosted runners have no microphone, so the packaged QA build can feed a WAV as the capture device through
 * Chromium's own fake audio capture (the file loops). The renderer's real getUserMedia, worklet, VAD, ASR,
 * speaker and save paths then run unchanged on a known input.
 *
 * Invariants:
 * - index.ts calls installQaCaptureSource only under QA_IDENTITY_BUILD, so the env name and switch strings are
 *   compiled out of shipping bytes; scripts/lib/qa-fault-hook.mjs proves it on every package through
 *   QA_CAPTURE_ENV, which only this module puts into a main-process bundle.
 * - Inert unless the app is packaged, ASKTOTO_USERDATA names an isolated profile and METIS_QA_CAPTURE_FILE
 *   resolves to an existing .wav inside that profile.
 * - Touches no permission surface: no systemPreferences, TCC or media-access API, no granted permission, no
 *   display-media handler. The audit event carries no path or file name.
 */
import { statSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, relative } from 'node:path'
import type { AuditEvent } from './logger'
import { QA_IDENTITY_BUILD } from './qa-identity'

/** The env var naming the WAV to feed; also the packaged-bytes marker scripts/lib/qa-fault-hook.mjs looks for. */
export const QA_CAPTURE_ENV = 'METIS_QA_CAPTURE_FILE'

export type QaCaptureSwitch = readonly [name: string, value?: string]

export type QaCaptureRefusal =
  | 'shipping-identity'
  | 'unpackaged'
  | 'no-profile'
  | 'no-capture-file'
  | 'relative-path'
  | 'not-wav'
  | 'missing-file'
  | 'outside-profile'

export type QaCaptureDecision =
  | { readonly switches: readonly QaCaptureSwitch[]; readonly reason: null }
  | { readonly switches: null; readonly reason: QaCaptureRefusal }

export interface QaCaptureInput {
  readonly qaIdentity: boolean
  readonly packaged: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  /** Resolves every symlink; throws when the path does not exist. */
  readonly realpath: (path: string) => string
  /** True only for an existing regular file. */
  readonly exists: (path: string) => boolean
}

const refuse = (reason: QaCaptureRefusal): QaCaptureDecision => ({ switches: null, reason })
const isWav = (path: string): boolean => extname(path).toLowerCase() === '.wav'

/** Decide the Chromium switches for the file-fed capture source; pure apart from the injected fs lookups. */
export function qaCaptureSwitches({ qaIdentity, packaged, env, realpath, exists }: QaCaptureInput): QaCaptureDecision {
  if (!qaIdentity) return refuse('shipping-identity')
  if (!packaged) return refuse('unpackaged')
  const profile = env.ASKTOTO_USERDATA?.trim()
  if (!profile) return refuse('no-profile')
  const file = env[QA_CAPTURE_ENV]?.trim()
  if (!file) return refuse('no-capture-file')
  if (!isAbsolute(file) || !isAbsolute(profile)) return refuse('relative-path')
  if (!isWav(file)) return refuse('not-wav')
  if (!exists(file)) return refuse('missing-file')
  let realFile: string
  let realProfile: string
  try {
    realFile = realpath(file)
    realProfile = realpath(profile)
  } catch {
    return refuse('missing-file')
  }
  // Checked on the resolved paths so neither '..' segments nor a symlink can reach outside the profile.
  const inside = relative(realProfile, realFile)
  if (!inside || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) {
    return refuse('outside-profile')
  }
  if (!isWav(realFile)) return refuse('not-wav')
  // Chromium gets the resolved path, so a later swap of the requested link cannot redirect it.
  return {
    switches: [['use-fake-device-for-media-stream'], ['use-file-for-fake-audio-capture', realFile]],
    reason: null
  }
}

/** The slice of Electron's app this hook uses; nothing else is reachable from here. */
export interface QaCaptureHost {
  readonly isPackaged: boolean
  readonly commandLine: { appendSwitch(name: string, value?: string): void }
  whenReady(): Promise<unknown>
}

export type QaCaptureAudit = (event: Extract<AuditEvent, 'qa.capture.file_source'>, detail: { active: true }) => void

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Must run before app ready: appends the switches when the decision allows, then records one content-free
 * audit event once the app is ready. Returns the decision so callers and tests can read the reason code.
 */
export function installQaCaptureSource(
  host: QaCaptureHost,
  audit: QaCaptureAudit,
  {
    qaIdentity = QA_IDENTITY_BUILD,
    env = process.env,
    realpath = realpathSync,
    exists = isRegularFile
  }: Partial<Omit<QaCaptureInput, 'packaged'>> = {}
): QaCaptureDecision {
  const decision = qaCaptureSwitches({ qaIdentity, packaged: host.isPackaged, env, realpath, exists })
  if (!decision.switches) return decision
  for (const [name, value] of decision.switches) {
    if (value === undefined) host.commandLine.appendSwitch(name)
    else host.commandLine.appendSwitch(name, value)
  }
  void host.whenReady().then(() => audit('qa.capture.file_source', { active: true }))
  return decision
}
