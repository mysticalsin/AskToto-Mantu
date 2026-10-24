import { isErasureFenced } from '../memory-partition/erasure-fence'
import { currentPartitionId, runInPartition } from '../memory-partition/memory-access'

/** Callbacks a queued job carries (live-save admission fences and receipt joins). Shared shape of `Job` in ingest.ts. */
export interface JobHooks {
  admissionChecks?: Array<() => void>
  settledCallbacks?: Array<() => void>
}

/** The memory partition each queued job was queued under (G19); null when none was open. Absent = not partition-bound. */
const queuedUnder = new WeakMap<object, string | null>()
/** When each queued job was enqueued (G82: the erasure fence compares it with the time the owner erased). */
const queuedAt = new WeakMap<object, number>()

export function jobPartition(job: object): string | null | undefined {
  return queuedUnder.get(job)
}

/** Queues jobs, stamping each with the partition in force: a job never outlives the owner that started it. */
export function enqueueJobs<J extends JobHooks>(queue: J[], jobs: readonly J[], now: () => number = Date.now): void {
  const partitionId = currentPartitionId()
  for (const job of jobs) {
    if (queuedUnder.has(job)) continue
    queuedUnder.set(job, partitionId)
    queuedAt.set(job, now())
  }
  queue.push(...jobs)
}

/** Runs a job's store effects pinned to its partition, so a switch mid-job refuses every later write. */
export function runJobInPartition<T>(job: JobHooks, fn: () => Promise<T>): Promise<T> {
  const partitionId = queuedUnder.get(job)
  return partitionId ? runInPartition(partitionId, fn) : fn()
}

export function isJobAdmissionOpen(job: JobHooks): boolean {
  const partitionId = queuedUnder.get(job)
  if (partitionId !== undefined && (partitionId === null || partitionId !== currentPartitionId())) return false
  // G82: a job queued before the owner erased their data writes nothing into the (re-created) brain.
  const enqueuedAt = queuedAt.get(job)
  if (enqueuedAt !== undefined && partitionId && isErasureFenced(enqueuedAt, partitionId)) return false
  for (const check of job.admissionChecks ?? []) {
    try {
      check()
    } catch {
      return false
    }
  }
  return true
}

export function settleJobCallbacks(job: JobHooks): void {
  for (const callback of job.settledCallbacks ?? []) {
    try {
      callback()
    } catch {
      /* receipt settlement cannot fail ingest cleanup */
    }
  }
  job.settledCallbacks = []
}
