/**
 * Voice actions runtime (V02): the wiring between the voice session and the rest of main.
 *
 * index.ts builds one of these and calls five hooks (refresh, onHardStop, onMeetingReserved, onSpeechFinished,
 * onRendererReset) plus registerIpc and bindWebContents. Everything stays here so index.ts grows by a handful of
 * lines. This module never opens a microphone: it only mints main's own hardware activation and tells the
 * renderer which turn to capture; the renderer then goes through the ordinary lease path with its own purpose.
 */
import { randomUUID } from 'node:crypto'
import type { ClarifyDropReason } from './clarify-protocol'
import type { CommandMicAvailabilityResult, CommandSpeechResult } from '@shared/command-speech'
import { assertCloudOnlyAllowsEngine, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import type { InputSessionLease, InputSessionStopReason } from '@shared/input-session'
import {
  resolveVoiceActionsChord,
  resolveVoiceActionsEnabled,
  voiceChordMask,
  type VoiceActionsSettings
} from '@shared/voice-actions-settings'
import {
  VOICE_ACTIONS_IPC,
  VoiceRecorderSchema,
  VoiceReportSchema,
  type VoiceStateSnapshot
} from '@shared/voice/voice-turn'
import type { CommandMicActivationAuthority, CommandMicActivationFrame } from '../command-mic-activation-authority'
import { createDictationRuntime, type DictationHostPorts } from '../features/dictation'
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
  turns?: {
    handle(text: string, claim: VoiceTurnClaim): void
    /** G35: the pending clarifying question is gone (Stop, sign-out, owner switch, a meeting, a renderer reset). */
    dropClarification?(reason: ClarifyDropReason): void
  }
  /**
   * Dictation (G22) shares this runtime's hooks. `ports` is where the operating system binds the focused field and
   * inserts text (G23 on macOS, G24 on Windows). Absent in production until then: a dictation hold is refused as
   * unsupported before the microphone opens.
   */
  dictation?: { ports?: DictationHostPorts; chord?: VoiceChordWiring }
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
  /** The Settings chord recorder opened or closed (validated here). While open, a hold opens no turn. */
  setChordRecorderActive(raw: unknown): { ok: boolean }
  dispose(): void
}

/** Which input-session stops end a pending clarification. A plain end of the hold (`user-stop`) does not: that is how an answer turn finishes. */
const CLARIFY_DROPPING_STOPS: Partial<Record<InputSessionStopReason, ClarifyDropReason>> = {
  'sign-out': 'sign_out',
  'auth-revoked': 'sign_out',
  'owner-replaced': 'owner_switch',
  'window-hidden': 'revoked',
  'system-suspend': 'revoked',
  'screen-locked': 'revoked',
  shutdown: 'revoked',
  'renderer-reset': 'revoked'
}

const PRESENCE_RECHECK_MS = 30_000
/** A recorder the renderer never closed (a crash) stops pausing the hold after this long. */
const RECORDER_MAX_MS = 120_000

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
  // The Settings chord recorder is open until this time. A timestamp, not a timer: nothing to leak or clear.
  let recorderOpenUntil = 0
  const effectiveEnabled = (): boolean => resolveVoiceActionsEnabled(voice(), { qaIdentity: deps.qaIdentity })
  // One effective setting feeds both the session and the watcher: no second default, no second chord vocabulary.
  const chord =
    deps.chord ??
    createVoiceChordWiring({
      enabled: effectiveEnabled,
      requireAuth: deps.requireAuth,
      meetingReserved: () => deps.authority.hasMeetingReservation,
      onboardingExclusive: deps.onboardingActive,
      chordRecorderActive: () => Date.now() < recorderOpenUntil,
      platform,
      chordMask: () => voiceChordMask(resolveVoiceActionsChord(voice(), platform)),
      latchEnabled: () => voice()?.doublePressLatch === true,
      qaFifoSource: true,
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
        // A dictation turn counts from its first moment, before its lease exists: two chords never race for one
        // microphone.
        return (lease !== null && lease.activation === 'explicit' && !isVoiceLease(lease)) || dictation.active()
      },
      availability: () => deps.availability()
    },
    activation: {
      mint: () => {
        const frame = deps.mainFrame()
        return frame !== null && deps.activation.mintFromHardware(frame)
      },
      revoke: () => deps.activation.revokeHardware('hardware')
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
  const dictation = createDictationRuntime({
    platform,
    qaIdentity: deps.qaIdentity,
    getSettings: deps.getSettings,
    requireAuth: deps.requireAuth,
    authority: deps.authority,
    activation: {
      mint: () => {
        const frame = deps.mainFrame()
        return frame !== null && deps.activation.mintFromHardware(frame, 'hardware-dictation')
      },
      revoke: () => deps.activation.revokeHardware('hardware-dictation')
    },
    window: deps.window,
    onboardingActive: deps.onboardingActive,
    availability: deps.availability,
    parakeet: deps.parakeet,
    voiceChordMask: () => voiceChordMask(resolveVoiceActionsChord(voice(), platform)),
    voiceTurnBusy: () => {
      const state = session.snapshot().state
      return state === 'listening' || state === 'thinking'
    },
    chordRecorderActive: () => Date.now() < recorderOpenUntil,
    chord: deps.dictation?.chord,
    ports: deps.dictation?.ports,
    newTurnId: deps.newTurnId
  })
  let presenceCheckedAt = Number.NEGATIVE_INFINITY
  // A renderer that went away cannot have its recorder open any more.
  const onRendererReset = (): void => {
    recorderOpenUntil = 0
    deps.turns?.dropClarification?.('revoked')
    session.onRendererReset()
    dictation.onRendererReset()
  }
  return {
    start() {
      chord.start()
      session.refresh()
      dictation.start()
    },
    refresh() {
      // Settings polls call this often; the model-presence probe touches the disk, so it runs at most every 30 s.
      if (Date.now() - presenceCheckedAt >= PRESENCE_RECHECK_MS) {
        presenceCheckedAt = Date.now()
        void deps.parakeet.refreshPresence()
      }
      session.refresh()
      dictation.refresh()
    },
    snapshot: () => session.snapshot(),
    onSignedIn() {
      chord.onSignedIn()
      dictation.onSignedIn()
    },
    onChordEvent: (event) => session.onChordEvent(event),
    onHardStop(reason) {
      const dropped = CLARIFY_DROPPING_STOPS[reason]
      if (dropped) deps.turns?.dropClarification?.(dropped)
      chord.onInputSessionStop(reason)
      session.onHardStop(reason)
      dictation.onHardStop(reason)
    },
    onMeetingReserved() {
      deps.turns?.dropClarification?.('meeting')
      session.onMeetingReserved()
      dictation.onMeetingReserved()
    },
    onSpeechFinished(sessionId, result) {
      const lease = deps.authority.activeLease
      if (isVoiceLease(lease) && lease.sessionId === sessionId) session.onSpeechFinished(result)
      else dictation.onSpeechFinished(sessionId, result)
    },
    onTranscript(text) {
      // A dictation lease's text belongs to dictation: never the voice pipeline, never the command panel.
      if (!isVoiceLease(deps.authority.activeLease)) return dictation.onTranscript(text)
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
    onRendererReset,
    bindWebContents(contents) {
      const reset = onRendererReset
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
      if (!dictation.report(parsed.data)) session.report(parsed.data)
      return { ok: true }
    },
    setChordRecorderActive(raw) {
      const parsed = VoiceRecorderSchema.safeParse(raw)
      if (!parsed.success) return { ok: false }
      recorderOpenUntil = parsed.data.active ? Date.now() + RECORDER_MAX_MS : 0
      return { ok: true }
    },
    dispose() {
      chord.stop()
      session.dispose()
      dictation.dispose()
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
