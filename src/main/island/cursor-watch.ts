/**
 * cursor-watch.ts — pure hit-test + reveal/hide decision for the overlay hover rest.
 *
 * macOS menu bar / Dynamic Island often does not deliver mouseenter to an Electron
 * window, even at Y=0. Main polls `screen.getCursorScreenPoint()` and uses these
 * helpers. No Accessibility / CGEvent tap required.
 */

import type { OverlayLayout } from '@shared/overlay-chrome'
import { overlayUsesHover } from '@shared/overlay-chrome'
import { HOVER_ISLAND_HEIGHT_MAX_PX, type Rect } from './geometry'

/** Cap leftover 44px slabs so Teams mute at Y=40 still misses. Width stays full top edge. */
export function clampHoverRestRect(rect: Rect): Rect {
  const height = Math.min(rect.height, HOVER_ISLAND_HEIGHT_MAX_PX)
  if (height === rect.height) return rect
  return { ...rect, height }
}

/**
 * A tray Show/Hide `hide()` leaves the LSUIElement window invisible while
 * `islandResting` may still be false. Treat that as not revealed so top-edge
 * hover calls restoreBarWidth + showInactive instead of stay.
 */
export function overlayWatchTreatAsRevealed(islandResting: boolean, windowVisible: boolean): boolean {
  return !islandResting && windowVisible
}

export type CursorWatchDecision = 'reveal' | 'hide' | 'stay'

/** Reveal even when the hovering latch is stuck, if the window is still parked, hidden, or the 120×44 stub. */
export function overlayWatchNeedsRestore(input: {
  decision: CursorWatchDecision
  alreadyHovering: boolean
  islandResting: boolean
  windowVisible: boolean
  hugStub?: boolean
}): boolean {
  if (input.hugStub && (input.decision === 'reveal' || input.decision === 'stay')) return true
  if (input.decision !== 'reveal') return false
  if (!input.alreadyHovering) return true
  return input.islandResting || !input.windowVisible
}

/** Poll while hide/island is resting. 16–32ms — one frame-ish, no Accessibility tap. */
export const CURSOR_WATCH_INTERVAL_MS = 24
/** Extra pixels around the revealed bar before we treat the pointer as gone. */
export const CURSOR_LEAVE_GRACE_PX = 8
/**
 * After cursor-watch hide, main parks Hide/Island even if the renderer never
 * calls overlayParkAfterHide. Ultron c74e389: 5s at ~(900,600) left 880×120 up.
 * Must land inside 1–2s. Do not reset this timer on every hide tick.
 */
export const OVERLAY_LEAVE_PARK_MS = 800

/** Revealed Hide/Island + cursor outside the bar and the top-edge strip → park. */
export function overlayWatchShouldParkOnLeave(input: {
  decision: CursorWatchDecision
  islandResting: boolean
}): boolean {
  return input.decision === 'hide' && !input.islandResting
}

export function pointInRect(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}

export function inflateRect(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2
  }
}

/**
 * Resting: cursor in the top-edge approach strip → reveal.
 * Revealed: stay if the cursor is still in that strip OR the inflated bar.
 * Hide only when it is in neither. macOS clamps the bar to workArea.y (~39);
 * a cursor on the top edge (Y≈12) must not oscillate hide/reveal.
 */
export function decideCursorWatch(input: {
  cursor: { x: number; y: number }
  restRect: Rect
  revealedRect: Rect
  revealed: boolean
  gracePx?: number
}): CursorWatchDecision {
  const restRect = clampHoverRestRect(input.restRect)
  if (!input.revealed) {
    return pointInRect(input.cursor, restRect) ? 'reveal' : 'stay'
  }
  const leave = inflateRect(input.revealedRect, input.gracePx ?? CURSOR_LEAVE_GRACE_PX)
  if (pointInRect(input.cursor, restRect) || pointInRect(input.cursor, leave)) return 'stay'
  return 'hide'
}

/** Darwin + Windows top-edge only. Linux is WRONG_WORKER for the live Mac island. */
export function shouldWatchOverlayCursor(
  platform: NodeJS.Platform,
  onboardingDone: boolean,
  layout: OverlayLayout
): boolean {
  if (!onboardingDone) return false
  if (!overlayUsesHover(layout)) return false
  return platform === 'darwin' || platform === 'win32'
}
