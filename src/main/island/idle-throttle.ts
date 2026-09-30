/**
 * idle-throttle.ts — adaptive cursor-watch cadence and the main-side presenter idle signal (ADR-018).
 *
 * The overlay runs with backgroundThrottling:false, so the page's visibilityState never turns hidden and
 * cannot tell the page it is parked. Main owns both facts instead: it polls the cursor fast only where a
 * reveal or leave can happen, and it publishes one idle signal (parked, or blurred for a while) that the
 * page's animation loops can follow.
 */

import { CURSOR_WATCH_INTERVAL_MS, inflateRect, pointInRect } from './cursor-watch'
import type { Rect } from './geometry'

/** Parked with the pointer far from the reveal zone: nothing can reveal before the pointer crosses the band. */
export const CURSOR_WATCH_IDLE_INTERVAL_MS = 250
/**
 * Fast polling starts this far outside the reveal zone (and the revealed bar), so a pointer approaching at up
 * to 1.28 px/ms is always seen at the fast cadence before it enters: an idle tick adds no reveal latency on top
 * of the intentional dwell. A faster flick adds at most CURSOR_WATCH_IDLE_INTERVAL_MS minus its band crossing.
 */
export const CURSOR_WATCH_NEAR_PX = 320
/** The page counts as idle once the overlay has been blurred this long (N in ADR-018). */
export const PRESENTER_IDLE_BLUR_MS = 10_000

/**
 * Next cursor-watch delay. Fast while a transition is in flight (reveal dwell, leave → park timer) or while the
 * pointer is within CURSOR_WATCH_NEAR_PX of the reveal zone or of the revealed bar; idle otherwise.
 * `revealedRect` is null while the window is parked or hidden.
 */
export function cursorWatchIntervalMs(input: {
  cursor: { x: number; y: number }
  restRect: Rect
  revealedRect: Rect | null
  transitioning: boolean
}): number {
  if (input.transitioning) return CURSOR_WATCH_INTERVAL_MS
  const near = (rect: Rect): boolean => pointInRect(input.cursor, inflateRect(rect, CURSOR_WATCH_NEAR_PX))
  if (near(input.restRect)) return CURSOR_WATCH_INTERVAL_MS
  if (input.revealedRect && near(input.revealedRect)) return CURSOR_WATCH_INTERVAL_MS
  return CURSOR_WATCH_IDLE_INTERVAL_MS
}

export type AdaptiveCursorWatch = {
  /** (Re)starts the loop; the first tick lands one fast interval later. */
  start(): void
  stop(): void
  running(): boolean
}

/**
 * A self-rescheduling timer: after each tick it asks `intervalMs()` for the next delay. A tick that stops or
 * restarts the watch itself wins; the finished tick never schedules a second timer on top of it.
 */
export function createAdaptiveCursorWatch(opts: {
  tick: () => void
  intervalMs: () => number
}): AdaptiveCursorWatch {
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
      schedule(generation, CURSOR_WATCH_INTERVAL_MS)
    },
    stop,
    // True from start() to stop(), including while a tick runs.
    running: () => active
  }
}

export type PresenterIdleState = { idle: boolean }

export type PresenterIdleSignal = {
  setParked(parked: boolean): void
  setFocused(focused: boolean): void
  /** Re-sends the current state, e.g. to a page that just (re)loaded. */
  republish(): void
  current(): PresenterIdleState
  dispose(): void
}

/**
 * idle = parked, or blurred for at least `blurDelayMs`. Publishes only on change (and on republish); focus
 * clears the blur clock at once, so a reveal or focus never waits on the page to notice.
 */
export function createPresenterIdleSignal(opts: {
  publish: (state: PresenterIdleState) => void
  blurDelayMs?: number
}): PresenterIdleSignal {
  const blurDelayMs = opts.blurDelayMs ?? PRESENTER_IDLE_BLUR_MS
  let parked = false
  let focused = true
  let blurredLong = false
  let blurTimer: ReturnType<typeof setTimeout> | null = null
  // A page starts animating, so only a change away from active is news to it.
  let published: boolean | null = false
  const current = (): PresenterIdleState => ({ idle: parked || blurredLong })
  const update = (): void => {
    const state = current()
    if (state.idle === published) return
    published = state.idle
    opts.publish(state)
  }
  const clearBlurTimer = (): void => {
    if (blurTimer) clearTimeout(blurTimer)
    blurTimer = null
  }
  return {
    setParked(next) {
      parked = next
      update()
    },
    setFocused(next) {
      if (next === focused) return
      focused = next
      clearBlurTimer()
      blurredLong = false
      if (!focused) {
        blurTimer = setTimeout(() => {
          blurTimer = null
          blurredLong = true
          update()
        }, blurDelayMs)
        blurTimer.unref?.()
      }
      update()
    },
    republish() {
      published = null
      update()
    },
    current,
    dispose: clearBlurTimer
  }
}
