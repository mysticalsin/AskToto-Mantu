/**
 * Admission for meetings-root fs calls: one cap, two priority lanes and a bounded wait.
 *
 * A read of a cloud-only file can hold its libuv pool thread in the kernel for minutes, and no JavaScript
 * can cancel it. So a permit covers exactly one fs call and comes back only when that call settles;
 * callers give up on their own (deadline or abort) without taking the permit with them.
 *
 * Invariants:
 *   - At most `capacity` permits are out. While a permit is free, nobody waits.
 *   - A returned permit goes to the oldest metadata waiter, else the oldest content waiter, else back to
 *     the free count. Metadata calls are short and drive listings and degraded rows.
 *   - Waiting is bounded: a waiter leaves when its signal aborts, and acquire() refuses at once when
 *     MAX_QUEUED requests wait or every permit is held by a call running STUCK_AFTER_MS or more.
 *   - inUse() counts the permits out, stuck ones included. Every onFree listener runs each time a permit
 *     goes back to the free count, so another pool user (boot work) can share the cap without a permit.
 */
import { mainLog } from '../../logger'

export type Lane = 'metadata' | 'content'

/** 'admitted': the caller holds a permit and must hand it to run() or release(). 'refused': no permit can
 *  be promised. 'ended': the caller's signal aborted first. */
export type AcquireResult = 'admitted' | 'refused' | 'ended'

/** Bounds memory, not latency (each caller's deadline bounds latency): far above the files in one listing
 *  of any measured library. */
export const MAX_QUEUED = 4_096
/** A call still running after this long waits on the network or the kernel, not on the disk. */
const STUCK_AFTER_MS = 2_000

export interface Admission {
  acquire(lane: Lane, signal: AbortSignal): Promise<AcquireResult>
  /** Runs `call` under the permit the caller holds; the permit returns when the call settles. */
  run<T>(call: () => Promise<T>): Promise<T>
  /** Returns the permit the caller holds without running anything. */
  release(): void
  /** How many permits are out now. */
  inUse(): number
  /** Calls `listener` each time a permit goes back to the free count. */
  onFree(listener: () => void): void
}

export function createAdmission(capacity: number): Admission {
  let free = capacity
  const running = new Set<{ startedAt: number }>()
  const waiting: Record<Lane, Array<() => void>> = { metadata: [], content: [] }
  const freeListeners: Array<() => void> = []
  /** performance.now() when acquire() first refused because every permit was stuck; null otherwise. */
  let refusingSince: number | null = null

  function everyPermitStuck(): boolean {
    const now = performance.now()
    return running.size >= capacity && [...running].every((call) => now - call.startedAt >= STUCK_AFTER_MS)
  }

  function refuseWhileStuck(): boolean {
    if (!everyPermitStuck()) return false
    if (refusingSince === null) {
      refusingSince = performance.now()
      mainLog.warn('[storage] every permit is held by a stalled call; meetings-root requests are degraded', { capacity })
    }
    return true
  }

  function release(): void {
    const next = waiting.metadata.shift() ?? waiting.content.shift()
    if (next) {
      next()
      return
    }
    free += 1
    for (const listener of freeListeners) listener()
  }

  function acquire(lane: Lane, signal: AbortSignal): Promise<AcquireResult> {
    if (signal.aborted) return Promise.resolve('ended')
    if (free > 0) {
      free -= 1
      return Promise.resolve('admitted')
    }
    if (refuseWhileStuck() || waiting.metadata.length + waiting.content.length >= MAX_QUEUED) {
      return Promise.resolve('refused')
    }
    const queue = waiting[lane]
    return new Promise((resolve) => {
      function admit(): void {
        signal.removeEventListener('abort', leave)
        resolve('admitted')
      }
      function leave(): void {
        queue.splice(queue.indexOf(admit), 1)
        resolve('ended')
      }
      queue.push(admit)
      signal.addEventListener('abort', leave, { once: true })
    })
  }

  function run<T>(call: () => Promise<T>): Promise<T> {
    const entry = { startedAt: performance.now() }
    running.add(entry)
    return new Promise<T>((resolve) => resolve(call())).finally(() => {
      running.delete(entry)
      if (refusingSince !== null) {
        mainLog.info('[storage] a stalled call settled; admission resumed', {
          degradedMs: Math.round(performance.now() - refusingSince)
        })
        refusingSince = null
      }
      release()
    })
  }

  return {
    acquire,
    run,
    release,
    inUse: () => capacity - free,
    onFree: (listener) => void freeListeners.push(listener)
  }
}
