import type { SealedScope } from '../infra/storage/sealed-scoped-store'
import { memoryAccess, memoryPartitionsConfigured } from '../memory-partition/memory-access'

export interface OwnerPartitionScopeDeps {
  ownerSession: { currentOwnerKey(): string | null; currentTenantKey(): string | null }
  /** Defaults to G19's partition in force; a test seam. */
  partition?(): string | null
}

/** G19's partition in force: its id, or null while none is open (signed out, unverified, a switch in flight). */
function activePartition(): string | null {
  if (!memoryPartitionsConfigured()) return null
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/**
 * The scope every owner-sealed store reads under: the partition in force plus the verified owner and tenant keys, or
 * null when any of the three is missing (so a call is refused as signed out). Shared by the assistant and conversation
 * wirings so there is one partition resolver.
 */
export function ownerPartitionScope(deps: OwnerPartitionScopeDeps): () => SealedScope | null {
  const partition = deps.partition ?? activePartition
  return () => {
    const partitionId = partition()
    const ownerKey = deps.ownerSession.currentOwnerKey()
    const tenantKey = deps.ownerSession.currentTenantKey()
    return partitionId && ownerKey && tenantKey ? { partitionId, ownerKey, tenantKey } : null
  }
}
