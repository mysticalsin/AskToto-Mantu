/**
 * The routine tick source (G66): one `unref` interval plus an immediate tick on wake and on unlock. It decides only WHEN
 * the routine engine looks at its routines; what is due is the engine's call. It runs only while Métis is open, which is
 * the product promise ("Runs while Métis is open"). Takes `powerMonitor` as a parameter, like run-observability.
 */
type PowerEvent = 'resume' | 'unlock-screen'

export interface RoutineTickerPowerMonitor {
  on(event: PowerEvent, listener: () => void): unknown
  removeListener(event: PowerEvent, listener: () => void): unknown
}

export interface RoutineTickerOptions {
  everyMs?: number
  powerMonitor: RoutineTickerPowerMonitor
  /** Test seams. */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
}

export const ROUTINE_TICK_MS = 30_000

/** Starts ticking and returns a disposer that removes the timer and both listeners. */
export function startRoutineTicker(onTick: () => void, options: RoutineTickerOptions): () => void {
  const fire = (): void => {
    try {
      onTick()
    } catch {
      // a failing tick never stops the next one
    }
  }
  const set = options.setIntervalFn ?? setInterval
  const clear = options.clearIntervalFn ?? clearInterval
  const timer = set(fire, options.everyMs ?? ROUTINE_TICK_MS)
  timer.unref?.()
  options.powerMonitor.on('resume', fire)
  options.powerMonitor.on('unlock-screen', fire)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    clear(timer)
    options.powerMonitor.removeListener('resume', fire)
    options.powerMonitor.removeListener('unlock-screen', fire)
  }
}
