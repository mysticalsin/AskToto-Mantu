/**
 * DictationSession (G22): main's owner of one dictation turn, from the held dictation chord to a typed insertion
 * request. It is a sibling of the voice turn (V02), not a variant of it: a dictation produces text for the field
 * that had focus when it began, so its own purpose (`dictation`), its own lease and activation kind, and a target
 * bound at the start through the G07 target guard.
 *
 * What it does, in order:
 *  1. A chord verdict (`armed` for a hold, `latched` for a double tap) is gated: signed in, no meeting recording,
 *     onboarding done, speech available, no other capture, window visible. A refusal opens nothing.
 *  2. The focused field is observed through the target port and bound by the guard (editable, not secure, fresh). If
 *     no target can be bound the microphone is never opened: Métis does not record what it cannot place.
 *  3. Main mints its own hardware activation and tells the renderer to capture with the `dictation` purpose. The
 *     renderer goes through the ordinary lease path; the meeting pipeline is never touched.
 *  4. On release the capture is sealed. The recognized text becomes the guard's draft, the target is observed again
 *     twice (prepare, then dispatch) and, only if it is the same field, handed to the insertion port. The port is
 *     unsupported in production until G23, so today the draft is kept and the person is told.
 *
 * Invariants:
 * - Stop is idempotent: a double stop, a stop during start (nothing opened, nothing bound) and a stop after a
 *   revocation are all no-ops. One turn, one capture, one insertion attempt, never a retry.
 * - Every revocation ends the turn synchronously and revokes the guard's context, so nothing recognized earlier
 *   inserts later. A draft is never dropped: the guard keeps it for the person (`priorDrafts`).
 * - Nothing here logs, audits or snapshots text. State carries ids, machine reasons and fixed enums only. The one
 *   place the text goes is the encrypted segment journal (G26), through the typed `memory` sink, and only so an
 *   interruption does not lose it.
 * - No arrow functions in class property initializers (bytecode build); timers are plain fields.
 */
import type { CommandSpeechResult } from '@shared/command-speech'
import type { InputSessionStopReason } from '@shared/input-session'
import type { VoiceBegin, VoiceReport } from '@shared/voice/voice-turn'
import { VOICE_TURN_MAX_MS } from '@shared/voice/voice-turn'
import type { ChordRevokeCause, ChordWatcherEvent } from '../../voice/chord-watcher'
import {
  DesktopContractError,
  DictationTargetGuard,
  type DictationInsertRequest,
  type DictationLease,
  type DictationMode,
  type DictationTarget,
  type PriorDraft
} from '../desktop-contract'
import { DICTATION_ACTOR, DictationSessionContext } from './dictation-context'
import type { DictationMemorySink } from './dictation-memory'
import type {
  DictationHostPorts,
  DictationInsertionResult,
  DictationTargetObservation,
  DictationTargetUnavailable
} from './dictation-ports'

export type DictationUiState = 'off' | 'idle' | 'starting' | 'listening' | 'thinking' | 'inserting' | 'done' | 'failed'

/** Why a dictation was refused before a microphone opened, or stopped or failed afterwards. Machine reasons only. */
export type DictationReason =
  | 'meeting_recording'
  | 'signed_out'
  | 'session_ended'
  | 'onboarding_active'
  | 'speech_unavailable'
  | 'policy_blocked'
  | 'window_hidden'
  | 'capture_busy'
  | 'busy'
  | 'target_unsupported'
  | 'no_target'
  | 'target_not_editable'
  | 'secure_field'
  | 'permission_needed'
  | 'target_changed'
  | 'reconcile_required'
  | 'not_ready'
  | 'microphone_unavailable'
  | 'device_missing'
  | 'device_lost'
  | 'device_busy'
  | 'no_speech'
  | 'recognition_unavailable'
  | 'meeting_started'
  | 'screen_locked'
  | 'system_suspend'
  | 'renderer_reset'
  | 'timeout'
  | 'insertion_unsupported'
  | 'insertion_failed'

export interface DictationSnapshot {
  readonly revision: number
  readonly state: DictationUiState
  readonly turnId: string | null
  readonly reason: DictationReason | null
  readonly enabled: boolean
}

export type DictationAuditPhase = 'started' | 'refused' | 'cancelled' | 'finished'

export interface DictationSessionDeps {
  /** The effective setting: `enabled` already resolves the build default, the chord and the managed policy. */
  settings(): { enabled: boolean }
  gate: {
    signedIn(): boolean
    meetingReserved(): boolean
    onboardingActive(): boolean
    windowVisible(): boolean
    /** Any lease holds the microphone, or a voice turn is about to. A dictation never preempts and never queues. */
    captureBusy(): boolean
    availability(): { ok: true } | { ok: false; reason: 'policy_blocked' | 'unsupported_engine' | 'unauthorized' }
  }
  activation: {
    /** Mint the dictation hardware activation from main's own window frame. False when main cannot. */
    mint(): boolean
    revoke(): void
  }
  /** Hard-stop the dictation lease (a push-to-talk dictation capture), zeroing any PCM it owns. */
  stopLease(reason: 'cancelled' | 'renderer-reset'): void
  speech: { prewarm(): Promise<void> }
  ports: DictationHostPorts
  push: {
    begin(payload: VoiceBegin & { purpose: 'dictation' }): void
    end(payload: { turnId: string; cancelled: boolean }): void
  }
  newTurnId(): string
  now(): number
  audit?(phase: DictationAuditPhase, detail?: { reason?: string }): void
  /** Called synchronously for each draft kept after a dictation ended without a verified insertion. */
  onDraftPreserved?(draft: PriorDraft): void
  /**
   * The encrypted segment journal (G26). Told of each recognized segment before any insertion is attempted, of every
   * draft the guard keeps, of a verified insertion and of the end of each turn. Every call is contained: a failing
   * journal never changes a dictation. Absent, the session behaves as before.
   */
  memory?: DictationMemorySink
}

type Phase = 'starting' | 'listening' | 'thinking' | 'inserting'
interface Turn {
  readonly id: string
  readonly mode: DictationMode
  phase: Phase
  capturing: boolean
  /** The recognized text of this turn was taken once. A second delivery is dropped. */
  claimed: boolean
  /** A stop arrived while the target was still being bound: nothing was opened, so nothing is sealed. */
  stopRequested: boolean
  lease: DictationLease | null
}

/** Guard operation ids (`dictation:N`, reset each launch) remembered for the drafts it keeps after their turn ended. */
const OPERATION_MEMORY = 32
const START_WATCHDOG_MS = 5_000
const FLASH_MS = 4_000

function reasonForHardStop(reason: InputSessionStopReason): DictationReason | null {
  switch (reason) {
    case 'screen-locked':
      return 'screen_locked'
    case 'system-suspend':
      return 'system_suspend'
    case 'sign-out':
    case 'auth-revoked':
      return 'session_ended'
    case 'renderer-reset':
    case 'owner-replaced':
      return 'renderer_reset'
    case 'cancelled':
      return 'timeout'
    default:
      return null
  }
}

function reasonForRevoke(cause: ChordRevokeCause): DictationReason | null {
  switch (cause) {
    case 'lock':
      return 'screen_locked'
    case 'suspend':
      return 'system_suspend'
    case 'sign-out':
      return 'session_ended'
    case 'meeting-started':
      return 'meeting_started'
    case 'helper-lost':
      return 'not_ready'
    default:
      return null
  }
}

function reasonForUnavailable(reason: DictationTargetUnavailable): DictationReason {
  switch (reason) {
    case 'unsupported':
      return 'target_unsupported'
    case 'no_focus':
      return 'no_target'
    case 'secure_field':
      return 'secure_field'
    case 'permission':
      return 'permission_needed'
  }
}

function reasonForGuardError(error: unknown): DictationReason {
  const code = error instanceof DesktopContractError ? error.code : ''
  switch (code) {
    case 'DICTATION_TARGET_CHANGED':
      return 'target_changed'
    case 'TARGET_STALE':
    case 'TARGET_SCHEMA':
    case 'TARGET_ID':
    case 'TARGET_REVISION':
      return 'no_target'
    case 'TARGET_NOT_ALLOWED':
      return 'target_not_editable'
    case 'INSERTION_RECONCILIATION_REQUIRED':
      return 'reconcile_required'
    case 'PERMISSION_DENIED':
      return 'permission_needed'
    case 'CONTEXT_CHANGED':
    case 'DICTATION_REVOKED':
      return 'session_ended'
    default:
      return 'not_ready'
  }
}

/** A secure or non-editable field is named for what it is before the guard sees it. */
function reasonForTarget(target: DictationTarget): DictationReason | null {
  if (target.secure) return 'secure_field'
  if (!target.editable) return 'target_not_editable'
  return null
}

export class DictationSession {
  #enabled = false
  #turn: Turn | null = null
  #stopping = false
  #state: DictationUiState = 'off'
  #reason: DictationReason | null = null
  #turnIdShown: string | null = null
  #revision = 0
  #snapshot: DictationSnapshot
  #capTimer: ReturnType<typeof setTimeout> | null = null
  #watchdog: ReturnType<typeof setTimeout> | null = null
  #flashTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false
  readonly #turnOfOperation = new Map<string, string>()
  readonly #context: DictationSessionContext
  readonly #guard: DictationTargetGuard

  constructor(private readonly deps: DictationSessionDeps) {
    this.#context = new DictationSessionContext(() => this.#enabled && !this.deps.gate.meetingReserved())
    this.#guard = new DictationTargetGuard(this.#context, {
      now: () => this.deps.now(),
      onDraftPreserved: (draft) => {
        const turnId = this.#turnOfOperation.get(draft.operationId)
        if (turnId !== undefined) this.#journal((sink) => sink.draftPreserved(turnId, draft))
        deps.onDraftPreserved?.(draft)
      }
    })
    this.#snapshot = this.#build()
  }

  snapshot(): DictationSnapshot {
    return this.#snapshot
  }

  /** A turn is starting, listening, being recognized or being inserted. */
  active(): boolean {
    return this.#turn !== null
  }

  ownsTurn(turnId: string): boolean {
    return this.#turn?.id === turnId
  }

  /** Drafts kept from dictations that ended without a verified insertion, oldest first. Never inserts anything. */
  priorDrafts(): readonly PriorDraft[] {
    return this.#guard.priorDrafts({ actor: DICTATION_ACTOR })
  }

  /** Apply the current effective setting. Idempotent and synchronous. */
  refresh(): void {
    if (this.#disposed) return
    this.#enabled = this.deps.settings().enabled
    if (!this.#enabled) {
      this.#context.revoke('disabled')
      this.#cancelTurn(null, 'disabled')
      this.#clearFlash()
      this.#set('off', null)
      return
    }
    if (this.#state === 'off') this.#set('idle', null)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#context.revoke('dispose')
    this.#cancelTurn(null, 'disabled')
    this.#clearFlash()
    this.#disposed = true
    this.#guard.dispose()
  }

  /** A verdict from the dictation watcher. Gating by meeting, onboarding and sign-in already ran there too. */
  onChordEvent(event: ChordWatcherEvent): void {
    if (!this.#enabled || this.#disposed) return
    switch (event.type) {
      case 'armed':
        this.#begin('hold')
        return
      case 'latched':
        this.#begin('handsfree')
        return
      case 'released':
      case 'latch-ended':
        this.#stop()
        return
      case 'aborted':
        if (this.#turn?.phase === 'starting' || this.#turn?.phase === 'listening') this.#cancelTurn(null, 'aborted')
        return
      case 'refused':
        // A hold during a meeting: explain, open nothing, touch no capture.
        this.#context.revoke('meeting-refused')
        if (this.#turn) this.#cancelTurn(null, 'superseded')
        this.#audit('refused', { reason: 'meeting_recording' })
        this.#flash('meeting_recording')
        return
      case 'revoked':
        this.#context.revoke(`watcher-${event.cause}`)
        if (this.#turn) this.#cancelTurn(reasonForRevoke(event.cause), `watcher-${event.cause}`)
        return
    }
  }

  /** The chord was released (or the latch ended). Idempotent: with no listening turn it does nothing. */
  stop(): void {
    this.#stop()
  }

  /** The authority hard-stopped (sign-out, lock, suspend, quit, renderer reset, window hidden, a lease timeout). */
  onHardStop(reason: InputSessionStopReason): void {
    if (this.#stopping) return
    this.#context.revoke(reason)
    if (!this.#turn) return
    this.#cancelTurn(reasonForHardStop(reason), reason)
  }

  /** A meeting reservation was accepted. The authority already revoked any interactive lease. */
  onMeetingReserved(): void {
    if (this.#stopping) return
    this.#context.revoke('meeting')
    if (!this.#turn) return
    this.#cancelTurn('meeting_started', 'meeting')
  }

  /** The renderer crashed, was destroyed or navigated away. */
  onRendererReset(): void {
    this.#context.revoke('renderer-reset')
    if (!this.#turn) return
    this.#cancelTurn('renderer_reset', 'renderer-reset', 'renderer-reset')
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
    // G18: the input device changed after speech was captured. The renderer seals and sends what it heard, so the
    // turn is not failed here; the transcript (or a capture failure) still arrives on its own path.
    if (report.phase === 'device_changed') return
    switch (report.reason) {
      case 'device_missing':
      case 'device_lost':
      case 'device_busy':
        this.#cancelTurn(report.reason, 'report')
        return
      case 'policy_blocked':
        this.#cancelTurn('policy_blocked', 'report')
        return
      case 'speech_unavailable':
        this.#cancelTurn('speech_unavailable', 'report')
        return
      case 'recognition_unavailable':
        this.#cancelTurn('recognition_unavailable', 'report')
        return
      case 'no_speech':
        this.#cancelTurn('no_speech', 'report')
        return
      default:
        this.#cancelTurn('microphone_unavailable', 'report')
    }
  }

  /** The speech capture finished for the dictation lease. A success is delivered through `onTranscript`. */
  onSpeechFinished(result: CommandSpeechResult): void {
    const turn = this.#turn
    if (!turn || turn.phase !== 'thinking' || turn.claimed || result.ok) return
    const reason = ((): DictationReason | null => {
      switch (result.reason) {
        case 'no_speech':
        case 'invalid':
          return 'no_speech'
        case 'recognition_unavailable':
          return 'recognition_unavailable'
        default:
          return null
      }
    })()
    this.#audit(reason ? 'finished' : 'cancelled', reason ? { reason } : undefined)
    this.#endTurn()
    if (reason) this.#flash(reason)
    else this.#set('idle', null)
  }

  /**
   * The recognized text of the sealed turn. It becomes the guard's draft and, when the field is still the bound
   * one, goes to the insertion port exactly once. Dropped unless a hardware-activated turn is waiting for it.
   */
  onTranscript(text: string): void {
    const turn = this.#turn
    if (this.#disposed || !this.#enabled || !turn || turn.phase !== 'thinking' || turn.claimed || !turn.lease) return
    turn.claimed = true
    turn.phase = 'inserting'
    this.#set('inserting', null)
    // Journaled before any insertion is attempted, so an interruption from here on loses nothing.
    this.#journal((sink) => sink.segmentRecognized(turn.id, text))
    void this.#deliver(turn, turn.lease, text)
  }

  #refusal(): DictationReason | null {
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
    if (gate.captureBusy()) return 'capture_busy'
    if (!gate.windowVisible()) return 'window_hidden'
    return null
  }

  #begin(mode: DictationMode): void {
    const current = this.#turn
    if (current) {
      // A duplicate arm while starting or listening is the same hold. While recognizing or inserting, a new hold
      // is refused and the turn in flight keeps going.
      if (current.phase === 'thinking' || current.phase === 'inserting') this.#audit('refused', { reason: 'busy' })
      return
    }
    this.#clearFlash()
    const refusal = this.#refusal()
    if (refusal) {
      this.#audit('refused', { reason: refusal })
      this.#flash(refusal)
      return
    }
    const turn: Turn = {
      id: this.deps.newTurnId(),
      mode,
      phase: 'starting',
      capturing: false,
      claimed: false,
      stopRequested: false,
      lease: null
    }
    this.#turn = turn
    this.#set('starting', null)
    void this.#start(turn)
  }

  async #observe(): Promise<DictationTargetObservation> {
    try {
      return await this.deps.ports.target.captureTarget()
    } catch {
      // A broken adapter is "not ready", never a guess about the focused field.
      return { kind: 'unavailable', reason: 'unsupported' }
    }
  }

  async #start(turn: Turn): Promise<void> {
    const observation = await this.#observe()
    // Revoked, aborted or superseded while the target was being observed: the late answer is discarded.
    if (this.#turn !== turn) return
    if (turn.stopRequested) {
      this.#cancelTurn(null, 'stopped-before-start')
      return
    }
    if (observation.kind !== 'target') {
      this.#refuse(reasonForUnavailable(observation.reason))
      return
    }
    const targetReason = reasonForTarget(observation.target)
    if (targetReason) {
      this.#refuse(targetReason)
      return
    }
    try {
      turn.lease = this.#guard.begin({
        actor: DICTATION_ACTOR,
        target: observation.target,
        activation: 'dictation-shortcut',
        mode: turn.mode
      })
    } catch (error) {
      this.#refuse(reasonForGuardError(error))
      return
    }
    this.#turnOfOperation.set(turn.lease.id, turn.id)
    if (this.#turnOfOperation.size > OPERATION_MEMORY) {
      this.#turnOfOperation.delete(this.#turnOfOperation.keys().next().value as string)
    }
    if (!this.deps.activation.mint()) {
      this.#abandonDraft()
      this.#refuse('not_ready')
      return
    }
    turn.phase = 'listening'
    this.#audit('started')
    this.#set('listening', null)
    this.deps.push.begin({ turnId: turn.id, maxMs: VOICE_TURN_MAX_MS, purpose: 'dictation' })
    this.#capTimer = setTimeout(() => this.#stop(), VOICE_TURN_MAX_MS)
    this.#watchdog = setTimeout(() => {
      if (this.#turn === turn && !turn.capturing) this.#cancelTurn('microphone_unavailable', 'no-capture')
    }, START_WATCHDOG_MS)
    void this.deps.speech.prewarm().catch(() => {
      /* recognition reports its own failure when the turn is sealed */
    })
  }

  #stop(): void {
    const turn = this.#turn
    if (!turn) return
    if (turn.phase === 'starting') {
      // Released before the target was bound: there is no capture to seal. `#start` ends the turn quietly.
      turn.stopRequested = true
      return
    }
    if (turn.phase !== 'listening') return
    turn.phase = 'thinking'
    this.#clearCap()
    this.#set('thinking', null)
    this.deps.push.end({ turnId: turn.id, cancelled: false })
  }

  async #deliver(turn: Turn, lease: DictationLease, text: string): Promise<void> {
    const actor = DICTATION_ACTOR
    const settleFailure = (reason: DictationReason): void => {
      if (this.#turn !== turn) return
      this.#audit('finished', { reason })
      this.#endTurn()
      this.#flash(reason)
    }
    try {
      this.#guard.revise(lease, { actor, revision: 1, text })
    } catch (error) {
      this.#abandonDraft()
      settleFailure(reasonForGuardError(error))
      return
    }

    const first = await this.#observe()
    if (this.#turn !== turn) return
    const firstReason = this.#unusable(first)
    if (firstReason) {
      this.#abandonDraft()
      settleFailure(firstReason)
      return
    }
    let request: DictationInsertRequest
    try {
      request = this.#guard.prepare(lease, { actor, currentTarget: (first as { target: DictationTarget }).target })
    } catch (error) {
      this.#abandonDraft()
      settleFailure(reasonForGuardError(error))
      return
    }

    // The guard's one-use dispatch handoff re-checks the field once more, as close to the write as main can.
    const second = await this.#observe()
    if (this.#turn !== turn) return
    const secondReason = this.#unusable(second)
    if (secondReason) {
      this.#abandonDraft()
      settleFailure(secondReason)
      return
    }
    try {
      this.#guard.takeForDispatch(request, { actor, currentTarget: (second as { target: DictationTarget }).target })
    } catch (error) {
      this.#abandonDraft()
      settleFailure(reasonForGuardError(error))
      return
    }

    let result: DictationInsertionResult
    try {
      result = await this.deps.ports.insertion.insert(request)
    } catch {
      // The adapter may or may not have written: that is uncertain, and it is never retried.
      result = { outcome: 'uncertain', evidenceId: 'insertion:adapter-threw' }
    }
    // Revoked while the adapter was working: the turn already ended and the guard holds the outcome as uncertain.
    if (this.#turn !== turn) return

    let verified = false
    try {
      if (result.outcome === 'verified') {
        verified =
          this.#guard.settle(request, {
            actor,
            outcome: 'verified',
            receipt: result.receipt,
            evidenceId: result.evidenceId
          }).state === 'verified'
      } else if (result.outcome === 'unsupported') {
        this.#guard.settle(request, { actor, outcome: 'no_effect', evidenceId: 'insertion:unsupported' })
      } else {
        this.#guard.settle(request, { actor, outcome: result.outcome, evidenceId: result.evidenceId })
      }
    } catch {
      try {
        this.#guard.settle(request, { actor, outcome: 'uncertain', evidenceId: 'insertion:unsettled' })
      } catch {
        /* the guard keeps the record; nothing more can be said about the field */
      }
    }
    if (verified) {
      this.#journal((sink) => sink.inserted(turn.id, text))
      this.#audit('finished')
      this.#endTurn()
      this.#flash(null, 'done')
      return
    }
    settleFailure(result.outcome === 'unsupported' ? 'insertion_unsupported' : 'insertion_failed')
  }

  /** The observation cannot be used for an insertion: unavailable, secure or not editable. */
  #unusable(observation: DictationTargetObservation): DictationReason | null {
    if (observation.kind === 'unavailable') return reasonForUnavailable(observation.reason)
    return reasonForTarget(observation.target)
  }

  /** Interrupt the guard's current dictation so it can never insert. The draft stays kept inside the guard. */
  #abandonDraft(): void {
    try {
      this.#guard.cancel()
    } catch {
      /* a disposed guard has nothing left to interrupt */
    }
  }

  /** The turn never opened a microphone: say why, mint nothing further, free the slot. */
  #refuse(reason: DictationReason): void {
    this.#audit('refused', { reason })
    this.#endTurn()
    this.#flash(reason)
  }

  /**
   * End the turn without recognition. `reason` null is silent (a cancel, quit or toggle). `stopReason` is what the
   * authority hears when a dictation lease exists; our own hard stop is not re-entered.
   */
  #cancelTurn(
    reason: DictationReason | null,
    why: string,
    stopReason: 'cancelled' | 'renderer-reset' = 'cancelled'
  ): void {
    const turn = this.#turn
    if (!turn) return
    this.#audit('cancelled', { reason: reason ?? why })
    if (turn.phase !== 'starting') {
      // Nothing was begun in the renderer while the target was still being bound, so there is nothing to end.
      this.#stopping = true
      try {
        this.deps.stopLease(stopReason)
        this.deps.push.end({ turnId: turn.id, cancelled: true })
      } finally {
        this.#stopping = false
      }
    }
    this.#abandonDraft()
    this.#endTurn()
    if (why === 'disabled') return
    if (reason) this.#flash(reason)
    else this.#set('idle', null)
  }

  #endTurn(): void {
    const ended = this.#turn
    this.#turn = null
    if (ended) this.#journal((sink) => sink.turnEnded(ended.id))
    this.#clearCap()
    this.#clearWatchdog()
    this.deps.activation.revoke()
  }

  #flash(reason: DictationReason | null, state: 'failed' | 'done' = 'failed'): void {
    this.#clearFlash()
    this.#set(state, reason)
    this.#flashTimer = setTimeout(() => {
      this.#flashTimer = null
      if ((this.#state === 'failed' || this.#state === 'done') && !this.#turn) this.#set('idle', null)
    }, FLASH_MS)
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

  /** Tell the journal; whatever it does, the dictation goes on. */
  #journal(call: (sink: DictationMemorySink) => void): void {
    const sink = this.deps.memory
    if (!sink) return
    try {
      call(sink)
    } catch {
      /* the journal is best effort for the session; it reports its own refusals */
    }
  }

  #audit(phase: DictationAuditPhase, detail?: { reason?: string }): void {
    try {
      this.deps.audit?.(phase, detail)
    } catch {
      /* audit is best effort */
    }
  }

  #set(state: DictationUiState, reason: DictationReason | null): void {
    this.#state = state
    this.#reason = reason
    this.#turnIdShown = this.#turn?.id ?? null
    this.#snapshot = this.#build()
  }

  #build(): DictationSnapshot {
    this.#revision += 1
    return {
      revision: this.#revision,
      state: this.#state,
      turnId: this.#turnIdShown,
      reason: this.#reason,
      enabled: this.#enabled
    }
  }
}
