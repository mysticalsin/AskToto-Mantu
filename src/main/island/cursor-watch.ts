/**
 * cursor-watch.ts — pure hit-test + reveal/hide decision for the overlay hover rest.
 *
 * macOS menu bar / Dynamic Island often does not deliver mouseenter to an Electron
 * window, even at Y=0. Main polls `screen.getCursorScreenPoint()` and uses these
 * helpers. No Accessibility / CGEvent tap required.
 */

import type { OverlayLayout } from '@shared/overlay-chrome'
import { overlayUsesHover } from '@shared/overlay-chrome'
import type { Rect } from './geometry'

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
 * Revealed: cursor left the bar bounds (+ grace) → hide; otherwise stay.
 */
export function decideCursorWatch(input: {
  cursor: { x: number; y: number }
  restRect: Rect
  revealedRect: Rect
  revealed: boolean
  gracePx?: number
}): CursorWatchDecision {
  if (!input.revealed) {
    return pointInRect(input.cursor, input.restRect) ? 'reveal' : 'stay'
  }
  const leave = inflateRect(input.revealedRect, input.gracePx ?? CURSOR_LEAVE_GRACE_PX)
  return pointInRect(input.cursor, leave) ? 'stay' : 'hide'
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
