/**
 * responsiveness-tracker.ts — pairs a BrowserWindow's `unresponsive` event with the `responsive` (or
 * `render-process-gone`) that ends it, so `app.responsive` can report how long the renderer was wedged.
 */
export interface ResponsivenessTracker {
  /** Call from the window's `unresponsive` handler. */
  markUnresponsive(): void
  /** Call from the window's `responsive` handler. Returns the elapsed ms since the matching
   *  `markUnresponsive`, or `null` when none is pending (no unpaired `app.responsive` is ever reported). */
  markResponsive(): number | null
}

export function createResponsivenessTracker(now: () => number = Date.now): ResponsivenessTracker {
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
    }
  }
}
