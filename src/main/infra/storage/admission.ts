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
 *   - Waiters already queued when every permit turns stuck are refused at that moment too. Otherwise a
 *     request that queued while the blocking calls were still young sat out its own deadline (2 s for a
 *     listing, History's whole degraded-view budget) while every later request was refused at once: the
 *     ~2 s first History call of a stalled meetings root.
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
}

/** A queued request: handed a permit, or refused when every permit turns stuck. */
interface Waiter {
  admit(): void
  refuse(): void
}

export function createAdmission(capacity: number): Admission {
  let free = capacity
  const running = new Set<{ startedAt: number }>()
  const waiting: Record<Lane, Waiter[]> = { metadata: [], content: [] }
  /** performance.now() when acquire() first refused because every permit was stuck; null otherwise. */
  let refusingSince: number | null = null
  /** Fires when the youngest running call turns stuck while requests wait; null when not armed. */
  let stuckTimer: ReturnType<typeof setTimeout> | null = null

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

  function waiters(): number {
    return waiting.metadata.length + waiting.content.length
  }

  /** Arms stuckTimer for the moment every permit's call will have run STUCK_AFTER_MS, if requests wait. */
  function watchQueue(): void {
    if (stuckTimer !== null || waiters() === 0 || running.size < capacity) return
    const youngest = Math.max(...[...running].map((call) => call.startedAt))
    stuckTimer = setTimeout(refuseQueuedIfStuck, Math.max(0, youngest + STUCK_AFTER_MS - performance.now()))
    stuckTimer.unref?.()
  }

  function refuseQueuedIfStuck(): void {
    stuckTimer = null
    if (waiters() === 0) return
    if (!refuseWhileStuck()) return watchQueue()
    for (const waiter of [...waiting.metadata.splice(0), ...waiting.content.splice(0)]) waiter.refuse()
  }

  function release(): void {
    const next = waiting.metadata.shift() ?? waiting.content.shift()
    if (next) next.admit()
    else free += 1
  }

  function acquire(lane: Lane, signal: AbortSignal): Promise<AcquireResult> {
    if (signal.aborted) return Promise.resolve('ended')
    if (free > 0) {
      free -= 1
      return Promise.resolve('admitted')
    }
    if (refuseWhileStuck() || waiters() >= MAX_QUEUED) {
      return Promise.resolve('refused')
    }
    const queue = waiting[lane]
    return new Promise((resolve) => {
      function answer(result: AcquireResult): void {
        signal.removeEventListener('abort', leave)
        resolve(result)
      }
      const waiter: Waiter = { admit: () => answer('admitted'), refuse: () => answer('refused') }
      function leave(): void {
        queue.splice(queue.indexOf(waiter), 1)
        resolve('ended')
      }
      queue.push(waiter)
      signal.addEventListener('abort', leave, { once: true })
      watchQueue()
    })
  }

  function run<T>(call: () => Promise<T>): Promise<T> {
    const entry = { startedAt: performance.now() }
    running.add(entry)
    watchQueue()
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

  return { acquire, run, release }
}
