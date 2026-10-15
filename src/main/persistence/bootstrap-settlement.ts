import type { ProtectedKeyHandle, ProtectedMeetingKeys } from './protected-meeting-keys'
import type { RootRegistry, OpaqueOperationScope, OwnedMeetingRoot, WriterLease } from './root-registry'
import type { createIncrementalMeetingJournalFileStorage } from '../features/meetings/incremental-meeting-journal-files'

type JournalStorage = NonNullable<ReturnType<typeof createIncrementalMeetingJournalFileStorage>>

export interface BootstrapSettlementOwner {
  readonly scope: OpaqueOperationScope
  readonly root: OwnedMeetingRoot
  readonly pending: Set<Promise<unknown>>
  writer?: WriterLease
  key?: ProtectedKeyHandle
  storage?: JournalStorage
  disposed: boolean
  track<T>(operation: Promise<T>): Promise<T>
  settle(): Promise<void>
}

export function createPendingOperationTracker() {
  const pending = new Set<Promise<unknown>>()
  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation)
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    )
    return operation
  }
  return { pending, track }
}

export function createBootstrapSettlementOwner(
  roots: RootRegistry,
  keys: ProtectedMeetingKeys,
  scope: OpaqueOperationScope,
  root: OwnedMeetingRoot,
  onSettled: (owner: BootstrapSettlementOwner) => void
): BootstrapSettlementOwner {
  const pending = new Set<Promise<unknown>>()
  let settlement: Promise<void> | undefined
  const owner: BootstrapSettlementOwner = {
    scope,
    root,
    pending,
    disposed: false,
    track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation)
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation)
      )
      return operation
    },
    settle(): Promise<void> {
      if (settlement) return settlement
      if (owner.disposed) return Promise.resolve()
      settlement = (async () => {
        owner.disposed = true
        owner.key && keys.retire(owner.key)
        roots.retire(root)
        // Settled append refusals are operation results. Their rejection does not imply a live FD.
        while (pending.size > 0) await Promise.allSettled([...pending])
        const failures: unknown[] = []
        try {
          owner.storage?.dispose()
        } catch (error) {
          failures.push(error)
        }
        if (owner.key) {
          try {
            await keys.settleAndDispose(owner.key)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) {
          if (failures.length === 1) throw failures[0]
          throw new AggregateError(failures, 'Persistence storage and key settlement failed')
        }
        if (owner.writer) await owner.writer.release()
        await roots.closeRoot(scope, root)
        onSettled(owner)
      })()
      return settlement
    }
  }
  return owner
}

export function combineSettlementErrors(operationError: unknown, settlementError: unknown): AggregateError {
  const leaves = (error: unknown): unknown[] =>
    error instanceof AggregateError ? Array.from(error.errors).flatMap(leaves) : [error]
  const errors: unknown[] = []
  for (const error of [...leaves(operationError), ...leaves(settlementError)])
    if (!errors.includes(error)) errors.push(error)
  return new AggregateError(errors, 'Persistence operation and cleanup both failed')
}
