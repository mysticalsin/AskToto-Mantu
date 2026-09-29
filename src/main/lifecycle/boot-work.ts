/**
 * Boot work that first paint does not need (meetings-folder setup, import recovery, the brain resume and
 * index loads). M2-0031: run all at once at launch, these jobs filled the libuv pool while the window was
 * being built, so an async userData write waited behind them.
 *
 * Invariants:
 *   - No job starts before the gate opens: the boot window's first show, or `fallbackMs` if it never shows.
 *   - Every job starts in a task of its own, never in the task that queued it or opened the gate.
 *   - Jobs in flight plus the storage gateway's permits out stay under `limit` (poolSize - 2 by default, the
 *     gateway's cap) whenever a job starts, so boot work and meetings-root reads pinned by a cloud file or a FIFO
 *     together leave two pool threads free for userData writes, dns.lookup and crypto (M2-0433). While the
 *     gateway holds the whole cap, no job starts; the next one starts once a permit returns. A job leaves the
 *     count when its promise settles, or after `holdMs`, so one long job (a model pass) never starves the ones
 *     queued behind it.
 *   - Jobs start in the order they were queued. A job that throws or rejects is logged and the queue goes on.
 */
import type { Admission } from '../infra/storage/admission'
import { reservedPoolCapacity } from '../infra/storage/gateway'
import { storageAdmission } from '../infra/storage/meetings-storage'
import { mainLog } from '../logger'

/** The slice of BrowserWindow the gate reads. */
export interface BootWorkWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  once(event: 'show', listener: () => void): unknown
}

export interface BootWorkOptions {
  limit?: number
  holdMs?: number
  fallbackMs?: number
  /** The admission whose permits count against `limit`; the meetings-storage admission by default. */
  pool?: Pick<Admission, 'inUse' | 'onFree'>
}

export interface BootWork {
  /** Queues `job`; it runs under the invariants above. */
  run(name: string, job: () => unknown): void
  /** Opens the gate when `win` shows. A missing, destroyed or already visible window opens it at once. */
  releaseAfterFirstShow(win: BootWorkWindow | null | undefined): void
}

/** A boot fs job settles in seconds; past this it is doing its own long work, not the launch burst. */
const HOLD_MS = 10_000
/** Same bound as the tray's first-paint fallback (boot-tray.ts). */
const FALLBACK_MS = 5_000

export function createBootWork(options: BootWorkOptions = {}): BootWork {
  const limit = Math.max(1, options.limit ?? reservedPoolCapacity())
  const holdMs = options.holdMs ?? HOLD_MS
  const fallbackMs = options.fallbackMs ?? FALLBACK_MS
  const pool = options.pool ?? storageAdmission()
  const queue: Array<{ name: string; job: () => unknown }> = []
  let released = false
  let inFlight = 0
  let startScheduled = false
  let fallback: ReturnType<typeof setTimeout> | undefined

  const failed = (name: string, error: unknown): void => {
    mainLog.warn(`[boot] ${name} failed:`, error)
  }

  const hasRoom = (): boolean => inFlight + pool.inUse() < limit

  const startNext = (): void => {
    startScheduled = false
    // The gateway may have taken a permit since pump(); its next return pumps again.
    if (!hasRoom()) return
    const next = queue.shift()
    if (!next) return
    inFlight++
    let done = false
    const hold = setTimeout(() => finish(), holdMs)
    hold.unref?.()
    function finish(): void {
      if (done) return
      done = true
      clearTimeout(hold)
      inFlight--
      pump()
    }
    try {
      Promise.resolve(next.job())
        .catch((error: unknown) => failed(next.name, error))
        .finally(finish)
    } catch (error) {
      failed(next.name, error)
      finish()
    }
    pump()
  }

  function pump(): void {
    if (!released || startScheduled || !hasRoom() || queue.length === 0) return
    startScheduled = true
    setImmediate(startNext)
  }

  pool.onFree(pump)

  const release = (): void => {
    if (released) return
    released = true
    if (fallback !== undefined) clearTimeout(fallback)
    pump()
  }

  return {
    run(name, job) {
      queue.push({ name, job })
      pump()
    },
    releaseAfterFirstShow(win) {
      if (!win || win.isDestroyed() || win.isVisible()) {
        release()
        return
      }
      win.once('show', release)
      fallback = setTimeout(release, fallbackMs)
      fallback.unref?.()
    }
  }
}
