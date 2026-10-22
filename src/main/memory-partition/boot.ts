import { configureMemoryPartitions } from './memory-access'
import {
  createMemoryPartitions,
  type MemoryIdentity,
  type MemoryPartitionChange,
  type MemoryPartitions
} from './memory-partitions'
import type { LedgerIo } from './partition-ledger'

export interface MemoryPartitionBootDeps {
  ownerSession: {
    currentOwnerKey(): string | null
    currentTenantKey(): string | null
  }
  authGeneration(): number
  /** Lets a restored session whose tenant is not known yet become verifiable (see auth-session-tenant.ts). */
  settleIdentity?(): Promise<void>
  signedIn(): boolean
  /** True when no sign-in is required on this installation (authentication is not configured). */
  unsignedAllowed(): boolean
  ledger: LedgerIo
  legacyOwnerHint(): Promise<string | null>
  audit(event: 'memory.partition_adopted', detail: Record<string, never>): void
  /** The conversation and cache carriers that must not outlive the partition they were built under. */
  onPartitionChange(change: MemoryPartitionChange): void
}

/** How long a "nobody is verified" answer is reused: the sign-in configuration can change without a new session. */
export const UNVERIFIED_IDENTITY_TTL_MS = 1000

/**
 * The trusted identity of the local memory (Métis 2.12 G19): the verified tenant and user keys of the owner-session
 * authority. This is asked on every path the store builds, so a verified identity is derived once per sign-in
 * generation (a new session of any owner advances it), and the cheap "nobody is signed in" answers are re-read
 * at most once a second.
 */
export function memoryIdentitySource(
  deps: Pick<MemoryPartitionBootDeps, 'ownerSession' | 'authGeneration' | 'signedIn' | 'unsignedAllowed'> & {
    now?(): number
  }
): () => MemoryIdentity {
  const now = deps.now ?? Date.now
  let cached: { generation: number; at: number; identity: MemoryIdentity } | null = null
  return () => {
    const generation = deps.authGeneration()
    if (
      cached?.generation === generation &&
      (cached.identity.kind === 'verified' || now() - cached.at < UNVERIFIED_IDENTITY_TTL_MS)
    )
      return cached.identity
    cached = null
    let identity: MemoryIdentity
    if (!deps.signedIn()) {
      identity = deps.unsignedAllowed() ? { kind: 'local-unsigned' } : { kind: 'signed-out' }
    } else {
      const ownerKey = deps.ownerSession.currentOwnerKey()
      const tenantKey = deps.ownerSession.currentTenantKey()
      // Not cached while a key is missing (the per-install salt loads in the background): the next read tries again.
      if (!ownerKey || !tenantKey) return { kind: 'unverified' }
      identity = { kind: 'verified', scope: { tenantKey, ownerKey } }
    }
    cached = { generation, at: now(), identity }
    return identity
  }
}

/** Creates the partitions, makes them the process-wide memory authority and wires the reset of what they scope. */
export function bootMemoryPartitions(deps: MemoryPartitionBootDeps): MemoryPartitions {
  const partitions = createMemoryPartitions({
    source: { identity: memoryIdentitySource(deps), settle: deps.settleIdentity },
    ledger: deps.ledger,
    legacyOwnerHint: deps.legacyOwnerHint,
    audit: deps.audit
  })
  partitions.onChange(deps.onPartitionChange)
  configureMemoryPartitions(partitions)
  return partitions
}
