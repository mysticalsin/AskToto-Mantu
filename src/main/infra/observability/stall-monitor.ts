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
 *
 * `timePhase(label, fn)` is the boot sequence's phase trace: many boot steps run synchronously back to
 * back with no `await` between them, so no heartbeat tick can ever fire in the middle of that sequence —
 * a tick only ever runs before it starts or after it ends. Naming a stall after "whichever step called
 * `timePhase` last" would therefore always name the LAST step in that sequence, regardless of which one
 * actually blocked the tick. Measuring each call's own duration and keeping only the longest since the
 * previous tick fixes that: the phase a tick reports is the one that was actually slow.
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
  /** The `timePhase` label with the longest measured duration since the previous tick, or `undefined` when
   *  none ran, or an intervening on-time tick already consumed it. Every tick — late or not — reads this
   *  and clears it, so `phase` only ever names an operation that finished since the previous tick — never
   *  one still running, and never one from before that window. It can still have finished before an
   *  untimed block that ran after it started the stall; compare `phaseMs` with `durationMs` to see whether
   *  the named phase actually accounts for the lateness or merely preceded an uninstrumented one that did. */
  phase: string | undefined
  /** That phase's own measured duration, in ms. Present exactly when `phase` is. */
  phaseMs: number | undefined
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
  /** Run `fn` and measure its own synchronous duration on this monitor's monotonic clock (never
   *  `Date.now()` — see the module header). For a function that returns a promise, only the part before
   *  its first `await` is measured. If that duration is the longest of any `timePhase` call since the
   *  previous tick, the NEXT tick — whether or not that tick is itself late — names this `label`. Call
   *  around any operation worth naming on a late tick; returns `fn`'s result. */
  timePhase<T>(label: string, fn: () => T): T
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
  let phaseMs = 0

  const tick = (): void => {
    const at = now()
    const lateMs = at - expectedAt
    const firedPhase = phase
    const firedPhaseMs = phaseMs
    phase = undefined
    phaseMs = 0
    if (lateMs >= tickMs) {
      opts.onStall({
        bootId: opts.bootId,
        durationMs: lateMs,
        phase: firedPhase,
        phaseMs: firedPhase === undefined ? undefined : firedPhaseMs
      })
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
    timePhase<T>(label: string, fn: () => T): T {
      const start = now()
      try {
        return fn()
      } finally {
        const durationMs = now() - start
        if (durationMs > phaseMs) {
          phase = label
          phaseMs = durationMs
        }
      }
    }
  }
}
