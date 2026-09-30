/**
 * idle-throttle.ts — adaptive cursor-watch cadence and the main-side presenter idle signal (ADR-018).
 *
 * The overlay runs with backgroundThrottling:false, so the page's visibilityState never turns hidden and
 * cannot tell the page it is parked. Main owns both facts instead: it polls the cursor fast only where a
 * reveal or leave can happen, and it publishes one idle signal (parked, or blurred for a while) that the
 * page's animation loops can follow.
 */

import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { type AdaptiveTimer, createAdaptiveTimer } from '../infra/scheduler/adaptive-timer'
import { CURSOR_WATCH_INTERVAL_MS, inflateRect, overlayWatchTreatAsRevealed, pointInRect } from './cursor-watch'
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

/** cursorWatchIntervalMs for the live overlay: its bounds count as the revealed bar only when the watch treats
 *  the window as revealed (not parked, not tray-hidden). */
export function overlayCursorWatchIntervalMs(input: {
  cursor: { x: number; y: number }
  restRect: Rect
  bounds: Rect
  islandResting: boolean
  windowVisible: boolean
  transitioning: boolean
}): number {
  return cursorWatchIntervalMs({
    cursor: input.cursor,
    restRect: input.restRect,
    revealedRect: overlayWatchTreatAsRevealed(input.islandResting, input.windowVisible) ? input.bounds : null,
    transitioning: input.transitioning
  })
}

export type AdaptiveCursorWatch = AdaptiveTimer

/** The cursor watch loop: the first tick lands one fast interval after start, then `intervalMs()` decides. */
export function createAdaptiveCursorWatch(opts: { tick: () => void; intervalMs: () => number }): AdaptiveCursorWatch {
  return createAdaptiveTimer({ ...opts, firstDelayMs: CURSOR_WATCH_INTERVAL_MS })
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

type OverlayWindow = Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'on'> & {
  webContents: Pick<BrowserWindow['webContents'], 'send' | 'on'>
}

export type OverlayIdleSignal = {
  /** Re-reads `parked()`; call wherever the overlay reveals, parks or changes surface. */
  sync(): void
  /** Binds a newly created overlay window; events from a window that is no longer `window()` are ignored. */
  attach(self: OverlayWindow): void
}

/**
 * The presenter idle signal wired to the live overlay window: focus/blur drive the blur clock, show/hide
 * re-read the park state, and a (re)loaded page receives the current state because it missed earlier sends.
 * Published on IPC.presenterIdle as { idle }.
 */
export function createOverlayIdleSignal(deps: {
  window: () => OverlayWindow | null
  parked: () => boolean
  blurDelayMs?: number
}): OverlayIdleSignal {
  const signal = createPresenterIdleSignal({
    blurDelayMs: deps.blurDelayMs,
    publish: (state) => {
      const w = deps.window()
      if (!w || w.isDestroyed()) return
      try {
        w.webContents.send(IPC.presenterIdle, state)
      } catch {
        /* renderer gone */
      }
    }
  })
  const sync = (): void => signal.setParked(deps.parked())
  return {
    sync,
    attach(self) {
      const whenCurrent = (fn: () => void) => (): void => {
        if (deps.window() === self) fn()
      }
      signal.setFocused(self.isFocused())
      self.on('focus', whenCurrent(() => signal.setFocused(true)))
      self.on('blur', whenCurrent(() => signal.setFocused(false)))
      self.on('show', whenCurrent(sync))
      self.on('hide', whenCurrent(sync))
      self.webContents.on('dom-ready', whenCurrent(() => signal.republish()))
    }
  }
}
