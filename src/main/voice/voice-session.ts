/**
 * VoiceSession (V02): main's owner of one hold-to-talk voice turn.
 *
 * The session turns recognizer verdicts from the global hold watcher into a turn: it refuses without opening
 * anything when voice actions must not run (meeting recording, signed out, onboarding, no speech, a panel
 * capture), mints a hardware activation in main (never from a renderer message), tells the renderer to open
 * the microphone for that turn, seals it on release, and ends it on any owner-session revocation. The renderer
 * only renders the state and opens the microphone through the ordinary lease path with its own purpose
 * (`push-to-talk` + `command`); the meeting pipeline is never touched.
 *
 * Invariants:
 * - One turn, one activation: the activation is minted once at `armed` and revoked when the turn ends.
 * - Refusals open no microphone, mint nothing and start no lease.
 * - Every revocation (sign-out, lock, suspend, quit, renderer reset, a meeting starting, disabling the
 *   feature) ends the turn synchronously, whether or not a lease exists yet.
 * - Nothing here sees audio or text. State carries ids, machine reasons and fixed copy only.
 * - No arrow functions in class property initializers (bytecode build); timers are plain fields.
 */
import type { CommandSpeechResult } from '@shared/command-speech'
import type { InputSessionStopReason } from '@shared/input-session'
import {
  VOICE_TURN_MAX_MS,
  voiceReasonCopy,
  type VoiceBegin,
  type VoiceEnd,
  type VoiceReason,
  type VoiceReport,
  type VoiceShortcut,
  type VoiceState,
  type VoiceStateSnapshot
} from '@shared/voice/voice-turn'
import type { VoiceChordEvent, VoiceChordWatcher, VoiceChordWatcherFactory } from './chord-watcher-port'

export type VoiceAvailability =
  | { ok: true }
  | { ok: false; reason: 'policy_blocked' | 'unsupported_engine' | 'unauthorized' }
export type VoiceAuditPhase = 'started' | 'refused' | 'cancelled' | 'finished'

export interface VoiceSessionDeps {
  /** The effective settings: enabled already resolves the build default and managed policy. */
  settings(): { enabled: boolean; chord: Parameters<VoiceChordWatcherFactory>[0] }
  /** V01's watcher. Absent when this platform or build has no hold watcher. */
  createWatcher?: VoiceChordWatcherFactory
  gate: {
    signedIn(): boolean
    meetingReserved(): boolean
    onboardingActive(): boolean
    windowVisible(): boolean
    /** An explicit lease that is not a voice turn (the Cmd+Shift+M panel) holds the microphone. */
    explicitLeaseActive(): boolean
    availability(): VoiceAvailability
  }
  activation: {
    /** Mint the hardware activation from main's own window frame. False when main cannot. */
    mint(): boolean
    revoke(): void
  }
  /** Hard-stop the voice turn's lease (a push-to-talk command lease), zeroing any PCM it owns. */
  stopVoiceLease(reason: 'cancelled' | 'renderer-reset'): void
  speech: { prewarm(): Promise<void>; releaseIdle(): Promise<void> }
  /** True while a meeting, a live session or an import is using the speech helper. */
  speechBusyElsewhere(): boolean
  push: {
    begin(payload: VoiceBegin): void
    end(payload: VoiceEnd): void
    state(snapshot: VoiceStateSnapshot): void
  }
  newTurnId(): string
  audit?(phase: VoiceAuditPhase, detail?: { reason?: string }): void
}

type Phase = 'listening' | 'thinking'
interface Turn {
  readonly id: string
  phase: Phase
  capturing: boolean
}

const START_WATCHDOG_MS = 5_000
const FLASH_MS = 4_000
const IDLE_RELEASE_MS = 10 * 60_000

/** Hard-stop reasons that end a turn, with what the user is told. `null` is silent. */
function reasonForHardStop(reason: InputSessionStopReason): VoiceReason | null {
  switch (reason) {
    case 'screen-locked':
      return 'screen_locked'
    case 'system-suspend':
      return 'system_suspend'
    case 'sign-out':
    case 'auth-revoked':
      return 'session_ended'
    case 'window-hidden':
      return 'window_hidden'
    case 'renderer-reset':
    case 'owner-replaced': // main's own handler for a main-frame navigation
      return 'renderer_reset'
    case 'shutdown':
      return null
    case 'cancelled':
      return 'timeout'
    default:
      return null
  }
}

export class VoiceSession {
  #watcher: VoiceChordWatcher | null = null
  #unsubscribe: (() => void) | null = null
  #chordKey = ''
  #enabled = false
  #turn: Turn | null = null
  #stopping = false
  #state: VoiceState = 'off'
  #reason: VoiceReason | null = null
  #turnIdShown: string | null = null
  #revision = 0
  #snapshot: VoiceStateSnapshot
  #capTimer: ReturnType<typeof setTimeout> | null = null
  #watchdog: ReturnType<typeof setTimeout> | null = null
  #flashTimer: ReturnType<typeof setTimeout> | null = null
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false

  constructor(private readonly deps: VoiceSessionDeps) {
    this.#snapshot = this.#build()
  }

  snapshot(): VoiceStateSnapshot {
    return this.#snapshot
  }

  /** Apply the current effective settings: start, restart or stop the watcher. Idempotent and synchronous. */
  refresh(): void {
    if (this.#disposed) return
    const { enabled, chord } = this.deps.settings()
    this.#enabled = enabled
    if (!enabled) {
      this.#cancelTurn(null, 'disabled')
      this.#stopWatcher()
      this.#clearFlash()
      this.#clearIdle()
      this.#set('off', null)
      return
    }
    const key = chord.join('+')
    if (this.#watcher && key !== this.#chordKey) this.#stopWatcher()
    if (!this.#watcher && this.deps.createWatcher && chord.length > 0) {
      const watcher = this.deps.createWatcher(chord)
      this.#chordKey = key
      this.#unsubscribe = watcher.onEvent((event) => this.#onChord(event))
      this.#watcher = watcher
      watcher.start()
    }
    if (this.#state === 'off') this.#set('idle', null)
    else this.#publish()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#cancelTurn(null, 'disabled')
    this.#stopWatcher()
    this.#clearFlash()
    this.#clearIdle()
    this.#disposed = true
  }

  /** The speech capture finished for the voice lease. The wiring filters out non-voice captures. */
  onSpeechFinished(result: CommandSpeechResult): void {
    const turn = this.#turn
    if (!turn || turn.phase !== 'thinking') return
    if (result.ok) {
      this.#audit('finished')
      this.#endTurn()
      this.#set('idle', null)
      return
    }
    const reason = ((): VoiceReason | null => {
      switch (result.reason) {
        case 'no_speech':
        case 'invalid':
          return 'no_speech'
        case 'recognition_unavailable':
          return 'recognition_unavailable'
        case 'policy_blocked':
          return 'policy_blocked'
        case 'unsupported_engine':
          return 'speech_unavailable'
        default:
          return null
      }
    })()
    this.#audit(reason ? 'finished' : 'cancelled', reason ? { reason } : undefined)
    this.#endTurn()
    if (reason) this.#flash(reason)
    else this.#set('idle', null)
  }

  /** The renderer's report. It can only move the current turn toward failure; a stale turn id is ignored. */
  report(report: VoiceReport): void {
    const turn = this.#turn
    if (!turn || turn.id !== report.turnId) return
    if (report.phase === 'capturing') {
      turn.capturing = true
      this.#clearWatchdog()
      return
    }
    this.#cancelTurn(report.reason, 'report')
  }

  /** The authority hard-stopped (sign-out, lock, suspend, quit, renderer reset, window hidden, a lease timeout). */
  onHardStop(reason: InputSessionStopReason): void {
    if (this.#stopping || !this.#turn) return
    this.#cancelTurn(reasonForHardStop(reason), reason)
  }

  /** A meeting reservation was accepted. The authority already revoked any interactive lease. */
  onMeetingReserved(): void {
    if (this.#stopping || !this.#turn) return
    this.#cancelTurn('meeting_started', 'meeting')
  }

  /** The renderer crashed, was destroyed or navigated away. */
  onRendererReset(): void {
    if (!this.#turn) return
    this.#cancelTurn('renderer_reset', 'renderer-reset', 'renderer-reset')
  }

  #onChord(event: VoiceChordEvent): void {
    if (!this.#enabled || this.#disposed) return
    switch (event) {
      case 'armed':
      case 'latched':
        this.#begin()
        return
      case 'released':
      case 'latch-ended':
        this.#release()
        return
      case 'aborted':
        if (this.#turn?.phase === 'listening') this.#cancelTurn(null, 'aborted')
        return
    }
  }

  #refusal(): VoiceReason | null {
    const { gate } = this.deps
    if (!gate.signedIn()) return 'signed_out'
    if (gate.meetingReserved()) return 'meeting_recording'
    if (gate.onboardingActive()) return 'onboarding_active'
    const availability = gate.availability()
    if (!availability.ok)
      return availability.reason === 'policy_blocked'
        ? 'policy_blocked'
        : availability.reason === 'unauthorized'
          ? 'signed_out'
          : 'speech_unavailable'
    if (gate.explicitLeaseActive()) return 'panel_active'
    if (!gate.windowVisible()) return 'window_hidden'
    return null
  }

  #begin(): void {
    if (this.#turn?.phase === 'listening') return
    if (this.#turn) this.#cancelTurn(null, 'superseded')
    this.#clearFlash()
    this.#clearIdle()
    const refusal = this.#refusal()
    if (refusal) {
      this.#audit('refused', { reason: refusal })
      this.#flash(refusal)
      return
    }
    if (!this.deps.activation.mint()) {
      this.#audit('refused', { reason: 'not_ready' })
      this.#flash('not_ready')
      return
    }
    const turn: Turn = { id: this.deps.newTurnId(), phase: 'listening', capturing: false }
    this.#turn = turn
    this.#audit('started')
    this.#set('listening', null)
    this.deps.push.begin({ turnId: turn.id, maxMs: VOICE_TURN_MAX_MS })
    this.#capTimer = setTimeout(() => this.#release(), VOICE_TURN_MAX_MS)
    this.#watchdog = setTimeout(() => {
      if (this.#turn === turn && !turn.capturing) this.#cancelTurn('microphone_unavailable', 'no-capture')
    }, START_WATCHDOG_MS)
    void this.deps.speech.prewarm().catch(() => {
      /* recognition reports its own failure when the turn is sealed */
    })
  }

  #release(): void {
    const turn = this.#turn
    if (!turn || turn.phase !== 'listening') return
    turn.phase = 'thinking'
    this.#clearCap()
    this.#set('thinking', null)
    this.deps.push.end({ turnId: turn.id, cancelled: false })
  }

  /**
   * End the turn without recognition. `reason` null is silent (a cancel, quit or toggle). `stopReason` is what the
   * authority hears when a voice lease exists; our own hard stop is not re-entered.
   */
  #cancelTurn(reason: VoiceReason | null, why: string, stopReason: 'cancelled' | 'renderer-reset' = 'cancelled'): void {
    const turn = this.#turn
    if (!turn) return
    this.#audit('cancelled', { reason: reason ?? why })
    this.#stopping = true
    try {
      this.deps.stopVoiceLease(stopReason)
      this.deps.push.end({ turnId: turn.id, cancelled: true })
    } finally {
      this.#stopping = false
    }
    this.#endTurn()
    if (why === 'disabled') return
    if (reason) this.#flash(reason)
    else this.#set('idle', null)
  }

  #endTurn(): void {
    this.#turn = null
    this.#clearCap()
    this.#clearWatchdog()
    this.deps.activation.revoke()
    this.#armIdle()
  }

  #flash(reason: VoiceReason): void {
    this.#clearFlash()
    this.#set('failed', reason)
    this.#flashTimer = setTimeout(() => {
      this.#flashTimer = null
      if (this.#state === 'failed' && !this.#turn) this.#set('idle', null)
    }, FLASH_MS)
    this.#armIdle()
  }

  #armIdle(): void {
    this.#clearIdle()
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      if (this.#turn || this.#disposed) return
      if (this.deps.speechBusyElsewhere()) {
        this.#armIdle()
        return
      }
      void this.deps.speech.releaseIdle().catch(() => {
        /* the next turn restarts the helper */
      })
    }, IDLE_RELEASE_MS)
  }

  #stopWatcher(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#watcher?.stop()
    this.#watcher = null
    this.#chordKey = ''
  }

  #clearCap(): void {
    if (this.#capTimer) clearTimeout(this.#capTimer)
    this.#capTimer = null
  }
  #clearWatchdog(): void {
    if (this.#watchdog) clearTimeout(this.#watchdog)
    this.#watchdog = null
  }
  #clearFlash(): void {
    if (this.#flashTimer) clearTimeout(this.#flashTimer)
    this.#flashTimer = null
  }
  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
  }

  #audit(phase: VoiceAuditPhase, detail?: { reason?: string }): void {
    try {
      this.deps.audit?.(phase, detail)
    } catch {
      /* audit is best effort */
    }
  }

  #set(state: VoiceState, reason: VoiceReason | null): void {
    this.#state = state
    this.#reason = reason
    this.#turnIdShown = this.#turn?.id ?? null
    this.#publish()
  }

  #shortcut(): VoiceShortcut {
    if (!this.#enabled) return 'stopped'
    return this.#watcher ? 'running' : 'unavailable'
  }

  #build(): VoiceStateSnapshot {
    return {
      revision: this.#revision,
      state: this.#state,
      turnId: this.#turnIdShown,
      reason: this.#reason,
      message: this.#reason ? voiceReasonCopy(this.#reason) : null,
      enabled: this.#enabled,
      shortcut: this.#shortcut()
    }
  }

  #publish(): void {
    const next = { ...this.#build(), revision: this.#revision + 1 }
    const prev = this.#snapshot
    const same =
      prev.state === next.state &&
      prev.turnId === next.turnId &&
      prev.reason === next.reason &&
      prev.enabled === next.enabled &&
      prev.shortcut === next.shortcut
    if (same && this.#revision > 0) return
    this.#revision = next.revision
    this.#snapshot = next
    try {
      this.deps.push.state(next)
    } catch {
      /* the renderer may be gone; the next getState reads the snapshot */
    }
  }
}
