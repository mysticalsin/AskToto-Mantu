import type { MemoryScope, RecallStatus } from '@shared/contracts/memory-partition'
import {
  LEGACY_PARTITION,
  loadLedger,
  ownsLegacy,
  partitionRefFor,
  saveLedger,
  type LedgerIo,
  type PartitionLedger,
  type PartitionRef
} from './partition-ledger'

/** Who the local memory belongs to right now, as the trusted owner-session authority sees it. */
export type MemoryIdentity =
  | { kind: 'signed-out' }
  /** Signed in, but the tenant or the per-install key is not available, so no owner can be proven. */
  | { kind: 'unverified' }
  /** This installation has no sign-in at all (auth is not configured), so there is no other owner to protect. */
  | { kind: 'local-unsigned' }
  | { kind: 'verified'; scope: MemoryScope }

/** Which partition may be read. `locked` and `partition-empty` are findings about the store itself (brain/recall-status.ts). */
export type MemoryAccess =
  | { status: 'ok'; partitionId: string; relRoot: string; legacy: boolean }
  | { status: Exclude<RecallStatus, 'ok' | 'locked' | 'partition-empty'> }

export interface MemoryPartitionChange {
  /** The partition that was in force (`legacy` or an id), or null when none was. */
  from: string | null
  to: string | null
}

export interface MemoryPartitionsDeps {
  source: { identity(): MemoryIdentity }
  ledger: LedgerIo
  /** The owner key an earlier build remembered for the unclaimed data; read once, when the ledger first loads. */
  legacyOwnerHint?(): Promise<string | null>
  now?(): number
  /** An outcome token only: never a key, an id or a path. */
  audit?(event: 'memory.partition_adopted', detail: Record<string, never>): void
}

export interface MemoryPartitions {
  /** Synchronous and cheap. Refuses (with a typed status) rather than answering from a partition that is not the owner's. */
  access(): MemoryAccess
  /** Resolves the verified owner's partition, recording the one-time adoption of the existing data. Never rejects. */
  activate(): Promise<MemoryAccess>
  onChange(listener: (change: MemoryPartitionChange) => void): () => void
}

const identityKey = (identity: MemoryIdentity): string =>
  identity.kind === 'verified' ? `v:${identity.scope.tenantKey}:${identity.scope.ownerKey}` : identity.kind

const accessOf = (ref: PartitionRef): MemoryAccess => ({
  status: 'ok',
  partitionId: ref.id,
  relRoot: ref.relRoot,
  legacy: ref.legacy
})

export function createMemoryPartitions(deps: MemoryPartitionsDeps): MemoryPartitions {
  const now = deps.now ?? Date.now
  const listeners = new Set<(change: MemoryPartitionChange) => void>()
  let ledger: PartitionLedger | null = null
  let hint: string | null = null
  let active: { key: string; ref: PartitionRef } | null = null
  let failedKey: string | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const pending = new Map<string, Promise<MemoryAccess>>()

  const emit = (change: MemoryPartitionChange): void => {
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch {
        // a throwing listener must not stop the others or the switch
      }
    }
  }

  const setActive = (next: { key: string; ref: PartitionRef } | null): void => {
    const from = active?.ref.id ?? null
    active = next
    const to = next?.ref.id ?? null
    if (from !== to) emit({ from, to })
  }

  /** The answer that needs no ledger: nobody verified. Null when the ledger decides. */
  const immediate = (identity: MemoryIdentity): MemoryAccess | null => {
    if (identity.kind === 'signed-out') return { status: 'signed-out' }
    if (identity.kind === 'unverified') return { status: 'unavailable' }
    return null
  }

  const resolve = async (identity: MemoryIdentity, key: string): Promise<MemoryAccess> => {
    if (!ledger) {
      const loaded = await loadLedger(deps.ledger)
      if (!loaded.ok) {
        failedKey = key
        return { status: 'unavailable' }
      }
      ledger = loaded.ledger
      try {
        hint = (await deps.legacyOwnerHint?.()) ?? null
      } catch {
        hint = null
      }
    }
    let ref: PartitionRef
    if (identity.kind === 'local-unsigned') {
      if (ledger.legacy.state !== 'unclaimed') return { status: 'signed-out' }
      ref = LEGACY_PARTITION
    } else if (identity.kind !== 'verified') {
      return { status: 'unavailable' }
    } else if (ownsLegacy(ledger, identity.scope)) {
      ref = LEGACY_PARTITION
    } else if (ledger.legacy.state === 'adopted' || (hint !== null && hint !== identity.scope.ownerKey)) {
      // Someone else adopted the existing data, or an earlier build remembered someone else as its owner.
      ref = partitionRefFor(identity.scope)
    } else {
      const next: PartitionLedger = {
        v: 1,
        legacy: {
          state: 'adopted',
          tenantKey: identity.scope.tenantKey,
          ownerKey: identity.scope.ownerKey,
          adoptedAt: now()
        }
      }
      // The claim is durable before the data is used under it.
      if (!(await saveLedger(deps.ledger, next))) {
        failedKey = key
        return { status: 'unavailable' }
      }
      ledger = next
      deps.audit?.('memory.partition_adopted', {})
      ref = LEGACY_PARTITION
    }
    failedKey = null
    // The owner may have changed while the ledger was being read or written: never activate a scope that is gone.
    if (identityKey(deps.source.identity()) !== key) return { status: 'stale' }
    setActive({ key, ref })
    return accessOf(ref)
  }

  const activate = (): Promise<MemoryAccess> => {
    const identity = deps.source.identity()
    const refused = immediate(identity)
    if (refused) {
      setActive(null)
      return Promise.resolve(refused)
    }
    const key = identityKey(identity)
    if (active?.key === key) return Promise.resolve(accessOf(active.ref))
    const inflight = pending.get(key)
    if (inflight) return inflight
    const run = queue
      .then(() => resolve(identity, key))
      .catch((): MemoryAccess => {
        failedKey = key
        return { status: 'unavailable' }
      })
      .finally(() => {
        pending.delete(key)
      })
    pending.set(key, run)
    queue = run
    return run
  }

  return {
    access() {
      const identity = deps.source.identity()
      const refused = immediate(identity)
      if (refused) {
        setActive(null)
        return refused
      }
      const key = identityKey(identity)
      if (active?.key === key) return accessOf(active.ref)
      setActive(null) // the partition that was in force is not this owner's
      if (failedKey === key) return { status: 'unavailable' }
      void activate()
      return { status: 'stale' }
    },
    activate,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
