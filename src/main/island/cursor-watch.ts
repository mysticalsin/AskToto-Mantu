/**
 * cursor-watch.ts — pure hit-test + reveal/hide decision for the overlay hover rest.
 *
 * macOS menu bar / Dynamic Island often does not deliver mouseenter to an Electron
 * window, even at Y=0. Main polls `screen.getCursorScreenPoint()` and uses these
 * helpers. No Accessibility / CGEvent tap required.
 */

import type { OverlayLayout } from '@shared/overlay-chrome'
import { overlayUsesHover } from '@shared/overlay-chrome'
import { HOVER_HIT_BAND_MAX_PX, type Rect } from './geometry'

/** Ignore a leftover 80–120px pad on the rest rect. Reveal is the top strip only. */
function clampHoverRestRect(rect: Rect): Rect {
  if (rect.height <= HOVER_HIT_BAND_MAX_PX) return rect
  return { ...rect, height: HOVER_HIT_BAND_MAX_PX }
}

/** Poll while hide/island is resting. 16–32ms — one frame-ish, no Accessibility tap. */
export const CURSOR_WATCH_INTERVAL_MS = 24
/** Extra pixels around the revealed bar before we treat the pointer as gone. */
export const CURSOR_LEAVE_GRACE_PX = 8

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

export type CursorWatchDecision = 'reveal' | 'hide' | 'stay'

/**
 * Resting: cursor in the hide/island rest rect → reveal.
 * Revealed: stay if the cursor is still in the island/notch rest strip OR the
 * inflated bar. Hide only when it is in neither. macOS clamps the bar to
 * workArea.y (~39); a cursor in the island (Y≈12) must not oscillate hide/reveal.
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
