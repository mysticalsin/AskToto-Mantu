/**
 * stall-monitor.ts — detect a main-process event-loop stall long enough to explain a frozen UI.
 *
 * The freeze root cause (spindump-verified, ticket M2-0006): a main-thread JS timer runs a synchronous fs
 * read against a OneDrive placeholder file, and the kernel blocks the whole event loop for as long as the
 * file takes to materialize — tray, hotkeys, IPC and `activate`/reopen all stop for that long. A blocked
 * event loop cannot log anything about itself while it is blocked; the only observable trace is the NEXT
 * tick of an otherwise-regular timer firing very late. This module runs a 1 s heartbeat and reports any
 * tick that fires at least one full tick period late, plus a `monitorEventLoopDelay` p99 summary every
 * 5 minutes so shorter stalls that never trip the heartbeat are still visible.
 *
 * Lateness is measured on `performance.now()` (a monotonic clock), never on `Date.now()` (the wall
 * clock): a lid-close/sleep or an NTP step moves the wall clock without the event loop having stalled at
 * all, which would otherwise manufacture a fake `app.stall` whose `durationMs` equals the sleep length or
 * the clock step and corrupts the "brief stall vs wedge" evidence this module exists to produce. Some
 * platforms' monotonic clock keeps counting through sleep regardless, which would report the sleep gap
 * itself as one giant stall. `pause()`/`resync()` handle that case and are order-independent by
 * construction: call `pause()` from Electron's `powerMonitor` `'suspend'` event — this clears the
 * heartbeat entirely, so there is no tick left pending to race `'resume'` no matter which of the two the
 * event loop happens to process first — and call `resync()` from `'resume'`, which re-arms the schedule
 * from the current tick and restarts the heartbeat if `pause()` had stopped it.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

/** A minimal, injectable stand-in for Node's `IntervalHistogram` — only the methods this module uses. */
export interface EventLoopHistogram {
  enable(): boolean
  disable(): boolean
  reset(): void
  /** Nanoseconds, per Node's own histogram contract. */
  percentile(percentile: number): number
}

/** One heartbeat tick that arrived at least one full tick period late. */
export interface StallDetail {
  bootId: string
  /** How much later than scheduled this tick fired, in ms. Always >= the configured tickMs — the real
   *  stall understates by up to one tick period, since lateness is only observable from the next tick. */
  durationMs: number
  /** The operation `setPhase` recorded since the previous tick, or `undefined` when none was set, or an
   *  intervening on-time tick already consumed it. Every tick — late or not — reads this and clears it, so
   *  a stall never names an operation that had already finished before the stall began. */
  phase: string | undefined
}

/** Periodic p99 event-loop-delay report, independent of whether any single tick tripped the heartbeat. */
export interface StallSummaryDetail {
  bootId: string
  p99Ms: number
}

export interface StallMonitorOptions {
  bootId: string
  onStall: (detail: StallDetail) => void
  onSummary: (detail: StallSummaryDetail) => void
  /** Heartbeat period, ms. Default 1000 (the ticket's "1 s timer"). */
  tickMs?: number
  /** How often to flush the p99 summary, ms. Default 5 minutes. */
  summaryIntervalMs?: number
  /** Test seams only — production always uses the real clock, timers and histogram. */
  now?: () => number
  setIntervalFn?: (handler: () => void, ms: number) => NodeJS.Timeout
  clearIntervalFn?: (handle: NodeJS.Timeout) => void
  histogram?: EventLoopHistogram
}

export interface StallMonitor {
  /** Stop the heartbeat and release the histogram. Idempotent. */
  stop(): void
  /** Re-arm the schedule from the current tick, discarding any lateness accrued before this call, and
   *  restart the heartbeat if `pause()` had stopped it. Call on `powerMonitor`'s `'resume'` event. */
  resync(): void
  /** Stop delivering heartbeat ticks without releasing the histogram — call on `powerMonitor`'s
   *  `'suspend'` event so no tick can be pending to fire during sleep. A no-op once stopped or already
   *  paused. */
  pause(): void
  /** Record the operation currently in flight, cheaply, so the NEXT heartbeat tick — whether or not that
   *  tick is itself late — can name it. Call at the top of any operation worth naming on a late tick. */
  setPhase(label: string): void
}

/** Start the heartbeat. Call once per app boot; call `.stop()` from `will-quit`. */
export function startStallMonitor(opts: StallMonitorOptions): StallMonitor {
  const tickMs = opts.tickMs ?? 1000
  const summaryIntervalMs = opts.summaryIntervalMs ?? 5 * 60 * 1000
  const now = opts.now ?? (() => performance.now())
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval
  const histogram = opts.histogram ?? monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  let expectedAt = now() + tickMs
  let nextSummaryAt = now() + summaryIntervalMs
  let phase: string | undefined

  const tick = (): void => {
    const at = now()
    const lateMs = at - expectedAt
    const firedPhase = phase
    phase = undefined
    if (lateMs >= tickMs) {
      opts.onStall({ bootId: opts.bootId, durationMs: lateMs, phase: firedPhase })
    }
    expectedAt = at + tickMs

    if (at >= nextSummaryAt) {
      opts.onSummary({ bootId: opts.bootId, p99Ms: histogram.percentile(99) / 1e6 })
      histogram.reset()
      nextSummaryAt = at + summaryIntervalMs
    }
  }

  let timer: NodeJS.Timeout | undefined = setIntervalFn(tick, tickMs)
  let stopped = false

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearIntervalFn(timer)
      timer = undefined
      histogram.disable()
    },
    resync(): void {
      expectedAt = now() + tickMs
      if (!stopped && timer === undefined) timer = setIntervalFn(tick, tickMs)
    },
    pause(): void {
      if (stopped || timer === undefined) return
      clearIntervalFn(timer)
      timer = undefined
    },
    setPhase(label: string): void {
      phase = label
    }
  }
}
