import type { InputSessionContext } from '@shared/input-session'
import { randomUUID } from 'node:crypto'

export const MEETING_START_ACTION = 'meeting.start' as const
export type MeetingStartAction = typeof MEETING_START_ACTION

export interface MeetingStartActivationFrame {
  readonly webContentsId: number
  readonly frameId: string
  readonly isTopFrame: boolean
  readonly url: string
}

export interface MeetingStartActivationState {
  readonly mainWebContentsId: number | null
  readonly mainFrameId: string | null
  readonly isWindowVisible: boolean
  readonly isAuthenticated: boolean
  readonly isStartAllowed: boolean
  readonly currentUrl: string
  readonly context: InputSessionContext
}

interface Grant {
  readonly webContentsId: number
  readonly frameId: string
  readonly action: MeetingStartAction
  readonly authSessionGeneration: number
  readonly contextRevision: number
  readonly url: string
  readonly expiresAt: number
}

/** Main-only, short-lived, single-use authorization for the meeting-start transition. */
export class MeetingStartActivationAuthority {
  readonly #grants = new Map<string, Grant>()
  readonly #state: () => MeetingStartActivationState
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: { state: () => MeetingStartActivationState; now?: () => number; ttlMs?: number }) {
    this.#state = options.state
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? 5_000
  }

  /** Mints from a trusted main/preload event. The grant ID never leaves this object. */
  mint(frame: MeetingStartActivationFrame, action: MeetingStartAction): boolean {
    const state = this.#state()
    if (
      action !== MEETING_START_ACTION ||
      !this.#frameIsCurrent(frame, state) ||
      !state.isWindowVisible ||
      !state.isAuthenticated ||
      !state.isStartAllowed ||
      !Number.isFinite(this.#now())
    )
      return false
    this.#discardInvalid()
    const existing = [...this.#grants.values()].some((grant) => this.#matches(grant, frame, action, state))
    if (existing) return true
    const id = randomUUID()
    this.#grants.set(id, {
      webContentsId: frame.webContentsId,
      frameId: frame.frameId,
      action,
      authSessionGeneration: state.context.authSessionGeneration,
      contextRevision: state.context.contextRevision,
      url: state.currentUrl,
      expiresAt: this.#now() + this.#ttlMs
    })
    return true
  }

  /** Readiness exposes only a boolean; renderer code never receives the main-owned grant ID. */
  hasPending(frame: MeetingStartActivationFrame): boolean {
    const state = this.#state()
    this.#discardInvalid()
    return [...this.#grants.values()].some((grant) => this.#matches(grant, frame, MEETING_START_ACTION, state))
  }

  /** Consume exactly once at the main listening-state transition boundary. */
  consume(frame: MeetingStartActivationFrame, action: MeetingStartAction): boolean {
    const state = this.#state()
    this.#discardInvalid()
    for (const [id, grant] of this.#grants) {
      if (!this.#matches(grant, frame, action, state)) continue
      this.#grants.delete(id)
      return true
    }
    return false
  }

  revokeAll(): void {
    this.#grants.clear()
  }

  #frameIsCurrent(frame: MeetingStartActivationFrame, state: MeetingStartActivationState): boolean {
    return (
      frame.isTopFrame &&
      frame.webContentsId === state.mainWebContentsId &&
      frame.frameId === state.mainFrameId &&
      !!state.currentUrl &&
      frame.url === state.currentUrl
    )
  }

  #matches(
    grant: Grant,
    frame: MeetingStartActivationFrame,
    action: MeetingStartAction,
    state: MeetingStartActivationState
  ): boolean {
    return (
      action === grant.action &&
      this.#frameIsCurrent(frame, state) &&
      state.isWindowVisible &&
      state.isAuthenticated &&
      state.isStartAllowed &&
      grant.webContentsId === frame.webContentsId &&
      grant.frameId === frame.frameId &&
      grant.url === frame.url &&
      grant.authSessionGeneration === state.context.authSessionGeneration &&
      grant.contextRevision === state.context.contextRevision &&
      this.#now() < grant.expiresAt
    )
  }

  #discardInvalid(): void {
    const state = this.#state()
    for (const [id, grant] of this.#grants) {
      const frame: MeetingStartActivationFrame = {
        webContentsId: grant.webContentsId,
        frameId: grant.frameId,
        isTopFrame: true,
        url: grant.url
      }
      if (!this.#matches(grant, frame, grant.action, state)) this.#grants.delete(id)
    }
  }
}
