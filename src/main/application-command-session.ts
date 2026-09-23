import { randomBytes } from 'node:crypto'
import type { ApplicationCatalog } from './application-catalog'
import type { ApplicationResolution, ApplicationView } from './application-catalog-view'
import { classifyApplicationIntent, parseApplicationIntent, type ApplicationIntent } from './application-intents'

/** Supplied by main from the actual sender, never from renderer request data.
 * frameId must identify this exact top-frame lifetime, not just its routing index.
 */
export interface CommandOwner {
  readonly ownerId: number
  readonly frameId: string
  readonly isTopFrame: boolean
}

export type CommandPhase = 'ready' | 'selection' | 'proposal' | 'malformed' | 'unrecognized' |
  'missing' | 'ambiguous' | 'restricted' | 'unavailable' | 'stale-catalog' |
  'unauthorized' | 'stale-revision' | 'rate-limited' | 'expired' | 'deadline' |
  'cancelled' | 'stopped' | 'replaced' | 'meeting-reserved' | 'shutdown'

/** Presentation only. No intent, catalog identity/version or execution authority. */
export interface CommandPresentation {
  readonly phase: CommandPhase
  readonly revision: number
  readonly proposalId?: string
  readonly nonce?: string
  readonly expiresAt?: number
  readonly actionLabel?: string
  readonly targetLabel?: string
  readonly risk?: 'R0' | 'R1' | 'R2'
}

export interface CommandSessionHandle {
  readonly sessionId: string
  readonly expiresAt: number
}

interface Ingress { sessionId: string; revision: number; text: string }
type TargetIntent = Exclude<ApplicationIntent, { operation: 'apps.list' }>
type Operation = TargetIntent['operation'] | 'apps.list'
interface Proposal {
  readonly intent: TargetIntent
  readonly application: ApplicationView
  readonly presentation: CommandPresentation
}
interface Session {
  readonly ownerId: number
  readonly frameId: string
  readonly sessionId: string
  readonly expiresAt: number
  revision: number
  attempts: number
  lastRequest: number
  active: boolean
  controller: AbortController
  expiryTimer?: ReturnType<typeof setTimeout>
  presentation: CommandPresentation
  proposal?: Proposal
}

export interface ApplicationCommandSessionOptions {
  catalog: Pick<ApplicationCatalog, 'snapshot' | 'resolve' | 'revalidate'>
  parser?: typeof parseApplicationIntent
  /** Milliseconds, nondecreasing. Default gives UI-readable expiry timestamps. */
  now?: () => number
}

const token = (): string => randomBytes(24).toString('hex')
const view = (phase: CommandPhase, revision = 0): CommandPresentation => Object.freeze({ phase, revision })
const invalidText = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u

/** Screen descriptors before any dependency, coercion or schema sees a value.
 * Only ordinary structured data is supported, not active same-process Proxies.
 */
function screen(input: unknown): Ingress | null {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return null
    const keys = Reflect.ownKeys(input)
    if (keys.length !== 3 || keys.some(key => !['sessionId', 'revision', 'text'].includes(key as string))) return null
    const values: Record<string, unknown> = Object.create(null)
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      values[key] = descriptor.value
    }
    const { sessionId, revision, text } = values
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{48}$/.test(sessionId) ||
        typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0 ||
        typeof text !== 'string' || text.length > 512 || !text.trim()) return null
    return { sessionId, revision, text }
  } catch { return null }
}

/** Pure main-owned selection boundary. No action execution or confirmation
 * consumption is exposed. Later execution must add fresh native checks and an
 * independent, one-use confirmation boundary rather than treating this DTO as authority.
 */
export class ApplicationCommandSession {
  #catalog: ApplicationCommandSessionOptions['catalog']
  #parser: typeof parseApplicationIntent
  #now: () => number
  #lastNow = -Infinity
  #session?: Session
  #meetingReserved = false
  #shutdown = false

  constructor(options: ApplicationCommandSessionOptions) {
    this.#catalog = options.catalog
    this.#parser = options.parser ?? parseApplicationIntent
    this.#now = options.now ?? Date.now
  }

  start(owner: CommandOwner): CommandSessionHandle | null {
    if (this.#session) this.#revoke(this.#session, 'replaced')
    const now = this.#time()
    if (this.#shutdown || this.#meetingReserved || now === null || !owner.isTopFrame ||
        !Number.isSafeInteger(owner.ownerId) || owner.ownerId <= 0 ||
        typeof owner.frameId !== 'string' || !owner.frameId || owner.frameId.length > 256) return null
    this.#session = {
      ownerId: owner.ownerId, frameId: owner.frameId, sessionId: token(), expiresAt: now + 30_000,
      revision: 0, attempts: 0, lastRequest: -Infinity, active: true,
      controller: new AbortController(), presentation: view('ready')
    }
    this.#scheduleExpiry(this.#session, now)
    return Object.freeze({ sessionId: this.#session.sessionId, expiresAt: this.#session.expiresAt })
  }

  state(owner: CommandOwner): CommandPresentation {
    const session = this.#session
    if (!session || !this.#owns(session, owner)) return view('unauthorized')
    this.#checkTime(session)
    return session.presentation
  }

  /** Only this three-field text ingress may be exposed by future IPC wiring. */
  submit(owner: CommandOwner, input: unknown): Promise<CommandPresentation> {
    const session = this.#session
    if (!session || !this.#owns(session, owner)) return Promise.resolve(view('unauthorized'))
    if (!this.#checkTime(session)) return Promise.resolve(session.presentation)
    const screened = screen(input)
    if (!screened) return Promise.resolve(view('malformed', session.revision))
    if (screened.sessionId !== session.sessionId) return Promise.resolve(view('unauthorized'))
    if (screened.revision <= session.revision) return Promise.resolve(view('stale-revision', session.revision))
    const now = this.#lastNow
    if (now - session.lastRequest < 250 || session.attempts >= 8) {
      this.#revoke(session, 'rate-limited')
      return Promise.resolve(session.presentation)
    }
    session.controller.abort()
    session.controller = new AbortController()
    session.proposal = undefined
    session.revision = screened.revision
    session.attempts++
    session.lastRequest = now
    session.presentation = view('ready', session.revision)
    this.#scheduleExpiry(session, now)
    if (invalidText.test(screened.text)) return Promise.resolve(this.#set(session, 'malformed'))
    const text = screened.text.trim()
    const match = /^(open|focus|quit|close) +(.+)$/i.exec(text)
    const list = /^(list|list apps)$/i.test(text)
    if (!list && !match) return Promise.resolve(this.#set(session, 'unrecognized'))
    try {
      // Query validation is selection-only. Only the catalog may establish a target.
      const parsed = this.#parser(list ? { operation: 'apps.list' } : { operation: 'apps.list', query: match![2] })
      if (!parsed.success || parsed.data.operation !== 'apps.list' ||
          parsed.data.query !== (list ? undefined : match![2])) return Promise.resolve(this.#set(session, 'malformed'))
      const operation: Operation = list ? 'apps.list' : match![1].toLowerCase() === 'open' ? 'apps.open' :
        match![1].toLowerCase() === 'focus' ? 'apps.focus' : 'apps.quit'
      // Pass only the promise onward; async state never retains the submitted text/query.
      const pending = list ? this.#catalog.snapshot() : this.#catalog.resolve(parsed.data.query!)
      return this.#prepare(session, session.revision, operation, pending, now + 2000)
    } catch { return Promise.resolve(this.#set(session, 'unavailable')) }
  }

  cancel(owner: CommandOwner, proposalId: string, nonce: string): boolean {
    const session = this.#session
    if (!session || !this.#owns(session, owner) || !this.#checkTime(session)) return false
    const dto = session.proposal?.presentation
    if (!dto || dto.proposalId !== proposalId || dto.nonce !== nonce) return false
    this.#revoke(session, 'cancelled')
    return true
  }

  stop(owner: CommandOwner): void {
    if (this.#session && this.#owns(this.#session, owner)) this.#revoke(this.#session, 'stopped')
  }

  rendererReplaced(ownerId: number): void { this.windowReplaced(ownerId) }

  windowReplaced(ownerId: number): void {
    if (this.#session?.ownerId === ownerId) this.#revoke(this.#session, 'replaced')
  }

  reserveMeetingCapture(reserved: boolean): void {
    this.#meetingReserved = reserved
    if (reserved && this.#session) this.#revoke(this.#session, 'meeting-reserved')
  }

  shutdown(): void {
    this.#shutdown = true
    if (this.#session) this.#revoke(this.#session, 'shutdown')
  }

  #owns(session: Session, owner: CommandOwner): boolean {
    return owner.isTopFrame === true && owner.ownerId === session.ownerId && owner.frameId === session.frameId
  }

  #time(): number | null {
    try {
      const now = this.#now()
      if (!Number.isFinite(now) || now < this.#lastNow) return null
      this.#lastNow = now
      return now
    } catch { return null }
  }

  #checkTime(session: Session): boolean {
    if (!session.active) return false
    const now = this.#time()
    if (now === null || now >= session.expiresAt || (session.proposal && now >= session.proposal.presentation.expiresAt!)) {
      this.#revoke(session, 'expired')
    }
    return session.active
  }

  #set(session: Session, phase: CommandPhase): CommandPresentation {
    session.presentation = view(phase, session.revision)
    return session.presentation
  }

  #revoke(session: Session, phase: CommandPhase): void {
    session.active = false
    session.proposal = undefined
    clearTimeout(session.expiryTimer)
    session.expiryTimer = undefined
    this.#set(session, phase)
    session.controller.abort()
  }

  #scheduleExpiry(session: Session, now: number): void {
    clearTimeout(session.expiryTimer)
    const expiresAt = session.proposal?.presentation.expiresAt ?? session.expiresAt
    session.expiryTimer = setTimeout(() => this.#revoke(session, 'expired'), Math.max(0, expiresAt - now))
    session.expiryTimer.unref?.()
  }

  async #prepare(session: Session, revision: number, operation: Operation,
    pending: ReturnType<ApplicationCommandSessionOptions['catalog']['snapshot']> | Promise<ApplicationResolution>,
    deadline: number): Promise<CommandPresentation> {
    const signal = session.controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => {
        if (session.active && session.revision === revision) this.#revoke(session, 'deadline')
        reject(new Error('Deadline'))
      }, Math.max(0, deadline - this.#lastNow))
    })
    const current = (): boolean => session.active && session.revision === revision &&
      this.#session === session && this.#checkTime(session)
    try {
      const result = await Promise.race([pending, interrupted])
      if (!current()) return view(session.active ? 'replaced' : session.presentation.phase, revision)
      if (this.#lastNow >= deadline) { this.#revoke(session, 'deadline'); return session.presentation }
      if (operation === 'apps.list') {
        session.presentation = Object.freeze({ phase: 'selection', revision, actionLabel: 'List applications', targetLabel: 'Applications', risk: 'R0' })
        return session.presentation
      }
      const resolution = result as ApplicationResolution
      if (resolution.status === 'missing' || resolution.status === 'ambiguous') return this.#set(session, resolution.status)
      if (resolution.application.availability === 'restricted' || resolution.application.risk === 'restricted') return this.#set(session, 'restricted')
      if (resolution.status !== 'resolved') return this.#set(session, 'unavailable')
      const version = { revision: resolution.revision, digest: resolution.digest }
      const refreshed = await Promise.race([this.#catalog.revalidate(resolution.application.id, version), interrupted])
      if (!current()) return view(session.active ? 'replaced' : session.presentation.phase, revision)
      if (this.#lastNow >= deadline) { this.#revoke(session, 'deadline'); return session.presentation }
      if (refreshed.status === 'missing') return this.#set(session, 'missing')
      if (refreshed.application.availability === 'restricted' || refreshed.application.risk === 'restricted') return this.#set(session, 'restricted')
      if (refreshed.status === 'unavailable') return this.#set(session, 'unavailable')
      if (refreshed.status !== 'valid' || refreshed.revision !== version.revision || refreshed.digest !== version.digest ||
          refreshed.application.id !== resolution.application.id) return this.#set(session, 'stale-catalog')
      const parsed = this.#parser({ operation, applicationId: refreshed.application.id, candidateSet: version,
        ...(operation === 'apps.quit' ? { mode: 'graceful' } : {}) })
      if (!parsed.success || parsed.data.operation !== operation ||
          parsed.data.applicationId !== refreshed.application.id || parsed.data.candidateSet.revision !== version.revision ||
          parsed.data.candidateSet.digest !== version.digest) return this.#set(session, 'malformed')
      const capability = classifyApplicationIntent(parsed.data, refreshed.application.kind)
      if (!capability || refreshed.application.availability !== 'available' || refreshed.application.risk !== 'R1') return this.#set(session, 'restricted')
      const presentation: CommandPresentation = Object.freeze({ phase: 'proposal', revision, proposalId: token(), nonce: token(),
        expiresAt: Math.min(session.expiresAt, this.#lastNow + 15_000),
        actionLabel: operation === 'apps.open' ? 'Open' : operation === 'apps.focus' ? 'Focus' : 'Quit gracefully',
        targetLabel: refreshed.application.displayName, risk: capability.risk })
      const target = { applicationId: refreshed.application.id, candidateSet: Object.freeze({ ...version }) }
      const intent: TargetIntent = operation === 'apps.quit'
        ? Object.freeze({ ...target, operation, mode: 'graceful' })
        : Object.freeze({ ...target, operation })
      session.proposal = { intent, application: refreshed.application, presentation }
      session.presentation = presentation
      this.#scheduleExpiry(session, this.#lastNow)
      return presentation
    } catch {
      if (!current()) return view(session.active ? 'replaced' : session.presentation.phase, revision)
      if (this.#lastNow >= deadline) { this.#revoke(session, 'deadline'); return session.presentation }
      return this.#set(session, 'unavailable')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
