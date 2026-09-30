/**
 * A self-rescheduling background timer whose next delay is decided after each tick, for pollers whose cadence
 * follows what the last tick saw (the overlay cursor watch, ADR-018).
 */

export type AdaptiveTimer = {
  /** (Re)starts the loop; the first tick lands `firstDelayMs` later. */
  start(): void
  stop(): void
  running(): boolean
}

/**
 * After each tick it asks `intervalMs()` for the next delay. A tick that stops or restarts the timer itself
 * wins; the finished tick never schedules a second timer on top of it.
 */
export function createAdaptiveTimer(opts: {
  tick: () => void
  intervalMs: () => number
  firstDelayMs: number
}): AdaptiveTimer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = false
  // Bumped by every start/stop; a tick from an older generation never reschedules.
  let generation = 0
  const schedule = (gen: number, delay: number): void => {
    timer = setTimeout(() => {
      timer = null
      opts.tick()
      if (gen === generation) schedule(gen, opts.intervalMs())
    }, delay)
    timer.unref?.()
  }
  const stop = (): void => {
    generation += 1
    active = false
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    start() {
      stop()
      active = true
      schedule(generation, opts.firstDelayMs)
    },
    stop,
    // True from start() to stop(), including while a tick runs.
    running: () => active
  }
}
