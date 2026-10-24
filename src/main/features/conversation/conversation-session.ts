/**
 * ConversationSession (G28): main's owner of one continuous conversation, an explicit and bounded run of voice
 * turns. It owns dispatch-time capture and reply identities; it never receives audio or transcript text.
 */
import {
  CONVERSATION_LIMITS,
  conversationReasonCopy,
  isConversationActive,
  type ConversationReason,
  type ConversationSnapshot,
  type ConversationStartResult,
  type ConversationState,
  type ConversationStopResult
} from '@shared/conversation/conversation-session'
import type { InputSessionStopReason, TrustedInputOwner } from '@shared/input-session'

export type ConversationAuditPhase = 'started' | 'refused' | 'ended'

/** How one listening window ended, as the voice turn reports it. No text. */
export type ConversationUtteranceOutcome =
  | { kind: 'recognized' }
  | { kind: 'silent' }
  | { kind: 'failed'; reason: ConversationReason }
  | { kind: 'cancelled' }

export type ConversationUtteranceBegin = { ok: true } | { ok: false; reason: ConversationReason }
export type ConversationReplyToken = Readonly<{ sessionId: string; generation: number }>

export interface ConversationUtteranceDispatch {
  readonly sessionId: string
  readonly captureToken: string
  readonly owner: Readonly<TrustedInputOwner>
  readonly maxMs: number
  /** Capture completion is bound to the session, owner and capture window that issued this callback. */
  onEnded(outcome: ConversationUtteranceOutcome): void
}

export interface ConversationSessionDeps {
  /** Main-only owner identity derived from the trusted IPC sender; never accept this from renderer data. */
  owner(): TrustedInputOwner | null | undefined
  /** The effective setting: `enabled` already resolves the build default, voice actions and managed policy. */
  settings(): { enabled: boolean }
  gate: {
    signedIn(): boolean
    meetingReserved(): boolean
    onboardingActive(): boolean
    windowVisible(): boolean
    /** A voice turn, a dictation or an explicit panel lease holds the microphone. */
    captureBusy(): boolean
    availability(): { ok: true } | { ok: false; reason: 'policy_blocked' | 'unsupported_engine' | 'unauthorized' }
  }
  utterance: {
    /** Open one listening window as a voice turn. Never throws; a refusal names the reason. */
    begin(dispatch: ConversationUtteranceDispatch): ConversationUtteranceBegin
    /** Hard-stop only the captured window, zeroing any audio it holds. Idempotent. */
    cancel(captureToken: string): void
  }
  /** The spoken reply (G27). Tokens prevent late playback events from crossing turns or sessions. */
  reply?: { cancel(token: ConversationReplyToken): void }
  push: { state(snapshot: ConversationSnapshot): void }
  newSessionId(): string
  now(): number
  /** Test and QA overrides of the PROPOSED limits. */
  limits?: Partial<{ idleMs: number; maxMs: number; windowMs: number }>
  audit?(phase: ConversationAuditPhase, detail?: { reason?: string }): void
  /** Called exactly once for each installed session that terminates, including initial capture failure. */
  onEnded?(sessionId: string, reason: ConversationReason): void
}

interface Session {
  readonly id: string
  readonly epoch: number
  readonly owner: TrustedInputOwner
  readonly startedAt: number
  idleDeadline: number
  readonly maxDeadline: number
  /** Consecutive refusals to reopen a window. */
  reopenFailures: number
  captureToken: string | null
  replyToken: ConversationReplyToken | null
}

const FLASH_MS = 4_000
/** Gap before the next window, so the previous turn's lease is fully released first. */
const RELISTEN_MS = 400
/** Refusals to reopen a window before the session gives up. */
const MAX_REOPEN_FAILURES = 5

/** Hard-stop reasons that end the session. Turn-level stops (a lease timeout, a device change) are not here. */
function reasonForHardStop(reason: InputSessionStopReason): ConversationReason | null {
  switch (reason) {
    case 'sign-out':
    case 'auth-revoked':
      return 'session_ended'
    case 'screen-locked':
      return 'screen_locked'
    case 'system-suspend':
      return 'system_suspend'
    case 'window-hidden':
      return 'window_hidden'
    case 'renderer-reset':
    case 'owner-replaced':
      return 'renderer_reset'
    case 'shutdown':
      return 'shutdown'
    default:
      return null
  }
}

function sameOwner(left: TrustedInputOwner, right: TrustedInputOwner | null | undefined): boolean {
  return (
    !!right &&
    left.webContentsId === right.webContentsId &&
    left.frameId === right.frameId &&
    left.isTopFrame === right.isTopFrame &&
    left.authSessionGeneration === right.authSessionGeneration &&
    left.contextRevision === right.contextRevision
  )
}

export class ConversationSession {
  #enabled = false
  #session: Session | null = null
  #state: ConversationState = 'off'
  #reason: ConversationReason | null = null
  #replying = false
  #replyPending = false
  #generation = 0
  #revision = 0
  #snapshot: ConversationSnapshot
  #expiryTimer: ReturnType<typeof setTimeout> | null = null
  #listenTimer: ReturnType<typeof setTimeout> | null = null
  #flashTimer: ReturnType<typeof setTimeout> | null = null
  #disposed = false
  #ending = false
  #sessionEpoch = 0
  #captureSerial = 0

  constructor(private readonly deps: ConversationSessionDeps) {
    this.#snapshot = this.#build()
  }

  snapshot(): ConversationSnapshot {
    return this.#snapshot
  }

  /** The current reply token, if a recognized turn is awaiting or playing its reply. */
  currentReplyToken(): ConversationReplyToken | null {
    const token = this.#session?.replyToken
    return token ? { ...token } : null
  }

  /** The recognized turn is being handed to Ask; keep the microphone closed until its reply settles. */
  replyPending(owner: TrustedInputOwner, token: ConversationReplyToken): boolean {
    const session = this.#session
    if (!session || !sameOwner(session.owner, owner) || !this.#matchesReply(session, token)) return false
    if (!this.#ownerAndDeadlineCurrent(session, true)) return false
    this.#replyPending = true
    this.#clearListen()
    const captureToken = session.captureToken
    session.captureToken = null
    this.#cancelWindow(captureToken)
    if (this.#session === session && this.#replyPending && this.#matchesReply(session, token))
      this.#setState('thinking', null)
    return true
  }

  /** Ask IPC accepts only the exact reply reserved by the latest recognized capture for this owner. */
  isCurrentReply(owner: TrustedInputOwner, token: ConversationReplyToken): boolean {
    const session = this.#session
    return Boolean(
      session &&
        sameOwner(session.owner, owner) &&
        this.#matchesReply(session, token) &&
        this.#ownerAndDeadlineCurrent(session, true)
    )
  }

  /** Main binds renderer capture traffic to the exact active owner, session, and one-use capture token. */
  isCurrentCapture(owner: TrustedInputOwner, sessionId: string, captureToken: string): boolean {
    const session = this.#session
    return Boolean(
      session &&
        session.id === sessionId &&
        session.captureToken === captureToken &&
        sameOwner(session.owner, owner) &&
        this.#ownerAndDeadlineCurrent(session, false)
    )
  }

  /** Apply the current effective setting and drop a session whose preconditions went away. Idempotent. */
  refresh(): void {
    if (this.#disposed || this.#ending) return
    this.#enabled = this.deps.settings().enabled
    if (!this.#enabled) {
      this.#end('disabled', { quiet: true })
      this.#clearFlash()
      this.#setState('off', null)
      return
    }
    const session = this.#session
    if (session) {
      if (!sameOwner(session.owner, this.deps.owner())) this.#end('renderer_reset')
      else if (!this.deps.gate.signedIn()) this.#end('session_ended')
      else if (this.deps.gate.meetingReserved()) this.#end('meeting_started')
      else this.#publish()
      return
    }
    if (this.#state === 'off') this.#setState('idle', null)
    else this.#publish()
  }

  /** The one entry point. Only main's trusted-click handler calls it; there is no timer, hook or event that does. */
  start(): ConversationStartResult {
    if (this.#disposed) return { ok: false, reason: 'disabled' }
    this.#enabled = this.deps.settings().enabled
    if (!this.#enabled) {
      this.#end('disabled', { quiet: true })
      this.#clearFlash()
      this.#setState('off', null)
      return { ok: false, reason: 'disabled' }
    }
    if (this.#state === 'off') {
      this.#setState('idle', null)
      // Publishing enabled/idle is an external boundary; an observer may dispose or terminate this service.
      if (this.#disposed) return { ok: false, reason: 'disabled' }
      if (this.#ending) return { ok: false, reason: 'capture_busy' }
    }
    if (this.#ending) return { ok: false, reason: 'capture_busy' }
    if (this.#session) return { ok: true }
    const owner = this.deps.owner()
    const refusal = this.#refusal(owner)
    if (refusal) return this.#refuse(refusal)
    if (!owner) return this.#refuse('signed_out')
    const now = this.deps.now()
    const session: Session = {
      id: this.deps.newSessionId(),
      epoch: ++this.#sessionEpoch,
      owner: Object.freeze({ ...owner }),
      startedAt: now,
      idleDeadline: now + this.#limits().idleMs,
      maxDeadline: now + this.#limits().maxMs,
      reopenFailures: 0,
      captureToken: null,
      replyToken: null
    }
    this.#clearFlash()
    this.#session = session
    this.#replying = false
    this.#armExpiry(session)
    // Publish the active/Stop state before opening the capture window. A synchronous observer may stop or dispose us.
    this.#setState('listening', null)
    if (this.#session !== session || this.#disposed || this.#ending) return { ok: true }
    this.#audit('started')
    if (this.#session !== session || this.#disposed || this.#ending) return { ok: true }
    const opened = this.#open(session)
    if (!opened.ok) {
      if (this.#session === session) this.#end(opened.reason)
      return opened
    }
    return { ok: true }
  }

  /** Stop from any surface. Idempotent: a second stop, or a stop with nothing running, changes nothing. */
  stop(): ConversationStopResult {
    this.#end('user_stop')
    return { ok: true }
  }

  /** G27 started speaking the reply issued by the current recognized turn. */
  replyStarted(token: ConversationReplyToken): void {
    const session = this.#session
    if (!session || !this.#matchesReply(session, token) || this.#replying) return
    if (!this.#ownerAndDeadlineCurrent(session, true)) return
    this.#replyPending = false
    this.#replying = true
    this.#clearListen()
    const captureToken = session.captureToken
    session.captureToken = null
    this.#cancelWindow(captureToken)
    if (this.#session === session && this.#replying && this.#matchesReply(session, token))
      this.#setState('replying', null)
  }

  /** G27 finished or abandoned the exact current reply; stale finishes cannot resume another session. */
  replyFinished(token: ConversationReplyToken): void {
    const session = this.#session
    if (!session || !this.#matchesReply(session, token)) return
    if (!this.#ownerAndDeadlineCurrent(session, this.#replying || this.#replyPending)) return
    this.#replying = false
    this.#replyPending = false
    session.replyToken = null
    session.idleDeadline = this.deps.now() + this.#limits().idleMs
    this.#armExpiry(session)
    if (session.captureToken !== null) {
      // The reply ended after the next window opened. Keep that lease; opening another would orphan it.
      this.#setState('listening', null)
      return
    }
    this.#setState('thinking', null)
    if (this.#session === session && !this.#disposed && !this.#ending) this.#scheduleListen(session, RELISTEN_MS)
  }

  /** The authority hard-stopped (sign-out, lock, suspend, quit, renderer reset, window hidden). */
  onHardStop(reason: InputSessionStopReason): void {
    const mapped = reasonForHardStop(reason)
    if (mapped) this.#end(mapped)
  }

  /** A meeting reservation was accepted: a conversation never runs beside a meeting. */
  onMeetingReserved(): void {
    this.#end('meeting_started')
  }

  /** The renderer crashed, was destroyed or navigated away. */
  onRendererReset(): void {
    this.#end('renderer_reset')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#end('shutdown', { quiet: true })
    this.#clearFlash()
    if (!this.#session && this.#state !== 'off' && this.#state !== 'ended') this.#setState('ended', 'shutdown')
  }

  #limits(): { idleMs: number; maxMs: number; windowMs: number } {
    return {
      idleMs: this.deps.limits?.idleMs ?? CONVERSATION_LIMITS.idleMs,
      maxMs: this.deps.limits?.maxMs ?? CONVERSATION_LIMITS.maxMs,
      windowMs: this.deps.limits?.windowMs ?? CONVERSATION_LIMITS.windowMs
    }
  }

  #refusal(owner: TrustedInputOwner | null | undefined): ConversationReason | null {
    const { gate } = this.deps
    if (!gate.signedIn() || !owner) return 'signed_out'
    if (gate.meetingReserved()) return 'meeting_recording'
    if (gate.onboardingActive()) return 'onboarding_active'
    const availability = gate.availability()
    if (!availability.ok)
      return availability.reason === 'policy_blocked'
        ? 'policy_blocked'
        : availability.reason === 'unauthorized'
          ? 'signed_out'
          : 'speech_unavailable'
    if (!gate.windowVisible()) return 'window_hidden'
    if (gate.captureBusy()) return 'capture_busy'
    return null
  }

  #refuse(reason: ConversationReason): ConversationStartResult {
    this.#audit('refused', { reason })
    // Audit callbacks are external and may synchronously start or dispose a session.
    if (!this.#disposed && !this.#ending && !this.#session) this.#flash(reason)
    return { ok: false, reason }
  }

  #open(session: Session): ConversationUtteranceBegin {
    if (this.#session !== session || !this.#ownerAndDeadlineCurrent(session, false))
      return { ok: false, reason: 'not_ready' }
    const captureToken = `${session.epoch}:${++this.#captureSerial}`
    session.captureToken = captureToken
    try {
      const result = this.deps.utterance.begin({
        maxMs: this.#limits().windowMs,
        sessionId: session.id,
        captureToken,
        owner: session.owner,
        onEnded: (outcome) => this.#acceptUtterance(session, captureToken, outcome)
      })
      if (!result.ok && this.#session === session && session.captureToken === captureToken) session.captureToken = null
      return result
    } catch {
      if (this.#session === session && session.captureToken === captureToken) session.captureToken = null
      return { ok: false, reason: 'not_ready' }
    }
  }

  #acceptUtterance(session: Session, captureToken: string, outcome: ConversationUtteranceOutcome): void {
    if (this.#disposed || this.#ending || this.#session !== session || session.captureToken !== captureToken) return
    if (!this.#ownerAndDeadlineCurrent(session, false)) return
    // Consume before any external callback (reply cancellation, state push, audit, relisten) can re-enter.
    session.captureToken = null
    switch (outcome.kind) {
      case 'recognized': {
        const oldReply = session.replyToken
        session.replyToken = { sessionId: session.id, generation: ++this.#generation }
        this.#replying = false
        this.#replyPending = false
        this.#cancelReply(oldReply)
        if (this.#session !== session || this.#disposed || this.#ending) return
        session.idleDeadline = this.deps.now() + this.#limits().idleMs
        this.#armExpiry(session)
        this.#setState('thinking', null)
        if (this.#session === session) this.#scheduleListen(session, RELISTEN_MS)
        return
      }
      case 'silent':
      case 'cancelled':
        if (!this.#replying) this.#scheduleListen(session, RELISTEN_MS)
        return
      case 'failed':
        this.#end(outcome.reason)
        return
    }
  }

  #scheduleListen(session: Session, delayMs: number): void {
    this.#clearListen()
    this.#listenTimer = setTimeout(() => {
      this.#listenTimer = null
      this.#listen(session)
    }, delayMs)
  }

  #listen(session: Session): void {
    if (this.#session !== session || this.#replying || this.#disposed || this.#ending) return
    if (!this.#ownerAndDeadlineCurrent(session, false)) return
    const opened = this.#open(session)
    if (this.#session !== session || this.#disposed || this.#ending) return
    if (opened.ok) {
      session.reopenFailures = 0
      if (session.captureToken !== null) this.#setState('listening', null)
      return
    }
    session.reopenFailures++
    if (session.reopenFailures >= MAX_REOPEN_FAILURES) {
      this.#end(opened.reason)
      return
    }
    this.#scheduleListen(session, RELISTEN_MS)
  }

  #armExpiry(session: Session): void {
    this.#clearExpiry()
    if (this.#session !== session) return
    const next = Math.min(session.idleDeadline, session.maxDeadline)
    this.#expiryTimer = setTimeout(
      () => {
        this.#expiryTimer = null
        if (this.#session === session) this.#expire(session)
      },
      Math.max(0, next - this.deps.now())
    )
  }

  #expire(session: Session): void {
    if (this.#session !== session) return
    const now = this.deps.now()
    if (now >= session.maxDeadline) return this.#end('max_duration')
    if (now >= session.idleDeadline) {
      if (this.#replying || this.#replyPending) {
        // A reply that is still playing is activity; the hard maximum still bounds it.
        session.idleDeadline = now + this.#limits().idleMs
        this.#armExpiry(session)
        this.#publish()
        return
      }
      return this.#end('idle_timeout')
    }
    this.#armExpiry(session)
  }

  #ownerAndDeadlineCurrent(session: Session, allowReplyActivity: boolean): boolean {
    if (this.#session !== session || this.#disposed || this.#ending) return false
    if (!this.deps.settings().enabled) {
      this.#enabled = false
      this.#end('disabled', { quiet: true })
      this.#clearFlash()
      this.#setState('off', null)
      return false
    }
    if (!sameOwner(session.owner, this.deps.owner())) {
      this.#end('renderer_reset')
      return false
    }
    const now = this.deps.now()
    if (now >= session.maxDeadline) {
      this.#end('max_duration')
      return false
    }
    if (now >= session.idleDeadline && !(allowReplyActivity && (this.#replying || this.#replyPending))) {
      this.#end('idle_timeout')
      return false
    }
    return true
  }

  #matchesReply(session: Session, token: ConversationReplyToken): boolean {
    return (
      this.#session === session &&
      session.replyToken?.sessionId === token.sessionId &&
      session.replyToken.generation === token.generation &&
      token.sessionId === session.id
    )
  }

  /** End invalidates identity and publishes an inactive snapshot before it calls any external hook. */
  #end(reason: ConversationReason, options: { quiet?: boolean } = {}): void {
    const session = this.#session
    if (!session || this.#ending) return
    this.#ending = true
    const captureToken = session.captureToken
    const replyToken = session.replyToken
    this.#session = null
    session.captureToken = null
    session.replyToken = null
    this.#replyPending = false
    this.#replying = false
    this.#clearExpiry()
    this.#clearListen()
    this.#setState('ended', reason)
    try {
      this.#cancelReply(replyToken)
      this.#cancelWindow(captureToken)
      this.#audit('ended', { reason })
      try {
        this.deps.onEnded?.(session.id, reason)
      } catch {
        /* completion notifications are best effort and cannot restore a terminated session */
      }
    } finally {
      this.#ending = false
    }
    if (!options.quiet && !this.#disposed && !this.#session && this.#state === 'ended' && this.#reason === reason)
      this.#flash(reason)
  }

  #cancelReply(token: ConversationReplyToken | null): void {
    if (!token) return
    try {
      this.deps.reply?.cancel(token)
    } catch {
      /* playback is G27's; a failure there never keeps the session alive */
    }
  }

  #cancelWindow(captureToken: string | null): void {
    if (!captureToken) return
    try {
      this.deps.utterance.cancel(captureToken)
    } catch {
      /* the voice session reports its own failures */
    }
  }

  #flash(reason: ConversationReason): void {
    this.#clearFlash()
    this.#setState('ended', reason)
    // State publication can dispose the service or start a new session reentrantly.
    if (this.#disposed || this.#session || this.#state !== 'ended' || this.#reason !== reason) return
    this.#flashTimer = setTimeout(() => {
      this.#flashTimer = null
      if (!this.#disposed && this.#state === 'ended' && !this.#session) this.#setState('idle', null)
    }, FLASH_MS)
  }

  #clearExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer)
    this.#expiryTimer = null
  }
  #clearListen(): void {
    if (this.#listenTimer) clearTimeout(this.#listenTimer)
    this.#listenTimer = null
  }
  #clearFlash(): void {
    if (this.#flashTimer) clearTimeout(this.#flashTimer)
    this.#flashTimer = null
  }

  #audit(phase: ConversationAuditPhase, detail?: { reason?: string }): void {
    try {
      this.deps.audit?.(phase, detail)
    } catch {
      /* audit is best effort */
    }
  }

  #setState(state: ConversationState, reason: ConversationReason | null): void {
    this.#state = state
    this.#reason = reason
    this.#publish()
  }

  #build(): ConversationSnapshot {
    const session = this.#session
    const state: ConversationState = this.#enabled ? this.#state : 'off'
    const active = session !== null && isConversationActive(state)
    const limits = this.#limits()
    return {
      revision: this.#revision,
      state,
      active,
      stopAvailable: active,
      sessionId: active ? session.id : null,
      startedAt: active ? session.startedAt : null,
      idleExpiresAt: active ? session.idleDeadline : null,
      maxExpiresAt: active ? session.maxDeadline : null,
      replyGeneration: this.#generation,
      limits: { idleMs: limits.idleMs, maxMs: limits.maxMs, status: CONVERSATION_LIMITS.status },
      reason: this.#reason,
      message: this.#reason ? conversationReasonCopy(this.#reason) : null,
      enabled: this.#enabled
    }
  }

  #publish(): void {
    const next = { ...this.#build(), revision: this.#revision + 1 }
    const prev = this.#snapshot
    const same =
      prev.state === next.state &&
      prev.active === next.active &&
      prev.sessionId === next.sessionId &&
      prev.idleExpiresAt === next.idleExpiresAt &&
      prev.replyGeneration === next.replyGeneration &&
      prev.reason === next.reason &&
      prev.enabled === next.enabled
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
