/**
 * Frame budget for the Bar's resting decorative orb (C30, idle CPU).
 *
 * The installed 2.12.0 soak measured ~35% of one core with no meeting. Profiling the idle overlay over CDP
 * attributed it to two sources: the thinking-orb canvas loop painting on every vsync (120 per second on a
 * ProMotion panel) and the stealth rim's opacity breathe making the compositor produce a frame on every vsync.
 * Each overlay frame costs about 2.7 ms of CPU (GPU process plus renderer), because the whole transparent
 * window is recomposited, so the cost scales with frames per second, not with how much of the orb changes.
 *
 * The orb's motion is a function of wall-clock time (thinking-orbs draws `draw(ctx, size, t)`), so painting
 * fewer frames keeps its shape, speed and path and only lowers the cadence. The rest state is budgeted:
 * 60 fps while the overlay has focus or the pointer (the cadence the motion was tuned on, a 60 Hz display),
 * 30 fps while the user is working in another app. Every non-rest state (listening, working, searching,
 * connecting) keeps painting on every vsync, exactly as before.
 *
 * Between budgeted frames the loop sleeps on a timer instead of waking for every vsync just to skip it, which
 * alone cost about 4% of a core at 120 Hz. The timer only hands back to requestAnimationFrame, so painting
 * stays vsync-aligned, and timers freeze with rAF when the page is hidden.
 */

/** Resting orb cadence while the overlay has the user's focus or pointer. */
export const REST_ORB_FPS_ENGAGED = 60
/** Resting orb cadence while the user works in another app (the overlay is only in peripheral view). */
export const REST_ORB_FPS_AMBIENT = 30
/** A frame that arrives up to this early still counts as on time (half a 120 Hz vsync). */
export const FRAME_SLACK_MS = 4
/** The timer wakes just before the frame is due, so the rAF it hands to lands on the first due vsync. */
export const TIMER_LEAD_MS = 1
/** Sleeps shorter than one 60 Hz vsync go straight to requestAnimationFrame: a timer would not save a wakeup. */
export const MIN_TIMER_WAIT_MS = 17

/** Frames per second for the resting orb, or null (every vsync) for any state that is animating for a reason. */
export function orbFrameBudget(input: { resting: boolean; engaged: boolean }): number | null {
  if (!input.resting) return null
  return input.engaged ? REST_ORB_FPS_ENGAGED : REST_ORB_FPS_AMBIENT
}

/** True when a frame at `now` is due under `fps` (null: every frame is due). */
export function frameDue(now: number, lastPaintAt: number, fps: number | null): boolean {
  if (fps == null) return true
  return now - lastPaintAt >= 1000 / fps - FRAME_SLACK_MS
}

/** Milliseconds to sleep before asking for the next animation frame; 0 means ask now. */
export function frameWaitMs(now: number, lastPaintAt: number, fps: number | null): number {
  if (fps == null) return 0
  const wait = lastPaintAt + 1000 / fps - FRAME_SLACK_MS - TIMER_LEAD_MS - now
  return wait >= MIN_TIMER_WAIT_MS ? wait : 0
}

export type FrameLoopDeps = {
  requestFrame: (callback: (time: number) => void) => number
  cancelFrame: (handle: number) => void
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  now: () => number
}

export type FrameLoop = { start: () => void; stop: () => void; readonly running: boolean }

const browserDeps = (): FrameLoopDeps => ({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now()
})

/**
 * A paint loop that honours `fps()` on every frame. `fps` is read each time, so a state or focus change takes
 * effect at the next frame without restarting the loop. `paint` receives the rAF timestamp.
 */
export function createFrameLoop(
  paint: (time: number) => void,
  fps: () => number | null,
  deps: FrameLoopDeps = browserDeps()
): FrameLoop {
  let running = false
  let frame = 0
  let timer: unknown = null
  let lastPaintAt = Number.NEGATIVE_INFINITY

  const schedule = (): void => {
    const wait = frameWaitMs(deps.now(), lastPaintAt, fps())
    if (wait > 0) {
      timer = deps.setTimer(() => {
        timer = null
        if (running) frame = deps.requestFrame(onFrame)
      }, wait)
    } else frame = deps.requestFrame(onFrame)
  }
  const onFrame = (time: number): void => {
    frame = 0
    if (!running) return
    if (frameDue(time, lastPaintAt, fps())) {
      lastPaintAt = time
      paint(time)
    }
    if (running) schedule()
  }

  return {
    start() {
      if (running) return
      running = true
      schedule()
    },
    stop() {
      running = false
      if (frame) deps.cancelFrame(frame)
      frame = 0
      if (timer !== null) deps.clearTimer(timer)
      timer = null
    },
    get running() {
      return running
    }
  }
}
