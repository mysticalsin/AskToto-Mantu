/**
 * responsiveness-tracker.ts — pairs a BrowserWindow's `unresponsive` event with the `responsive` (or
 * `render-process-gone`) that ends it, so `app.responsive` can report how long the renderer was wedged.
 *
 * Elapsed time is measured on `performance.now()` (a monotonic clock), never on `Date.now()` (the wall
 * clock): a lid-close/sleep or an NTP step between the two events would move the wall clock without the
 * renderer having been wedged for anywhere near that long, manufacturing a fake `app.responsive` duration
 * — the same hazard stall-monitor.ts's own module header documents for its heartbeat.
 */
import { performance } from 'node:perf_hooks'

export interface ResponsivenessTracker {
  /** Call from the window's `unresponsive` handler. */
  markUnresponsive(): void
  /** Call from the window's `responsive` handler. Returns the elapsed ms since the matching
   *  `markUnresponsive`, or `null` when none is pending (no unpaired `app.responsive` is ever reported). */
  markResponsive(): number | null
  /** Call from `render-process-gone`: the content died instead of recovering on its own, so any pending
   *  `unresponsiveSince` belongs to a wedge that will never get its matching `responsive`. Clearing it here
   *  is what lets a later `unresponsive` in the reloaded renderer (MQA-038 reloads the same window) start a
   *  fresh pairing instead of being measured from before the crash. */
  markGone(): void
}

export function createResponsivenessTracker(now: () => number = () => performance.now()): ResponsivenessTracker {
  let unresponsiveSince: number | null = null
  return {
    markUnresponsive(): void {
      // `??=`, not `=`: a second `unresponsive` before the matching `responsive` must not push the start
      // time forward and under-report how long the renderer was actually wedged.
      unresponsiveSince ??= now()
    },
    markResponsive(): number | null {
      if (unresponsiveSince === null) return null
      const stallMs = now() - unresponsiveSince
      unresponsiveSince = null
      return stallMs
    },
    markGone(): void {
      unresponsiveSince = null
    }
  }
}
