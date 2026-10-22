/**
 * Bounded passes: run a callback once at each of a few fixed offsets, then stop (G17, FF-14).
 *
 * This is the scheduler's answer to "settle after a disturbance": a resume, an unlock or a display change
 * leaves the OS applying its own changes for a moment, so one reconcile at time 0 can run too early. The
 * passes are armed once, up front, from one loop. No pass re-arms another and nothing polls, so an idle app
 * pays nothing between disturbances. Offset 0 runs synchronously; the rest are unref'd timers.
 */

/** The slice of the timer API the passes use, injectable so a test drives a manual clock. */
export interface PassTimers {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realPassTimers: PassTimers = {
  setTimeout(run, ms) {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/**
 * Runs `pass(index)` at each offset in `offsetsMs` (milliseconds from now, non-decreasing). Returns a
 * cancel that stops every pass that has not run yet. A pass that throws goes to `onError` and never
 * stops the later passes.
 */
export function runBoundedPasses(
  offsetsMs: readonly number[],
  pass: (index: number) => void,
  timers: PassTimers = realPassTimers,
  onError: (error: unknown) => void = () => undefined
): () => void {
  let cancelled = false
  const handles: unknown[] = []
  const run = (index: number): void => {
    if (cancelled) return
    try {
      pass(index)
    } catch (error) {
      onError(error)
    }
  }
  offsetsMs.forEach((offset, index) => {
    if (offset <= 0) return
    handles.push(timers.setTimeout(() => run(index), offset))
  })
  offsetsMs.forEach((offset, index) => {
    if (offset <= 0) run(index)
  })
  return () => {
    cancelled = true
    for (const handle of handles) timers.clearTimeout(handle)
    handles.length = 0
  }
}
