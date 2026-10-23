import type { ConnectorOperation } from '@shared/connector-catalog'

export interface CatalogSnapshot {
  readonly revision: number
  readonly operations: readonly ConnectorOperation[]
}

export interface CatalogPublisher {
  current(): CatalogSnapshot
  /** Accepts only a strictly greater revision. Returns whether it was accepted. */
  publish(next: CatalogSnapshot): boolean
  subscribe(listener: (snapshot: CatalogSnapshot) => void): () => void
}

/** Main-side publication point for the catalog revision. Consumers read `current()` at execution time, never a cache. */
export function createCatalogPublisher(initial: CatalogSnapshot): CatalogPublisher {
  let snapshot: CatalogSnapshot = { revision: initial.revision, operations: [...initial.operations] }
  const listeners = new Set<(s: CatalogSnapshot) => void>()
  return {
    current: () => snapshot,
    publish(next) {
      if (!Number.isInteger(next.revision) || next.revision <= snapshot.revision) return false
      snapshot = { revision: next.revision, operations: [...next.operations] }
      for (const listener of [...listeners]) {
        try {
          listener(snapshot)
        } catch {
          /* a listener must not block publication */
        }
      }
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
