import {
  InterventionError,
  type InterventionContext,
  type InterventionScope,
  type InterventionSnapshotRef
} from '@shared/intervention-contract'

/** A card snapshot: the renderer-local scope plus the generation and context revision it was issued at. */
export type AskCardSnapshot = InterventionSnapshotRef

let contextSeq = 0

/**
 * The renderer's own InterventionContext for suggestion cards (G71). It only answers "is this swap still
 * the live one in this hook?": every visible change that must forbid a late rollback (clear, cancel, fail,
 * a non-suggestion ask, unmount) calls `invalidate`, which makes every earlier snapshot stale. The scope is
 * renderer-local identity only; real owner and tenant scoping stays in main.
 */
export class AskCardContext implements InterventionContext<AskCardSnapshot> {
  readonly scope: InterventionScope
  private generation = 0
  private contextRevision = 1
  private readonly issued = new WeakSet<object>()
  private readonly listeners = new Set<(reason: string) => void>()

  constructor() {
    contextSeq += 1
    this.scope = Object.freeze({ tenantId: 'local', userId: 'local', sessionId: `cards-${contextSeq}` })
  }

  issue(): AskCardSnapshot {
    this.generation += 1
    const snapshot = Object.freeze({
      scope: this.scope,
      generation: this.generation,
      contextRevision: this.contextRevision
    })
    this.issued.add(snapshot)
    return snapshot
  }

  invalidate(reason: string): void {
    this.contextRevision += 1
    for (const listener of [...this.listeners]) listener(reason)
  }

  onChange(listener: (reason: string) => void): () => boolean {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  assertCurrent(snapshot: AskCardSnapshot): void {
    if (!snapshot || !this.issued.has(snapshot)) throw new InterventionError('SCOPE_MISMATCH')
    if (snapshot.contextRevision !== this.contextRevision) throw new InterventionError('INTERVENTION_DISPOSED')
  }

  isCurrent(snapshot: AskCardSnapshot): boolean {
    try {
      this.assertCurrent(snapshot)
      return true
    } catch {
      return false
    }
  }
}
