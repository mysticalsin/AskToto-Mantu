/**
 * chord-wiring.ts — connects the hold-chord watcher (chord-watcher.ts) to the real app (V01).
 *
 * index.ts hands over the four things only it knows (signed in, meeting reserved, onboarding exclusive, QA build)
 * and calls start / refresh / onSignedIn / onInputSessionStop / stop at the matching moments. Everything else is
 * defaulted here: the per-platform helper, the power events, accessibility, the audit sink.
 *
 * Preview rule (owner decision, NEEDS_TONY 2026-10-21 19:30): hardware-dependent features ship ON only after Tony's
 * physical checklist passes. `enabled()` carries that rule (VOICE_ACTIONS_RELEASE_DEFAULT_ON in
 * voice-actions-settings.ts is the one flag), so with no opt-in a release build spawns no helper and monitors no keys.
 *
 * No permission prompt is raised here or anywhere on this path. Path A of the design (a polling helper) needs none.
 * If the owner spike shows it does need Input Monitoring, that is requested only when the person turns the feature
 * on, through the G10 permission kinds, and not from this module.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app, powerMonitor } from 'electron'
import type { InputSessionStopReason } from '@shared/input-session'
import { CHORD_PLATFORM_DEFAULTS } from '@shared/voice/modifier-mask'
import { auditLog, mainLog } from '../logger'
import { macWatchModifiersSpawnSpec } from '../mac-helper'
import { QA_IDENTITY_BUILD } from '../qa-identity'
import { createQaChordFifoSource } from '../qa-voice-hooks'
import {
  spawnLineHelper,
  type LineHelperHandle,
  type LineHelperHandlers,
  type LineHelperSpec
} from '../infra/process/line-helper-host'
import {
  createChordWatcher,
  type ChordGateBlock,
  type ChordWatcherEvent,
  type ChordWatcherStatus
} from './chord-watcher'

const WIN_KEYWATCH_INTERVAL_MS = 40

/**
 * The Windows helper `metis-keywatch.exe` (native/win-keywatch) is BLOCKED: it is not written, built or shipped yet
 * (it needs a Windows build lane and a signing route, and cannot be run on this Mac). The spawn spec therefore
 * resolves to null today and the Windows watcher is inert. The moment a build ships the binary under
 * `<resources>/win-keywatch/`, this returns its spec and the same watcher runs, speaking the same
 * `m <mask> <seq>` protocol (src/shared/voice/modifier-mask.ts).
 */
export function winKeywatchSpawnSpec(input: {
  resourcesPath: string
  exists: (path: string) => boolean
  intervalMs?: number
}): LineHelperSpec | null {
  if (!input.resourcesPath) return null
  const command = join(input.resourcesPath, 'win-keywatch', 'metis-keywatch.exe')
  if (!input.exists(command)) return null
  return { command, args: ['--interval-ms', String(input.intervalMs ?? WIN_KEYWATCH_INTERVAL_MS)] }
}

type PowerEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume'

export interface VoiceChordWiringDeps {
  /**
   * The effective voice actions setting (QA default, release Preview default and the person's or the organization's
   * choice, resolved once in voice-actions-settings.ts). There is no second default here.
   */
  enabled(): boolean
  requireAuth(): boolean
  meetingReserved(): boolean
  onboardingExclusive(): boolean
  platform?: NodeJS.Platform
  chordRecorderActive?(): boolean
  /** The configured chord as a modifier mask. Defaults to the platform default. */
  chordMask?(): number
  /** The double-press latch option. Off unless the setting says so. */
  latchEnabled?(): boolean
  /** Watcher status changes (running, paused, restarting, failed, inert, stopped). */
  onStatus?(status: ChordWatcherStatus): void
  isAccessibilitySupportEnabled?(): boolean
  power?: { on(event: PowerEvent, callback: () => void): unknown }
  helperSpec?(): LineHelperSpec | null
  spawnHelper?(spec: LineHelperSpec, handlers: LineHelperHandlers): LineHelperHandle
  audit?(event: 'voice.chord', data: Record<string, unknown>): void
  log?(message: string): void
  /** The consumer of chord events (the voice turn, V02). */
  onChordEvent?(event: ChordWatcherEvent): void
  /**
   * Let the QA chord FIFO source (qa-voice-hooks.ts, V08) replace the helper as the line source. Only the voice hold sets
   * this: a second watcher on the same FIFO would split its lines. Honoured only by the QA-identity build.
   */
  qaFifoSource?: boolean
}

export interface VoiceChordWiring {
  /** Register the power events and reconcile once. Call after the app is ready. */
  start(): void
  refresh(): void
  onSignedIn(): void
  onInputSessionStop(reason: InputSessionStopReason): void
  stop(): void
  status(): ChordWatcherStatus
  suspendedReason(): 'assistive-technology' | null
}

export function createVoiceChordWiring(deps: VoiceChordWiringDeps): VoiceChordWiring {
  const platform = deps.platform ?? process.platform
  const defaultMask = platform === 'win32' ? CHORD_PLATFORM_DEFAULTS.win32 : CHORD_PLATFORM_DEFAULTS.darwin

  // QA-identity builds only: the guard is the compile-time literal, so shipping bytes drop the whole branch.
  const qaFifo =
    QA_IDENTITY_BUILD && deps.qaFifoSource === true
      ? createQaChordFifoSource({
          qaIdentity: QA_IDENTITY_BUILD,
          packaged: app.isPackaged,
          env: process.env,
          audit: (event, detail) => auditLog(event, detail)
        })
      : null

  const helperSpec = (): LineHelperSpec | null => {
    if (deps.helperSpec) return deps.helperSpec()
    if (qaFifo) return qaFifo.helperSpec()
    if (platform === 'darwin') return macWatchModifiersSpawnSpec()
    if (platform === 'win32') {
      return winKeywatchSpawnSpec({ resourcesPath: process.resourcesPath ?? '', exists: existsSync })
    }
    return null
  }

  const gate = (): ChordGateBlock | null => {
    if (deps.meetingReserved()) return 'meeting'
    if (deps.onboardingExclusive()) return 'onboarding'
    if (deps.chordRecorderActive?.()) return 'chord-recorder'
    return null
  }

  const watcher = createChordWatcher({
    helperSpec,
    spawnHelper:
      deps.spawnHelper ?? (qaFifo ? qaFifo.spawnHelper : (spec, handlers) => spawnLineHelper(spec, handlers)),
    enabled: deps.enabled,
    signedIn: deps.requireAuth,
    gate,
    chordMask: () => deps.chordMask?.() ?? defaultMask,
    latchEnabled: deps.latchEnabled,
    assistiveTechnologyActive: () =>
      (deps.isAccessibilitySupportEnabled ?? (() => app.isAccessibilitySupportEnabled()))(),
    now: () => performance.now(),
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    onEvent: (event) => deps.onChordEvent?.(event),
    onStatus: (status) => {
      ;(deps.log ?? ((message) => mainLog.info(message)))(`[voice-chord] ${status}`)
      deps.onStatus?.(status)
    },
    audit: deps.audit ?? ((event, data) => auditLog(event, data))
  })

  let started = false
  return {
    start() {
      if (!started) {
        started = true
        const power = deps.power ?? powerMonitor
        power.on('lock-screen', () => watcher.lifecycle('lock'))
        power.on('unlock-screen', () => watcher.lifecycle('unlock'))
        power.on('suspend', () => watcher.lifecycle('suspend'))
        power.on('resume', () => watcher.lifecycle('resume'))
      }
      watcher.refresh()
    },
    refresh: watcher.refresh,
    onSignedIn: () => watcher.lifecycle('sign-in'),
    onInputSessionStop(reason) {
      if (reason === 'sign-out' || reason === 'auth-revoked') watcher.lifecycle('sign-out')
      else if (reason === 'shutdown') watcher.lifecycle('quit')
    },
    stop: watcher.stop,
    status: watcher.status,
    suspendedReason: watcher.suspendedReason
  }
}
