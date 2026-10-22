/**
 * Voice actions runtime (V02): the wiring between the voice session and the rest of main.
 *
 * index.ts builds one of these and calls five hooks (refresh, onHardStop, onMeetingReserved, onSpeechFinished,
 * onRendererReset) plus registerIpc and bindWebContents. Everything stays here so index.ts grows by a handful of
 * lines. This module never opens a microphone: it only mints main's own hardware activation and tells the
 * renderer which turn to capture; the renderer then goes through the ordinary lease path with its own purpose.
 */
import { randomUUID } from 'node:crypto'
import type { CommandMicAvailabilityResult, CommandSpeechResult } from '@shared/command-speech'
import { assertCloudOnlyAllowsEngine, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import type { InputSessionLease, InputSessionStopReason } from '@shared/input-session'
import {
  resolveVoiceActionsChord,
  resolveVoiceActionsEnabled,
  voiceChordMask,
  type VoiceActionsSettings
} from '@shared/voice-actions-settings'
import { VOICE_ACTIONS_IPC, VoiceReportSchema, type VoiceStateSnapshot } from '@shared/voice/voice-turn'
import type { CommandMicActivationAuthority, CommandMicActivationFrame } from '../command-mic-activation-authority'
import type { InputSessionAuthority } from '../input-session-authority'
import { auditLog } from '../logger'
import type { ChordWatcherEvent } from './chord-watcher'
import { createVoiceChordWiring, type VoiceChordWiring } from './chord-wiring'
import { commandSpeechAvailability, createParakeetPresence } from './voice-availability'
import { VoiceSession, type VoiceAuditPhase, type VoiceTurnClaim } from './voice-session'

interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

interface RendererContentsLike {
  on(event: string, listener: (...args: any[]) => void): unknown
}

export interface VoiceActionsRuntimeDeps {
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform
  /** The QA-identity build: voice actions are ON by default there and OFF (Preview) in release builds. */
  qaIdentity: boolean
  /** The stored settings; `voiceActions` has the managed policy already overlaid by the store. */
  getSettings(): { voiceActions?: VoiceActionsSettings }
  requireAuth(): boolean
  authority: Pick<InputSessionAuthority, 'activeLease' | 'hasMeetingReservation' | 'hardStop'>
  activation: Pick<CommandMicActivationAuthority, 'mintFromHardware' | 'revokeHardware'>
  /** Main's own main-window frame; never a renderer-supplied value. */
  mainFrame(): CommandMicActivationFrame | null
  window(): WindowLike | null | undefined
  onboardingActive(): boolean
  /** The same availability the activation authority and IPC handlers use (engine-decoupled). */
  availability(): CommandMicAvailabilityResult
  parakeet: { refreshPresence(): Promise<boolean>; ensure(): Promise<void>; release(): Promise<void> }
  /** A live session or an import is using the speech helper (a meeting reservation is checked here too). */
  speechBusy(): boolean
  /** The hold-chord wiring (V01). Defaults to the real one; tests and the QA FIFO source (V08) may replace it. */
  chord?: VoiceChordWiring
  /**
   * What to do with a recognized voice turn (V03): route it to an action, a confirmation or the Ask path. Absent
   * only in tests that do not exercise actions; the recognized text is then dropped, never given to anything else.
   */
  turns?: { handle(text: string, claim: VoiceTurnClaim): void }
  /** Defaults to the `voice.turn` audit event (phase and machine reason only). */
  audit?(phase: VoiceAuditPhase, detail?: { reason?: string }): void
  newTurnId?(): string
}

export interface VoiceActionsRuntime {
  /** Boot: register the power events and bring the watcher and the session in line with the setting. */
  start(): void
  /** Settings changed (or a poll): re-read the effective setting and re-aim the watcher. Idempotent. */
  refresh(): void
  /** The person signed in: a signed-out watcher may start. */
  onSignedIn(): void
  /** A verdict from the hold watcher (also the entry point a test or the QA FIFO source drives). */
  onChordEvent(event: ChordWatcherEvent): void
  snapshot(): VoiceStateSnapshot
  onHardStop(reason: InputSessionStopReason): void
  onMeetingReserved(): void
  onSpeechFinished(sessionId: string, result: CommandSpeechResult): void
  /**
   * Recognized text from the command capture. True means a voice turn owns it (it was handed to the action pipeline,
   * or dropped because it could not be claimed) and the legacy command panel must not see it. False means it is not
   * a voice turn's text and the caller keeps its own path.
   */
  onTranscript(text: string): boolean
  onRendererReset(): void
  bindWebContents(contents: RendererContentsLike): void
  /** A renderer report (validated here). Applies only to the current turn and only toward failure. */
  report(raw: unknown): { ok: boolean }
  dispose(): void
}

const PRESENCE_RECHECK_MS = 30_000

/** The lease only a voice turn can hold: a hardware-activated push-to-talk command capture. */
const isVoiceLease = (lease: InputSessionLease | null): lease is InputSessionLease =>
  lease !== null && lease.source === 'push-to-talk' && lease.purpose === 'command'

export function createVoiceActionsRuntime(deps: VoiceActionsRuntimeDeps): VoiceActionsRuntime {
  const send = (channel: string, payload: unknown): void => {
    const win = deps.window()
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* the renderer may be gone; getState recovers the snapshot */
    }
  }
  const voice = (): VoiceActionsSettings | undefined => deps.getSettings().voiceActions
  const platform = deps.platform ?? process.platform
  const effectiveEnabled = (): boolean => resolveVoiceActionsEnabled(voice(), { qaIdentity: deps.qaIdentity })
  // One effective setting feeds both the session and the watcher: no second default, no second chord vocabulary.
  const chord =
    deps.chord ??
    createVoiceChordWiring({
      enabled: effectiveEnabled,
      requireAuth: deps.requireAuth,
      meetingReserved: () => deps.authority.hasMeetingReservation,
      onboardingExclusive: deps.onboardingActive,
      platform,
      chordMask: () => voiceChordMask(resolveVoiceActionsChord(voice(), platform)),
      latchEnabled: () => voice()?.doublePressLatch === true,
      onChordEvent: (event) => session.onChordEvent(event),
      onStatus: () => session.onChordStatus()
    })
  const session: VoiceSession = new VoiceSession({
    settings: () => ({ enabled: effectiveEnabled() }),
    chord,
    gate: {
      signedIn: () => deps.requireAuth(),
      meetingReserved: () => deps.authority.hasMeetingReservation,
      onboardingActive: () => deps.onboardingActive(),
      windowVisible: () => {
        const win = deps.window()
        return Boolean(win && !win.isDestroyed() && win.isVisible())
      },
      explicitLeaseActive: () => {
        const lease = deps.authority.activeLease
        return lease !== null && lease.activation === 'explicit' && !isVoiceLease(lease)
      },
      availability: () => deps.availability()
    },
    activation: {
      mint: () => {
        const frame = deps.mainFrame()
        return frame !== null && deps.activation.mintFromHardware(frame)
      },
      revoke: () => deps.activation.revokeHardware()
    },
    stopVoiceLease: (reason) => {
      if (isVoiceLease(deps.authority.activeLease)) deps.authority.hardStop(reason)
    },
    speech: { prewarm: () => deps.parakeet.ensure(), releaseIdle: () => deps.parakeet.release() },
    speechBusyElsewhere: () => deps.authority.hasMeetingReservation || deps.speechBusy(),
    push: {
      begin: (payload) => send(VOICE_ACTIONS_IPC.begin, payload),
      end: (payload) => send(VOICE_ACTIONS_IPC.end, payload),
      state: (snapshot) => send(VOICE_ACTIONS_IPC.state, snapshot)
    },
    newTurnId: deps.newTurnId ?? randomUUID,
    audit: deps.audit ?? ((phase, detail) => auditLog('voice.turn', { phase, ...detail }))
  })
  let presenceCheckedAt = Number.NEGATIVE_INFINITY
  return {
    start() {
      chord.start()
      session.refresh()
    },
    refresh() {
      // Settings polls call this often; the model-presence probe touches the disk, so it runs at most every 30 s.
      if (Date.now() - presenceCheckedAt >= PRESENCE_RECHECK_MS) {
        presenceCheckedAt = Date.now()
        void deps.parakeet.refreshPresence()
      }
      session.refresh()
    },
    snapshot: () => session.snapshot(),
    onSignedIn: () => chord.onSignedIn(),
    onChordEvent: (event) => session.onChordEvent(event),
    onHardStop(reason) {
      chord.onInputSessionStop(reason)
      session.onHardStop(reason)
    },
    onMeetingReserved: () => session.onMeetingReserved(),
    onSpeechFinished(sessionId, result) {
      const lease = deps.authority.activeLease
      if (isVoiceLease(lease) && lease.sessionId === sessionId) session.onSpeechFinished(result)
    },
    onTranscript(text) {
      if (!isVoiceLease(deps.authority.activeLease)) return false
      const claim = session.claimTurn()
      if (claim) {
        try {
          deps.turns?.handle(text, claim)
        } catch {
          /* the pipeline reports its own failures; a throw must not reach the capture */
        }
      }
      return true
    },
    onRendererReset: () => session.onRendererReset(),
    bindWebContents(contents) {
      const reset = (): void => session.onRendererReset()
      contents.on('render-process-gone', reset)
      contents.on('destroyed', reset)
      contents.on(
        'did-start-navigation',
        (_event: unknown, _url: unknown, isInPlace: unknown, isMainFrame: unknown) => {
          if (isMainFrame === true && isInPlace === false) reset()
        }
      )
    },
    report(raw) {
      const parsed = VoiceReportSchema.safeParse(raw)
      if (!parsed.success) return { ok: false }
      session.report(parsed.data)
      return { ok: true }
    },
    dispose() {
      chord.stop()
      session.dispose()
    }
  }
}

/**
 * The command-speech availability main uses everywhere (activation authority, IPC handlers, voice session),
 * engine-decoupled: a non-Parakeet meeting engine no longer disables voice actions when the model is present.
 */
export function createCommandMicAvailability(deps: {
  requireAuth(): boolean
  getSettings(): { enterpriseLive?: Parameters<typeof resolveEnterpriseLiveProfile>[0]; asrEngine: string }
  modelReady(): Promise<boolean>
}): { availability(): CommandMicAvailabilityResult; refreshPresence(): Promise<boolean> } {
  const presence = createParakeetPresence(deps.modelReady)
  return {
    refreshPresence: presence.refresh,
    availability() {
      const settings = deps.getSettings()
      return commandSpeechAvailability({
        authenticated: deps.requireAuth(),
        localSpeechAllowed: assertCloudOnlyAllowsEngine(
          resolveEnterpriseLiveProfile(settings.enterpriseLive ?? {}),
          'parakeet'
        ).ok,
        asrEngine: settings.asrEngine,
        parakeetPresent: presence.get()
      })
    }
  }
}
