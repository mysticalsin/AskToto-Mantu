import { AsyncLocalStorage } from 'node:async_hooks'
import type { MemoryAccess, MemoryPartitionChange, MemoryPartitions } from './memory-partitions'

/**
 * The process-wide handle on the memory partitions main configured at boot (Métis 2.12 G19), so the stores that
 * are built before and below the owner-session wiring (the brain store, its caches) can resolve their root without
 * importing it.
 *
 * Until main configures it (unit tests, tools), the memory is the single-owner `.brain/` store. Main configures it
 * in `createOwnerSessionWiring` before any window or IPC handler exists.
 */
let configured: MemoryPartitions | null = null

const UNCONFIGURED: MemoryAccess = { status: 'ok', partitionId: 'legacy', relRoot: '.brain', legacy: true }

export function configureMemoryPartitions(partitions: MemoryPartitions | null): void {
  configured = partitions
}

export function memoryPartitionsConfigured(): boolean {
  return configured !== null
}

/** Synchronous: the partition in force, or the typed reason there is none. */
export function memoryAccess(): MemoryAccess {
  return configured ? configured.access() : UNCONFIGURED
}

/**
 * Like `memoryAccess`, but waits for a pending activation (a sign-in just completed, an owner just changed) and
 * tries once more after an activation that failed (a ledger that could not be written then), instead of staying closed.
 */
export async function resolveMemoryAccess(): Promise<MemoryAccess> {
  if (!configured) return UNCONFIGURED
  const now = configured.access()
  return now.status === 'stale' || now.status === 'unavailable' ? configured.activate() : now
}

export function onMemoryPartitionChange(listener: (change: MemoryPartitionChange) => void): () => void {
  return configured ? configured.onChange(listener) : () => undefined
}

/** The relative root the store uses while memory is closed: it never exists and is never created. */
export const CLOSED_REL_ROOT = '.brain-closed'

/** The store root relative to the meetings folder for the partition in force. */
export function memoryRelRoot(): string {
  const access = memoryAccess()
  return access.status === 'ok' ? access.relRoot : CLOSED_REL_ROOT
}

export class MemoryClosedError extends Error {
  readonly status: Exclude<MemoryAccess['status'], 'ok'>
  constructor(status: Exclude<MemoryAccess['status'], 'ok'>) {
    super(`Local memory is not available (${status}).`)
    this.name = 'MemoryClosedError'
    this.status = status
  }
}

/** The partition a job started under: its writes (and the awaits they run through) are refused once another is in force. */
const pinnedPartition = new AsyncLocalStorage<string>()

/** The partition in force, or null while none is open. */
export function currentPartitionId(): string | null {
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/** Runs `fn` pinned to `partitionId`: every store write inside it must still find that partition in force. */
export function runInPartition<T>(partitionId: string, fn: () => T): T {
  return pinnedPartition.run(partitionId, fn)
}

/**
 * Writes never create or touch a store for an owner that is not verified and active, and a write from work that
 * started under another owner's partition is refused (`stale`), so a job cannot land in a partition it did not start in.
 */
export function assertMemoryOpen(): void {
  const access = memoryAccess()
  if (access.status !== 'ok') throw new MemoryClosedError(access.status)
  const pinned = pinnedPartition.getStore()
  if (pinned !== undefined && pinned !== access.partitionId) throw new MemoryClosedError('stale')
}

let followUpPartition: string | null = null

/**
 * The follow-up conversation memory belongs to the partition it was built under. False once the partition in force
 * is no longer the one the last plain ask ran under (an account switch), so the caller starts the conversation clean.
 */
export function followUpMemoryContinues(): boolean {
  const access = memoryAccess()
  const next = access.status === 'ok' ? access.partitionId : null
  const same = followUpPartition === null || followUpPartition === next
  if (next !== null) followUpPartition = next
  return same && next !== null
}

export function resetMemoryAccessForTests(): void {
  configured = null
  followUpPartition = null
}

/** Evaluates the partition in force now, so a sign-out or an owner change is acted on when it happens, not at the next read. */
export function reconcileMemoryAccess(): void {
  configured?.access()
}
