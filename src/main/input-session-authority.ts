import { randomBytes } from 'node:crypto'
import {
  isSpeechCapturePurpose,
  InputSessionStartSchema,
  InputSessionStopSchema,
  type InputSessionLease,
  type InputSessionResult,
  type InputSessionStopResult,
  type InputSessionStopReason,
  type TrustedInputOwner
} from '@shared/input-session'

interface ActiveSession {
  readonly owner: TrustedInputOwner
  readonly lease: InputSessionLease
  captureState: 'pending' | 'permission-authorized' | 'established'
}

const validOwner = (owner: TrustedInputOwner): boolean =>
  owner.isTopFrame === true &&
  Number.isSafeInteger(owner.webContentsId) &&
  owner.webContentsId > 0 &&
  typeof owner.frameId === 'string' &&
  owner.frameId.length > 0 &&
  owner.frameId.length <= 256 &&
  Number.isSafeInteger(owner.authSessionGeneration) &&
  owner.authSessionGeneration >= 0 &&
  Number.isSafeInteger(owner.contextRevision) &&
  owner.contextRevision >= 0

/** Main-process authority for admission to renderer-owned microphone capture. Renderer-supplied
 * activation is not a trusted capability, so leases never grant action authority. */
export class InputSessionAuthority {
  #active?: ActiveSession
  #meetingStartedAt: number | null = null
  #meetingReserved = false
  #revision = 0
  #closing = false
  #shutdown = false
  #token: () => string
  #now: () => number
  #onRevoked?: (owner: TrustedInputOwner, lease: InputSessionLease, reason: InputSessionStopReason) => void
  #onHardStop?: (reason: InputSessionStopReason) => void
  #onMeetingReserved?: () => void

  constructor(
    options: {
      token?: () => string
      now?: () => number
      onRevoked?: (owner: TrustedInputOwner, lease: InputSessionLease, reason: InputSessionStopReason) => void
      /** Every hardStop, with or without an active lease (sign-out, lock, suspend, quit reach a voice turn that
       *  has no lease yet). Never fires for a meeting reservation or an arbitration preempt. */
      onHardStop?: (reason: InputSessionStopReason) => void
      /** After an accepted meeting reservation; an interactive lease was already revoked synchronously. */
      onMeetingReserved?: () => void
    } = {}
  ) {
    this.#token = options.token ?? (() => randomBytes(24).toString('hex'))
    this.#now = options.now ?? Date.now
    this.#onRevoked = options.onRevoked
    this.#onHardStop = options.onHardStop
    this.#onMeetingReserved = options.onMeetingReserved
  }

  start(owner: TrustedInputOwner, raw: unknown): InputSessionResult {
    if (!validOwner(owner)) return { ok: false, reason: 'unauthorized' }
    if (this.#closing || this.#shutdown) return { ok: false, reason: 'shutdown' }
    const parsed = InputSessionStartSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid_request' }
    if (this.#active && !this.#sameContext(this.#active.owner, owner)) this.hardStop('owner-replaced')
    if (this.#meetingReserved) return { ok: false, reason: 'meeting_reserved' }
    // An explicit push-to-talk command (a hardware-minted voice turn) beats an ambient lease. Nothing preempts an
    // explicit lease, and no other source preempts anything.
    if (
      this.#active?.lease.activation === 'ambient' &&
      parsed.data.source === 'push-to-talk' &&
      parsed.data.purpose === 'command'
    )
      this.#revokeActive('arbitration-preempted')
    if (this.#active) return { ok: false, reason: 'busy' }
    const now = this.#now()
    const sessionId = this.#token()
    if (!Number.isFinite(now) || !/^[a-f0-9]{48}$/.test(sessionId)) return { ok: false, reason: 'invalid_request' }
    const lease: InputSessionLease = Object.freeze({
      sessionId,
      source: parsed.data.source,
      purpose: parsed.data.purpose,
      activation: parsed.data.activation,
      authSessionGeneration: owner.authSessionGeneration,
      contextRevision: owner.contextRevision,
      revision: ++this.#revision,
      startedAt: now,
      actionAuthority: false
    })
    this.#active = { owner: Object.freeze({ ...owner }), lease, captureState: 'pending' }
    return { ok: true, lease }
  }

  /** Consume the one pending permission request for this exact top-frame lease owner. */
  claimPermissionRequest(owner: TrustedInputOwner): boolean {
    const current = this.#active
    if (!current || current.captureState !== 'pending' || !this.#owns(current.owner, owner)) return false
    current.captureState = 'permission-authorized'
    return true
  }

  /** The request handler may inspect a pending lease before atomically claiming it. */
  hasPermissionRequestOwner(owner: TrustedInputOwner): boolean {
    const current = this.#active
    return !!current && current.captureState === 'pending' && this.#owns(current.owner, owner)
  }

  /** Permission checks are read-only and accept only a request already claimed by main. */
  hasPermissionCheckOwner(owner: TrustedInputOwner): boolean {
    const current = this.#active
    return !!current && current.captureState === 'permission-authorized' && this.#owns(current.owner, owner)
  }

  /** Confirm the exact permission-authorized lease after renderer getUserMedia resolves. */
  confirmCapture(owner: TrustedInputOwner, sessionId: string): boolean {
    const current = this.#active
    if (
      !current ||
      current.captureState !== 'permission-authorized' ||
      current.lease.sessionId !== sessionId ||
      !this.#owns(current.owner, owner)
    )
      return false
    current.captureState = 'established'
    return true
  }

  stop(owner: TrustedInputOwner, raw: unknown, _reason: InputSessionStopReason = 'user-stop'): InputSessionStopResult {
    if (!validOwner(owner)) return { ok: false, reason: 'unauthorized' }
    const parsed = InputSessionStopSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid_request' }
    const current = this.#active
    if (!current || current.lease.sessionId !== parsed.data.sessionId || !this.#owns(current.owner, owner)) {
      return { ok: false, reason: 'stale_session' }
    }
    this.#active = undefined
    return { ok: true }
  }

  /** An accepted meeting transition preempts interactive authority and atomically replaces the reservation. */
  reserveMeeting(startedAt: number | null): boolean {
    if (this.#closing || this.#shutdown || (startedAt !== null && (!Number.isSafeInteger(startedAt) || startedAt <= 0)))
      return false
    // This is called only after the main meeting identity acceptor admits a transition. Revoke interactive
    // lease authority synchronously, then atomically replace any previous metadata reservation.
    this.#revokeActive('owner-replaced')
    this.#meetingReserved = true
    this.#meetingStartedAt = startedAt
    try {
      this.#onMeetingReserved?.()
    } catch {
      /* the reservation stands even if an observer fails */
    }
    return true
  }

  releaseMeeting(startedAt: number | null): boolean {
    if (!this.#meetingReserved || this.#meetingStartedAt !== startedAt) return false
    this.#meetingReserved = false
    this.#meetingStartedAt = null
    return true
  }

  /** Drop an old lease when main observes a new account generation or renderer context revision. */
  reconcileContext(context: Pick<TrustedInputOwner, 'authSessionGeneration' | 'contextRevision'>): void {
    if (
      this.#active &&
      (this.#active.owner.authSessionGeneration !== context.authSessionGeneration ||
        this.#active.owner.contextRevision !== context.contextRevision)
    )
      this.hardStop('auth-revoked')
  }

  /** Hard stop invalidates admission synchronously and notifies the exact renderer lease owner. */
  hardStop(reason: InputSessionStopReason): void {
    this.#revokeActive(reason)
    try {
      this.#onHardStop?.(reason)
    } catch {
      /* authority stays revoked even if an observer fails */
    }
  }

  #revokeActive(reason: InputSessionStopReason): void {
    const active = this.#active
    this.#active = undefined
    if (active) {
      try {
        this.#onRevoked?.(active.owner, active.lease, reason)
      } catch {
        /* authority stays revoked even if the renderer is gone */
      }
    }
  }

  /** Stop interactive starts at the first quit request while preserving an admitted meeting flush. */
  beginShutdown(): void {
    this.#closing = true
    this.hardStop('shutdown')
  }

  shutdown(): void {
    this.#closing = true
    this.#shutdown = true
    this.hardStop('shutdown')
    this.#meetingReserved = false
    this.#meetingStartedAt = null
  }

  get activeLease(): InputSessionLease | null {
    return this.#active?.lease ?? null
  }
  get isClosing(): boolean {
    return this.#closing
  }
  get meetingStartedAt(): number | null {
    return this.#meetingStartedAt
  }
  get hasMeetingReservation(): boolean {
    return this.#meetingReserved
  }
  ownsInteractiveOwner(webContentsId: number): boolean {
    return this.#active?.owner.webContentsId === webContentsId
  }
  /** `speech` matches either purpose whose PCM main recognizes: a voice command or a dictation (G22). */
  isEstablishedLease(
    owner: TrustedInputOwner,
    sessionId: string,
    purpose: 'command' | 'dictation' | 'conversation' | 'speech'
  ): boolean {
    const current = this.#active
    return (
      !!current &&
      current.captureState === 'established' &&
      current.lease.sessionId === sessionId &&
      (purpose === 'speech' ? isSpeechCapturePurpose(current.lease.purpose) : current.lease.purpose === purpose) &&
      this.#owns(current.owner, owner)
    )
  }

  #owns(expected: TrustedInputOwner, actual: TrustedInputOwner): boolean {
    return (
      actual.isTopFrame === true &&
      expected.webContentsId === actual.webContentsId &&
      expected.frameId === actual.frameId &&
      this.#sameContext(expected, actual)
    )
  }

  #sameContext(expected: TrustedInputOwner, actual: TrustedInputOwner): boolean {
    return (
      expected.authSessionGeneration === actual.authSessionGeneration &&
      expected.contextRevision === actual.contextRevision
    )
  }
}
