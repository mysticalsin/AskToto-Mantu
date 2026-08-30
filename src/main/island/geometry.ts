/**
 * island/geometry.ts — pure overlay positioning math (MQA-275 / Phase 1 of the Métis × Vibe-Island
 * rebuild). NO Electron imports here on purpose: every function takes plain numbers/rects and returns
 * plain numbers/rects, so it is directly unit-testable (geometry.test.ts) without booting Electron or
 * lifting source slices out of index.ts (the pattern overlay-placement.contract.test.ts had to use
 * before this module existed).
 *
 * index.ts stays the ONLY module that calls `screen.getDisplayMatching` / `win.setBounds` — it resolves
 * the live Electron `Display` (and, on macOS, the notch metrics from `island/metrics.ts`) and hands the
 * plain numbers in here. This module never decides which surface to show (that is Phase 2's renderer
 * state machine); it only answers "given this content size and this display, where do the bounds go?".
 *
 * See docs/plans/metis-vibe-island-rebuild.plan.md §2.1 ("one source of truth per concern") and §2.4
 * (notch awareness) for the fuller architecture this is Phase 1 of.
 */

import type { OverlayLayout } from '@shared/overlay-chrome'
import { overlayUsesSafeTop } from '@shared/overlay-chrome'

export type { OverlayLayout }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Per-display metrics used by the notch-aware clamp. `bounds`/`workArea` are always Electron's own
 * `Display.bounds`/`Display.workArea` (top-left-origin, already in the coordinate space `setBounds`
 * expects) — never AppKit's `NSScreen.frame`/`visibleFrame`, which use a BOTTOM-left-origin, flipped-y
 * coordinate space. Mixing the two would silently mis-position the window on any multi-display Mac.
 * `hasNotch`/`notchWidth`/`menuBarHeight` are magnitudes (safe to source from either the helper or the
 * heuristic — a width/height difference is coordinate-system-independent), never positions.
 */
export interface DisplayMetrics {
  bounds: Rect
  workArea: Rect
  hasNotch: boolean
  /** Width (px) of the physical notch cutout, or 0 when absent/unknown. */
  notchWidth: number
  /** Height (px) of the menu-bar / safe-area obstruction at the top of this display. */
  menuBarHeight: number
  /** Where hasNotch/notchWidth/menuBarHeight came from — surfaced so a wrong guess is diagnosable. */
  source: 'helper' | 'heuristic'
}

/** Menu-bar height (pt) at/above which a Mac is presumptively notched: notch Macs report a ~37-44pt
 *  safe-area obstruction vs ~24-25pt for a traditional menu bar. This is a PROBABLE signal, used only
 *  when the mac-helper `screen-metrics` subcommand is unavailable — see topClamp's doc comment for why a
 *  wrong guess here can never push the island above the work-area top. */
const NOTCH_HEURISTIC_MENU_BAR_MIN_PX = 32

/**
 * Heuristic notch guess for when the mac-helper binary is missing or its `screen-metrics` subcommand
 * fails: `hasNotch ≈ menuBarHeight >= 32 && platform === 'darwin'`. `menuBarHeight` here is expected to
 * be `display.bounds.height - display.workArea.height` (see island/metrics.ts) — the caller's job, not
 * this function's, since that subtraction needs the live Electron `Display`.
 */
export function hasNotchHeuristic(menuBarHeight: number, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && menuBarHeight >= NOTCH_HEURISTIC_MENU_BAR_MIN_PX
}

/** Clamp a single axis (pos/size) into a work-area span, without inverting when the window is bigger
 *  than the display. `Math.min(Math.max(pos, areaPos), areaPos + areaSpan - size)` assumes
 *  `areaPos + areaSpan - size >= areaPos`; when `size > areaSpan` that upper bound falls below `areaPos`
 *  and min/max invert, pushing the window partially off-screen instead of pinning it. Pin to `areaPos`
 *  instead. (Moved verbatim from index.ts's original `clampAxis`.) */
export function clampAxis(pos: number, size: number, areaPos: number, areaSpan: number): number {
  if (size >= areaSpan) return areaPos
  return Math.min(Math.max(pos, areaPos), areaPos + areaSpan - size)
}

/** `clampAxis`, but against a work area inset by `margin` on both ends — the shape resizeTo's y-slide
 *  and x-recenter both need (a small breathing gap from the very edge of the screen), without duplicating
 *  the inversion guard `clampAxis` already has. `margin = 0` is exactly `clampAxis`. */
export function clampWithMargin(pos: number, size: number, areaPos: number, areaSpan: number, margin: number): number {
  const insetPos = areaPos + margin
  const insetSpan = Math.max(0, areaSpan - margin * 2)
  return clampAxis(pos, size, insetPos, insetSpan)
}

/** Loosened clampAxis: pins `pos` so between `margin` and `size` px (whichever is smaller) of the window
 *  stays inside `[areaPos, areaPos + areaSpan)`, instead of pinning the WHOLE window inside it. Used only
 *  for the drag-reachability paths (`moveBy`/`refitToDisplay`) — letting most of the window hang off a
 *  display's edge is what lets a drag glide across a gap to a neighboring monitor instead of stopping
 *  dead at the first display's boundary. (Moved verbatim from index.ts's original `clampAxisMargin`.) */
export function clampAxisMargin(pos: number, size: number, areaPos: number, areaSpan: number, margin: number): number {
  const m = Math.min(margin, size, areaSpan)
  return Math.min(Math.max(pos, areaPos - size + m), areaPos + areaSpan - m)
}

/** Bottom reserve (px) kept clear below the overlay so it never grows flush to the very bottom edge —
 *  matches the pre-extraction inline `- 48` in index.ts's original `clampHeight`/`refitToDisplay`. */
const BOTTOM_RESERVE_PX = 48

/** Ceiling a window height to a display's work area, keeping `BOTTOM_RESERVE_PX` clear at the bottom.
 *  `minHeight` is the caller's floor (index.ts's `BAR_MIN_HEIGHT`), passed in rather than hard-coded so
 *  this module stays the single source of the reserve constant while index.ts keeps owning its own named
 *  floor. */
export function clampHeight(height: number, areaHeight: number, minHeight: number): number {
  return Math.max(minHeight, Math.min(height, areaHeight - BOTTOM_RESERVE_PX))
}

/** True if, positioned at (x, y), at least `margin` px of the window overlaps the work area of at least
 *  one display in `displays` — checked against ALL connected displays, not just whichever one the window
 *  started the drag on. */
export function isReachable(x: number, y: number, width: number, height: number, displays: Rect[], margin: number): boolean {
  const marginW = Math.min(margin, width)
  const marginH = Math.min(margin, height)
  return displays.some((wa) => {
    const overlapW = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
    const overlapH = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
    return overlapW >= marginW && overlapH >= marginH
  })
}

/** Re-apply the work-area height ceiling when a move lands the window on a DIFFERENT display than it
 *  left. Every setBounds on the move/reanchor paths spreads the old bounds, so a window grown to fit a 4K
 *  panel keeps that height when dragged onto a 1080p monitor — hanging far below the bottom edge, where
 *  `resizable:false` leaves no way to fix it. Height only: x/y stay the caller's, except that y is
 *  re-checked, because the caller validated it against the OLD (taller) height and a shorter window can
 *  lose the overlap that made that position reachable. No-op (returns `next` unchanged) when the matched
 *  display didn't change, or the height ceiling didn't move. */
export function refitToDisplay(
  next: Rect,
  matchedDisplayId: number,
  matchedWorkArea: Rect,
  fromDisplayId: number,
  minHeight: number,
  dragVisibleMargin: number
): Rect {
  if (matchedDisplayId === fromDisplayId) return next
  const height = clampHeight(next.height, matchedWorkArea.height, minHeight)
  if (height === next.height) return next
  const y = clampAxisMargin(next.y, height, matchedWorkArea.y, matchedWorkArea.height, dragVisibleMargin)
  return { ...next, height, y }
}

/**
 * Fallback strut (px) when Electron reports no top inset (`workArea.y === bounds.y`, usually 0).
 * Typical notch + menu-bar safe area on a recent MacBook. Used only on path C.
 */
export const ISLAND_NOTCH_STRUT_PX = 37

/**
 * Safe Y for the island peek and the revealed bar (same top edge so hover expands DOWN).
 *
 * Path A: `workArea.y` when Electron reports a top inset — first unobstructed row under the
 * notch / menu bar. Live Mac: `bounds.y = 0` sits *in* the hardware island and clips the capsule.
 * Path C: if `workArea.y` is 0 (or equal to `bounds.y`) on a notched display, apply a strut so
 * the capsule still clears the notch.
 */
export function islandSafeTop(m: DisplayMetrics): number {
  const reserved = m.workArea.y - m.bounds.y
  if (reserved > 0) return m.workArea.y
  if (m.hasNotch) return m.bounds.y + Math.max(m.menuBarHeight || 0, ISLAND_NOTCH_STRUT_PX)
  return m.workArea.y
}

/**
 * Hide and island park at `islandSafeTop` (path A / C). Bar chrome keeps `workArea.y + topMargin`.
 * Non-notch hide/island with a flush work area keeps the small `topMargin` gap (unchanged).
 * Windows: `hasNotch` is false, so this never applies a notch strut.
 */
export function topClamp(layout: OverlayLayout, m: DisplayMetrics, topMargin: number): number {
  if (overlayUsesSafeTop(layout) && (m.hasNotch || m.workArea.y > m.bounds.y)) return islandSafeTop(m)
  return m.workArea.y + topMargin
}

/** Top-center x/y for a window of `width`, on the display described by `m`, honoring the notch clamp.
 *  Used both for the initial window placement (createWindow) and for the auto-hide anchor
 *  (anchorTopCenter) — callers differ only in which `topMargin` they pass. */
export function topCenterPosition(width: number, layout: OverlayLayout, m: DisplayMetrics, topMargin: number): { x: number; y: number } {
  const x = clampAxis(Math.round(m.workArea.x + (m.workArea.width - width) / 2), width, m.workArea.x, m.workArea.width)
  const y = topClamp(layout, m, topMargin)
  return { x, y }
}

/**
 * The x this window's LEFT EDGE should sit at when its width changes from `currentWidth` to `newWidth`,
 * keeping the OLD midpoint (so the overlay appears to grow/shrink from its own center rather than jumping
 * to a new one) — the "peek vs revealed footprint" math shared by `restoreBarWidth` (peek → full bar) and
 * `resizeTo`'s own width-change branch (mini-pill ↔ full bar). Clamped into `workArea` with `margin`.
 */
export function recenterXForWidth(currentX: number, currentWidth: number, newWidth: number, workArea: Rect, margin: number): number {
  const x = currentWidth === newWidth ? currentX : Math.round(currentX + (currentWidth - newWidth) / 2)
  return clampWithMargin(x, newWidth, workArea.x, workArea.width, margin)
}

/** The temporary "slide up so a growing bar stays fully on-screen" y, measured against the window's OWN
 *  anchor (not its current, possibly-already-slid position) so it returns to where the user put it once
 *  the content shrinks again. Used by `resizeTo`. */
export function slideWithinMargin(anchorY: number, height: number, workArea: Rect, margin: number): number {
  return clampWithMargin(anchorY, height, workArea.y, workArea.height, margin)
}

/**
 * Exclusive onboarding stage: cover the display. Width/height are never smaller than the work
 * area (Tony live fail: 880×816 card at Y=39). `bounds.y = 0` is correct HERE — the stage owns
 * the display. The island y=0 ban applies only after `onboardingDone`.
 */
export function exclusiveOnboardingBounds(bounds: Rect, workArea: Rect): Rect {
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(bounds.width, workArea.width),
    height: Math.max(bounds.height, workArea.height)
  }
}

/** True when the window is at least as large as the display work area (wiped-profile acceptance). */
export function onboardingFitsWorkArea(win: Rect, workArea: Rect): boolean {
  return win.width >= workArea.width && win.height >= workArea.height
}

/** Hide-until-hover sliver — keep in lockstep with `.overlay-hide-target` in styles.css. */
export const OVERLAY_HIDE_TARGET = { width: 168, height: 8 } as const
/** Always-visible island peek — keep in lockstep with `.overlay-peek` in styles.css. */
export const OVERLAY_ISLAND_PEEK = { width: 132, height: 15 } as const
/** Matches the windowResize hug-width pad so the strip is not clipped. */
export const OVERLAY_PEEK_WIDTH_PAD = 10
export const OVERLAY_PEEK_HEIGHT_PAD = 4
/** Classic idle bar — used only when chrome is `bar`. */
export const OVERLAY_BAR_REST = { width: 880, height: 84 } as const

/** Tony live fail after onboardingDone on 58f6972: 880×816 layer-0 card at Y=39. */
export function isForbiddenMidFlowCard(win: Pick<Rect, 'width' | 'height'>): boolean {
  return win.width === OVERLAY_BAR_REST.width && win.height >= 700
}

/** Rest size after exclusive exit. Hide/island are a hug-width peek, never the 880-wide bar. */
export function overlayRestSize(layout: OverlayLayout): { width: number; height: number } {
  if (layout === 'bar') return { width: OVERLAY_BAR_REST.width, height: OVERLAY_BAR_REST.height }
  const rest = layout === 'hide' ? OVERLAY_HIDE_TARGET : OVERLAY_ISLAND_PEEK
  return {
    width: rest.width + OVERLAY_PEEK_WIDTH_PAD,
    height: rest.height + OVERLAY_PEEK_HEIGHT_PAD
  }
}

/**
 * Park the overlay after exclusive onboarding ends. Width/height are peek or hide-target
 * (or the classic bar). Y is islandSafeTop (path A / C). Never 880×816.
 */
export function parkAfterExclusiveOnboarding(
  layout: OverlayLayout,
  m: DisplayMetrics,
  topMargin: number
): Rect {
  const size = overlayRestSize(layout)
  const { x, y } = topCenterPosition(size.width, layout, m, topMargin)
  return { x, y, width: size.width, height: size.height }
}

/** Stale exclusive / card measures must not grow a hide/island park back into 880×816. */
export function shouldIgnoreResizeWhilePeekResting(
  resting: boolean,
  reportedHeight: number,
  peekHeight: number
): boolean {
  return resting && reportedHeight > peekHeight + 24
}
