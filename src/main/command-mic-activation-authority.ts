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

/**
 * `click` is minted from the preload's trusted button click; `hardware` only by main's voice session and
 * `hardware-dictation` only by main's dictation session (G22). The three never substitute for each other: a voice
 * turn's grant can't start a dictation capture and a dictation grant can't start a voice turn.
 */
export type CommandMicActivationKind = 'click' | 'hardware' | 'hardware-dictation'

interface Grant {
  readonly kind: CommandMicActivationKind
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
    return this.#mint(frame, 'click')
  }

  /**
   * Main-only, never reachable from an IPC handler: a held hardware chord (voice actions) is the user's own
   * activation, observed by main. The frame is main's own window frame, never a renderer message. The grant
   * is consumable only by a push-to-talk command start, so a click grant and a hardware grant never mix. A held
   * dictation chord mints the `hardware-dictation` kind, consumable only by a push-to-talk dictation start.
   */
  mintFromHardware(frame: CommandMicActivationFrame, kind: 'hardware' | 'hardware-dictation' = 'hardware'): boolean {
    return this.#mint(frame, kind)
  }

  hasPending(frame: CommandMicActivationFrame, kind: CommandMicActivationKind = 'click'): boolean {
    const state = this.#state()
    this.#discardInvalid()
    return [...this.#grants.values()].some((grant) => grant.kind === kind && this.#matches(grant, frame, state))
  }

  consume(frame: CommandMicActivationFrame, kind: CommandMicActivationKind = 'click'): boolean {
    const state = this.#state()
    this.#discardInvalid()
    for (const [id, grant] of this.#grants) {
      if (grant.kind !== kind || !this.#matches(grant, frame, state)) continue
      this.#grants.delete(id)
      return true
    }
    return false
  }

  /** A voice or dictation turn ended: its activation must not outlive it. Click grants are untouched. */
  revokeHardware(kind?: 'hardware' | 'hardware-dictation'): void {
    for (const [id, grant] of this.#grants)
      if (grant.kind !== 'click' && (kind === undefined || grant.kind === kind)) this.#grants.delete(id)
  }

  #mint(frame: CommandMicActivationFrame, kind: CommandMicActivationKind): boolean {
    const state = this.#state()
    if (
      !this.#matchesFrame(frame, state) ||
      !state.isWindowVisible ||
      !state.isAuthenticated ||
      !state.isParakeetSelected ||
      !Number.isFinite(this.#now())
    )
      return false
    this.#discardInvalid()
    if ([...this.#grants.values()].some((grant) => grant.kind === kind && this.#matches(grant, frame, state)))
      return true
    this.#grants.set(randomUUID(), {
      kind,
      webContentsId: frame.webContentsId,
      frameId: frame.frameId,
      url: frame.url,
      authSessionGeneration: state.context.authSessionGeneration,
      contextRevision: state.context.contextRevision,
      expiresAt: this.#now() + this.#ttlMs
    })
    return true
  }

  revokeAll(): void {
    this.#grants.clear()
  }

  #matchesFrame(frame: CommandMicActivationFrame, state: CommandMicActivationState): boolean {
    return (
      frame.isTopFrame &&
      frame.webContentsId === state.mainWebContentsId &&
      frame.frameId === state.mainFrameId &&
      !!state.currentUrl &&
      frame.url === state.currentUrl
    )
  }

  #matches(grant: Grant, frame: CommandMicActivationFrame, state: CommandMicActivationState): boolean {
    return (
      this.#matchesFrame(frame, state) &&
      state.isWindowVisible &&
      state.isAuthenticated &&
      state.isParakeetSelected &&
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

export function commandMicOwner(
  frame: CommandMicActivationFrame,
  context: InputSessionContext
): TrustedInputOwner | null {
  if (
    !frame.isTopFrame ||
    !Number.isSafeInteger(frame.webContentsId) ||
    frame.webContentsId <= 0 ||
    !frame.frameId ||
    frame.frameId.length > 256
  )
    return null
  return Object.freeze({
    webContentsId: frame.webContentsId,
    frameId: frame.frameId,
    isTopFrame: true,
    authSessionGeneration: context.authSessionGeneration,
    contextRevision: context.contextRevision
  })
}
