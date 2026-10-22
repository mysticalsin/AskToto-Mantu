import { app } from 'electron'
import { authSessionGeneration, authStatus, requireAuth } from '../auth'
import { ownerRecordStore } from '../credential-account-switch'
import { clearHistoryReadCache } from '../history-read'
import { resetDustConversation } from '../llm/dust'
import { auditLog } from '../logger'
import { bootMemoryPartitions, type MemoryPartitionBootDeps } from '../memory-partition/boot'
import type { MemoryPartitions } from '../memory-partition/memory-partitions'
import { fileLedgerIo } from '../memory-partition/partition-ledger'

/** Main's wiring. Called from `createOwnerSessionWiring`, before any window or IPC handler exists. */
export function bootMainMemoryPartitions(ownerSession: MemoryPartitionBootDeps['ownerSession']): MemoryPartitions {
  const userData = app.getPath('userData')
  const remembered = ownerRecordStore(userData)
  const partitions = bootMemoryPartitions({
    ownerSession,
    authGeneration: authSessionGeneration,
    signedIn: () => authStatus().signedIn,
    unsignedAllowed: () => requireAuth(),
    ledger: fileLedgerIo(userData),
    legacyOwnerHint: () => remembered.read(),
    audit: (event, detail) => auditLog(event, detail),
    onPartitionChange: () => {
      // The follow-up conversation and the decrypted History text belong to the owner they were built for.
      resetDustConversation()
      clearHistoryReadCache()
    }
  })
  void partitions.activate() // a restored session resolves its partition before the first read
  return partitions
}
