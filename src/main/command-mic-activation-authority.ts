import { randomUUID } from 'node:crypto'
import type { InputSessionContext, TrustedInputOwner } from '@shared/input-session'

export const COMMAND_MIC_CAPTURE_ACTION = 'command.mic.capture' as const
export interface CommandMicActivationFrame {
  readonly webContentsId: number
  readonly frameId: string
  readonly isTopFrame: boolean
  readonly url: string
}

export interface CommandMicActivationState {
  readonly mainWebContentsId: number | null
  readonly mainFrameId: string | null
  readonly currentUrl: string
  readonly isWindowVisible: boolean
  readonly isAuthenticated: boolean
  readonly isParakeetSelected: boolean
  readonly context: InputSessionContext
}

interface Grant {
  readonly webContentsId: number
  readonly frameId: string
  readonly url: string
  readonly authSessionGeneration: number
  readonly contextRevision: number
  readonly expiresAt: number
}

/** Main-only single-use authority minted from the isolated preload's trusted button click. */
export class CommandMicActivationAuthority {
  readonly #grants = new Map<string, Grant>()
  readonly #state: () => CommandMicActivationState
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: { state: () => CommandMicActivationState; now?: () => number; ttlMs?: number }) {
    this.#state = options.state
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? 5_000
  }

  mint(frame: CommandMicActivationFrame): boolean {
    const state = this.#state()
    if (!this.#matchesFrame(frame, state) || !state.isWindowVisible || !state.isAuthenticated ||
        !state.isParakeetSelected || !Number.isFinite(this.#now())) return false
    this.#discardInvalid()
    if ([...this.#grants.values()].some((grant) => this.#matches(grant, frame, state))) return true
    this.#grants.set(randomUUID(), {
      webContentsId: frame.webContentsId,
      frameId: frame.frameId,
      url: frame.url,
      authSessionGeneration: state.context.authSessionGeneration,
      contextRevision: state.context.contextRevision,
      expiresAt: this.#now() + this.#ttlMs
    })
    return true
  }

  hasPending(frame: CommandMicActivationFrame): boolean {
    const state = this.#state()
    this.#discardInvalid()
    return [...this.#grants.values()].some((grant) => this.#matches(grant, frame, state))
  }

  consume(frame: CommandMicActivationFrame): boolean {
    const state = this.#state()
    this.#discardInvalid()
    for (const [id, grant] of this.#grants) {
      if (!this.#matches(grant, frame, state)) continue
      this.#grants.delete(id)
      return true
    }
    return false
  }

  revokeAll(): void { this.#grants.clear() }

  #matchesFrame(frame: CommandMicActivationFrame, state: CommandMicActivationState): boolean {
    return frame.isTopFrame && frame.webContentsId === state.mainWebContentsId &&
      frame.frameId === state.mainFrameId && !!state.currentUrl && frame.url === state.currentUrl
  }

  #matches(grant: Grant, frame: CommandMicActivationFrame, state: CommandMicActivationState): boolean {
    return this.#matchesFrame(frame, state) && state.isWindowVisible && state.isAuthenticated && state.isParakeetSelected &&
      grant.webContentsId === frame.webContentsId && grant.frameId === frame.frameId && grant.url === frame.url &&
      grant.authSessionGeneration === state.context.authSessionGeneration &&
      grant.contextRevision === state.context.contextRevision && this.#now() < grant.expiresAt
  }

  #discardInvalid(): void {
    const state = this.#state()
    for (const [id, grant] of this.#grants) {
      const frame: CommandMicActivationFrame = {
        webContentsId: grant.webContentsId,
        frameId: grant.frameId,
        isTopFrame: true,
        url: grant.url
      }
      if (!this.#matches(grant, frame, state)) this.#grants.delete(id)
    }
  }
}

export function commandMicOwner(frame: CommandMicActivationFrame, context: InputSessionContext): TrustedInputOwner | null {
  if (!frame.isTopFrame || !Number.isSafeInteger(frame.webContentsId) || frame.webContentsId <= 0 ||
      !frame.frameId || frame.frameId.length > 256) return null
  return Object.freeze({
    webContentsId: frame.webContentsId,
    frameId: frame.frameId,
    isTopFrame: true,
    authSessionGeneration: context.authSessionGeneration,
    contextRevision: context.contextRevision
  })
}
