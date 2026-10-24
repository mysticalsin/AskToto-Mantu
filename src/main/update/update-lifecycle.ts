import { basename } from 'node:path'
import type { UpdateBusyReason, UpdateLifecycleState } from '@shared/update-lifecycle'
import { isNewerVersion } from './version-compare'

/** Events the update state machine accepts. */
export type UpdateEvent =
  | { type: 'check' }
  | { type: 'available'; version: string; busy: readonly UpdateBusyReason[] }
  | { type: 'download-start' }
  | { type: 'downloaded'; version: string }
  | { type: 'verified'; ok: boolean }
  | { type: 'install'; busy: readonly UpdateBusyReason[] }
  | { type: 'idle' }
  | { type: 'error' }
  | {
      type: 'boot'
      outcome: 'install-failed' | 'post-verify' | 'unknown-version'
      fromVersion: string
      toVersion: string
    }
  | { type: 'helpers'; ok: boolean; helpers: UpdateLifecycleState['helpers']; rollbackUrl?: string }

const CHECKABLE = new Set(['idle', 'current', 'error', 'verify-failed', 'install-failed', 'unknown-version'])
const OFFERABLE = new Set(['idle', 'checking', 'current', 'error', 'available', 'available-deferred', 'verify-failed'])
const DOWNLOADABLE = new Set([
  'idle',
  'checking',
  'available',
  'available-deferred',
  'error',
  'verify-failed',
  'current'
])
const NOT_STAGEABLE = new Set(['installing', 'install-deferred', 'ready', 'verifying'])

const withVersion = (state: UpdateLifecycleState): { version?: string } =>
  state.version ? { version: state.version } : {}

/** Pure. An event that does not apply in the current phase returns the state unchanged and never throws. */
export function transition(state: UpdateLifecycleState, event: UpdateEvent): UpdateLifecycleState {
  const { phase } = state
  switch (event.type) {
    case 'check':
      return CHECKABLE.has(phase) ? { phase: 'checking' } : state
    case 'available':
      if (!OFFERABLE.has(phase)) return state
      return event.busy.length > 0
        ? { phase: 'available-deferred', version: event.version, deferred: [...event.busy] }
        : { phase: 'available', version: event.version }
    case 'download-start':
      return DOWNLOADABLE.has(phase) ? { phase: 'downloading', ...withVersion(state) } : state
    case 'downloaded':
      return NOT_STAGEABLE.has(phase) ? state : { phase: 'verifying', version: event.version }
    case 'verified':
      if (phase !== 'verifying') return state
      return { phase: event.ok ? 'ready' : 'verify-failed', ...withVersion(state) }
    case 'install':
      if (phase !== 'ready' && phase !== 'install-deferred') return state
      return event.busy.length > 0
        ? { phase: 'install-deferred', ...withVersion(state), deferred: [...event.busy] }
        : { phase: 'installing', ...withVersion(state) }
    case 'idle':
      if (phase === 'install-deferred') return { phase: 'ready', ...withVersion(state) }
      if (phase === 'available-deferred') return { phase: 'available', ...withVersion(state) }
      return state
    case 'error':
      return phase === 'checking' || phase === 'downloading' || phase === 'verifying' ? { phase: 'error' } : state
    case 'boot':
      if (phase !== 'idle') return state
      return { phase: event.outcome, fromVersion: event.fromVersion, version: event.toVersion }
    case 'helpers': {
      if (phase !== 'post-verify') return state
      const base = {
        ...(state.fromVersion ? { fromVersion: state.fromVersion } : {}),
        ...withVersion(state),
        ...(event.helpers ? { helpers: event.helpers } : {})
      }
      return event.ok
        ? { phase: 'current', ...base }
        : { phase: 'helpers-quarantined', ...base, ...(event.rollbackUrl ? { rollbackUrl: event.rollbackUrl } : {}) }
    }
  }
}

/** The shape electron-updater hands to 'update-downloaded' that staged verification reads. */
export interface StagedDownloadInfo {
  version?: string
  downloadedFile?: string
  files?: ReadonlyArray<{ url?: unknown; sha512?: unknown; size?: unknown }>
}

export interface StagedVerifyDeps {
  currentVersion: string
  /** The version the feed offered at check time, when known. */
  offeredVersion?: string
  fileSize(path: string): Promise<number | null>
  sha512Base64(path: string): Promise<string>
}

export type StagedVerdict =
  | { ok: true }
  | { ok: false; reason: 'no-file' | 'no-match' | 'hash-mismatch' | 'size-mismatch' | 'not-newer' | 'version-mismatch' }

function entryName(url: unknown): string {
  const raw = typeof url === 'string' ? url : url instanceof URL ? url.pathname : ''
  const path = raw.split('?')[0] ?? ''
  try {
    return basename(decodeURIComponent(path))
  } catch {
    return basename(path)
  }
}

/** Fail closed: the staged file is trusted only when its hash matches the feed entry for the same file name. */
export async function verifyStagedDownload(info: StagedDownloadInfo, deps: StagedVerifyDeps): Promise<StagedVerdict> {
  const version = typeof info.version === 'string' ? info.version : ''
  if (!version || !isNewerVersion(version, deps.currentVersion)) return { ok: false, reason: 'not-newer' }
  if (deps.offeredVersion && deps.offeredVersion !== version) return { ok: false, reason: 'version-mismatch' }
  const file = info.downloadedFile
  const size = file ? await deps.fileSize(file) : null
  if (!file || size === null) return { ok: false, reason: 'no-file' }
  const name = basename(file)
  const entry = (info.files ?? []).find((f) => entryName(f.url) === name)
  if (!entry || typeof entry.sha512 !== 'string' || entry.sha512 === '') return { ok: false, reason: 'no-match' }
  if (typeof entry.size === 'number' && entry.size !== size) return { ok: false, reason: 'size-mismatch' }
  let actual: string
  try {
    actual = await deps.sha512Base64(file)
  } catch {
    return { ok: false, reason: 'no-file' }
  }
  return actual === entry.sha512 ? { ok: true } : { ok: false, reason: 'hash-mismatch' }
}

export interface InstallReceipt {
  schema: 1
  fromVersion: string
  toVersion: string
  at: number
}

/** What the first boot after an install tells us. */
export function reconcileBootReceipt(
  receipt: InstallReceipt | null,
  currentVersion: string
): 'none' | 'install-failed' | 'post-verify' | 'unknown-version' {
  if (!receipt) return 'none'
  if (currentVersion === receipt.fromVersion) return 'install-failed'
  if (currentVersion === receipt.toVersion) return 'post-verify'
  return 'unknown-version'
}
