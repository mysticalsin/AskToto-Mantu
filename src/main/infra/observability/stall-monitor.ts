/**
 * stall-monitor.ts — detect a main-process event-loop stall long enough to explain a frozen UI.
 *
 * The freeze root cause (spindump-verified, RUNTIME-EVIDENCE.md): a main-thread JS timer runs a
 * synchronous fs read against a OneDrive placeholder file, and the kernel blocks the whole event loop for
 * as long as the file takes to materialize — tray, hotkeys, IPC and `activate`/reopen all stop for that
 * long. A blocked event loop cannot log anything about itself while it is blocked; the only observable
 * trace is the NEXT tick of an otherwise-regular timer firing very late. This module runs a 1 s heartbeat
 * and reports any tick that fires at least one full tick period late, plus a `monitorEventLoopDelay` p99
 * summary every 5 minutes so shorter stalls that never trip the heartbeat are still visible.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'

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
  /** How much later than scheduled this tick fired, in ms. Always >= the configured tickMs. */
  durationMs: number
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
}

/** Start the heartbeat. Call once per app boot; call `.stop()` from `will-quit`. */
export function startStallMonitor(opts: StallMonitorOptions): StallMonitor {
  const tickMs = opts.tickMs ?? 1000
  const summaryIntervalMs = opts.summaryIntervalMs ?? 5 * 60 * 1000
  const now = opts.now ?? Date.now
  const setIntervalFn = opts.setIntervalFn ?? setInterval
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval
  const histogram = opts.histogram ?? monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  let expectedAt = now() + tickMs
  let nextSummaryAt = now() + summaryIntervalMs

  const timer = setIntervalFn(() => {
    const at = now()
    const lateMs = at - expectedAt
    if (lateMs >= tickMs) {
      opts.onStall({ bootId: opts.bootId, durationMs: lateMs })
    }
    expectedAt = at + tickMs

    if (at >= nextSummaryAt) {
      opts.onSummary({ bootId: opts.bootId, p99Ms: histogram.percentile(99) / 1e6 })
      histogram.reset()
      nextSummaryAt = at + summaryIntervalMs
    }
  }, tickMs)

  let stopped = false
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearIntervalFn(timer)
      histogram.disable()
    }
  }
}
