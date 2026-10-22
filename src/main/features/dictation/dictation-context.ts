/**
 * The session scope the dictation target guard (G07) checks every step against (G22).
 *
 * A dictation belongs to one owner (this device's signed-in person) and to one epoch. Every revocation main
 * knows about (sign-out, lock, suspend, a meeting starting, a renderer reset, the feature being turned off, quit)
 * bumps the epoch, which makes every snapshot taken earlier stale and interrupts the guard synchronously. The guard
 * then refuses to prepare, dispatch or settle anything that began before the revocation.
 */
import { DesktopContractError, type DictationActor, type DictationContext } from '../desktop-contract'

export const DICTATION_ACTOR: DictationActor = Object.freeze({
  tenantId: 'metis-local',
  userId: 'device-owner',
  sessionId: 'dictation'
})

/** The one permission the guard asks for before it begins, revises or dispatches a dictation. */
export const DICTATION_INSERT_PERMISSION = 'dictation.insert'

export class DictationSessionContext implements DictationContext {
  #epoch = 0
  readonly #listeners = new Set<(reason: string) => void>()
  readonly #permitted: () => boolean

  constructor(permitted: () => boolean) {
    this.#permitted = permitted
  }

  assertActor(actor: DictationActor): void {
    if (
      !actor ||
      actor.tenantId !== DICTATION_ACTOR.tenantId ||
      actor.userId !== DICTATION_ACTOR.userId ||
      actor.sessionId !== DICTATION_ACTOR.sessionId
    )
      throw new DesktopContractError('ACTOR')
  }

  snapshot(_outputKind: 'manual'): object {
    return Object.freeze({ epoch: this.#epoch })
  }

  assertCurrent(snapshot: object): void {
    if ((snapshot as { epoch?: number }).epoch !== this.#epoch) throw new DesktopContractError('CONTEXT_CHANGED')
  }

  hasPermissions(required: string[]): boolean {
    return required.every((permission) => permission === DICTATION_INSERT_PERMISSION) && this.#permitted()
  }

  onChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Something main treats as a revocation happened. Synchronous; a throwing listener cannot stop the others. */
  revoke(reason: string): void {
    this.#epoch += 1
    for (const listener of [...this.#listeners]) {
      try {
        listener(reason)
      } catch {
        /* the epoch already moved: stale snapshots fail closed whether or not a listener ran */
      }
    }
  }
}
