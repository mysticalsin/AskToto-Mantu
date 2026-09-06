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
import { overlayUsesHover } from '@shared/overlay-chrome'
import { SETTINGS_WINDOW_MIN, isFatHoverTrigger as sharedIsFatHoverTrigger } from '@shared/settings-bounds'

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
  // Hide park is OVERLAY_HIDE_PARK (2px). BAR_MIN_HEIGHT 44 must not grow it into a
  // visible sliver after a display move (Tony live: 8×44 at Y=39 on the second display).
  const floor = height <= OVERLAY_HIDE_PARK.height ? height : minHeight
  return Math.max(floor, Math.min(height, areaHeight - BOTTOM_RESERVE_PX))
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

/** Historical hide-slab detector only — never the cursor-watch size. */
export const OVERLAY_HIDE_TARGET = { width: 560, height: 28 } as const
/** Parked hide window: 1–8px fully transparent hairline. Watch uses hoverWatchRestRect, not this. */
export const OVERLAY_HIDE_PARK = { width: 8, height: 2 } as const
/** Always-visible island peek — keep in lockstep with `.overlay-peek` in styles.css. */
export const OVERLAY_ISLAND_PEEK = { width: 132, height: 15 } as const
/** Camera / Dynamic Island square — typical Mac notch width, not a 560 menu-bar slab. */
export const HOVER_ISLAND_WIDTH_MIN_PX = 180
export const HOVER_ISLAND_WIDTH_MAX_PX = 250
/**
 * Typical Teams in-call chrome Y on a notch Mac: just under the menu bar,
 * never in the Dynamic Island. Must not hit hoverWatchRestRect.
 */
export const TEAMS_MEETING_CHROME_Y = 48
/** Under the camera island — typical Teams mute row. Must not hit. */
export const TEAMS_UNDER_ISLAND_Y = 40
/**
 * Always-on top-edge strip cap. Exclusive of Teams mute (Y=40).
 * Ultron 2026-09-06: a 32px housing cap left Y=32–39 dead, so mouse at the
 * menu-bar edge / first work-area row never revealed.
 */
export const HOVER_ISLAND_HEIGHT_MAX_PX = TEAMS_UNDER_ISLAND_Y
/** Matches the windowResize hug-width pad so the island capsule is not clipped. */
export const OVERLAY_PEEK_WIDTH_PAD = 10
export const OVERLAY_PEEK_HEIGHT_PAD = 4
/** Classic idle bar — used only when chrome is `bar`. */
export const OVERLAY_BAR_REST = { width: 880, height: 84 } as const

/**
 * First unobstructed row under the notch / menu bar (bar chrome, exclusive-stage docs).
 *
 * Path A: `workArea.y` when Electron reports a top inset.
 * Path C: if `workArea.y` is 0 on a notched display, apply a strut so content that must
 * clear the notch still has a row. Hide/island hover rest does NOT use this — they park
 * at `hoverRestTop` (`bounds.y`) so the hardware island / top-center strip can hit them.
 */
export function islandSafeTop(m: DisplayMetrics): number {
  const reserved = m.workArea.y - m.bounds.y
  if (reserved > 0) return m.workArea.y
  if (m.hasNotch) return m.bounds.y + Math.max(m.menuBarHeight || 0, ISLAND_NOTCH_STRUT_PX)
  return m.workArea.y
}

/** Physical top of the display — hide/island *rest* / cursor-watch hit rect only. Revealed chrome uses `islandSafeTop`. */
export function hoverRestTop(m: DisplayMetrics): number {
  return m.bounds.y
}

/**
 * Height of the always-on top-edge hover strip.
 *
 * Use the reserved menu-bar / notch inset whenever Electron reports one, even
 * if the helper said hasNotch=false. Approach from below lands on the first
 * work-area row (`workArea.y` ≈ 39). Include that row. Never reach Teams mute
 * at Y=40 or a leftover 44px slab. Path C flush (no inset) stays peek-tall.
 * Windows: no fake notch when reserved is 0.
 */
export function hoverHitBandHeight(m: DisplayMetrics): number {
  const reserved = Math.max(0, m.workArea.y - m.bounds.y, m.menuBarHeight || 0)
  const housing = reserved > 0 ? reserved : OVERLAY_ISLAND_PEEK.height
  const approach = reserved > 0 ? housing + 1 : housing
  return Math.max(1, Math.min(approach, HOVER_ISLAND_HEIGHT_MAX_PX))
}

export function hoverRestHeight(m: DisplayMetrics): number {
  return hoverHitBandHeight(m)
}

/** Full-width top-edge approach strip. Camera island is included; left/right top edge also hits. */
export function hoverRestWidth(m: DisplayMetrics): number {
  return Math.max(1, m.workArea.width)
}

/**
 * Logical rest rect the cursor watch hit-tests. Hide does NOT park the window here
 * (that was the visible 560×44 slab). Island keeps a smaller visible peek at the same Y.
 * Watch is the always-on top-edge approach band (work-area-wide, menu-bar-tall
 * plus the first work-area row) so Hide/Island reveal without hunting Show Métis.
 */
export function hoverWatchRestRect(_layout: OverlayLayout, m: DisplayMetrics): Rect {
  const height = hoverRestHeight(m)
  const width = hoverRestWidth(m)
  return { x: m.workArea.x, y: hoverRestTop(m), width, height }
}

/**
 * Revealed chrome Y. Hide/island sit at `islandSafeTop` (below the notch — macOS
 * clamps here anyway). Rest/watch still use `hoverRestTop`. Bar keeps `workArea.y + topMargin`.
 */
export function topClamp(layout: OverlayLayout, m: DisplayMetrics, topMargin: number): number {
  if (overlayUsesHover(layout)) return islandSafeTop(m)
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
 * the display. After `onboardingDone`, hide/island also rest at `bounds.y` (the notch strip)
 * so the hardware island can hit them — never as an 880×816 card.
 */
export function exclusiveOnboardingBounds(bounds: Rect, workArea: Rect): Rect {
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(bounds.width, workArea.width),
    height: Math.max(bounds.height, workArea.height)
  }
}

/**
 * Totos-Mac 1.8.3 tip 044c0f1: `transparent: true` + `setSimpleFullScreen(true)` composites as
 * a 3600×2338 RGBA(0,0,0,0) void. Exclusive onboarding is opaque Mantu purple. After
 * `onboardingDone` the overlay is transparent again. `transparent` is constructor-only
 * (Electron 39) — enter/exit recreate the window when chrome no longer matches.
 */
export const EXCLUSIVE_ONBOARDING_BACKGROUND = '#3A0B6B'
export const OVERLAY_TRANSPARENT_BACKGROUND = '#00000000'

export interface OverlayWindowChrome {
  transparent: boolean
  backgroundColor: string
  fullscreenable: boolean
  roundedCorners: boolean
}

export function overlayWindowChrome(onboardingLive: boolean): OverlayWindowChrome {
  if (onboardingLive) {
    return {
      transparent: false,
      backgroundColor: EXCLUSIVE_ONBOARDING_BACKGROUND,
      fullscreenable: true,
      roundedCorners: false
    }
  }
  return {
    transparent: true,
    backgroundColor: OVERLAY_TRANSPARENT_BACKGROUND,
    fullscreenable: false,
    roundedCorners: true
  }
}

/** Mac simple-fullscreen on a transparent BrowserWindow is a dead black void. Never. */
export function exclusiveMayUseSimpleFullScreen(transparent: boolean): boolean {
  return transparent === false
}

/** True when the window is at least as large as the display work area (wiped-profile acceptance). */
export function onboardingFitsWorkArea(win: Rect, workArea: Rect): boolean {
  return win.width >= workArea.width && win.height >= workArea.height
}

/** Tony live fail after onboardingDone on 58f6972: 880×816 layer-0 card at Y=39. */
export function isForbiddenMidFlowCard(win: Pick<Rect, 'width' | 'height'>): boolean {
  return win.width === OVERLAY_BAR_REST.width && win.height >= 816
}

/** Rest size after exclusive exit / createWindow. Hide is a 1–8px invisible hairline. Island hugs the peek. */
export function overlayRestSize(layout: OverlayLayout, m?: DisplayMetrics): { width: number; height: number } {
  if (layout === 'bar') return { width: OVERLAY_BAR_REST.width, height: OVERLAY_BAR_REST.height }
  if (layout === 'hide') return { width: OVERLAY_HIDE_PARK.width, height: OVERLAY_HIDE_PARK.height }
  return {
    width: OVERLAY_ISLAND_PEEK.width + OVERLAY_PEEK_WIDTH_PAD,
    height: OVERLAY_ISLAND_PEEK.height + OVERLAY_PEEK_HEIGHT_PAD
  }
}

/** Parked hide window: tiny, fully transparent. Cursor watch still uses hoverWatchRestRect. */
export function hideParkRect(m: DisplayMetrics): Rect {
  const { width, height } = OVERLAY_HIDE_PARK
  const x = clampAxis(
    Math.round(m.workArea.x + (m.workArea.width - width) / 2),
    width,
    m.workArea.x,
    m.workArea.width
  )
  return { x, y: hoverRestTop(m), width, height }
}

/** Ultron CGWindowList live FAIL: 8×2 at y=39 painting opaque Mantu purple. */
export const ULTRON_PURPLE_HAIRLINE = {
  width: OVERLAY_HIDE_PARK.width,
  height: OVERLAY_HIDE_PARK.height,
  y: 39,
  background: EXCLUSIVE_ONBOARDING_BACKGROUND,
  opacity: 1
} as const

export function isTransparentOverlayBackground(color?: string): boolean {
  if (color == null) return false
  const n = color.trim().toLowerCase()
  if (n === 'transparent' || n === '#0000' || n === OVERLAY_TRANSPARENT_BACKGROUND.toLowerCase()) return true
  // #RGBA / #RRGGBBAA with alpha 0
  if (n.startsWith('#') && (n.length === 5 || n.length === 9) && n.endsWith('00')) return true
  return false
}

export function isOpaqueMantuPurple(color?: string): boolean {
  return (color ?? '').trim().toLowerCase() === EXCLUSIVE_ONBOARDING_BACKGROUND.toLowerCase()
}

/**
 * Hide park window opacity. Hide rest is gone (0) so Electron clamping the
 * 8×2 hairline to workArea.y≈39 cannot paint a visible sliver. Island peek,
 * Bar, Settings, and exclusive onboarding stay 1. Cursor watch does not use
 * this window — hoverWatchRestRect still reveals.
 */
export function hideParkWindowOpacity(layout: OverlayLayout, resting: boolean): number {
  return layout === 'hide' && resting ? 0 : 1
}

/**
 * True when the parked hide window cannot be seen: opacity 0, fully above
 * the display top, or transparent at bounds.y (behind the menu bar).
 */
export function hideParkIsVisuallyClear(input: {
  y: number
  boundsY: number
  width?: number
  height?: number
  background?: string
  opacity?: number
}): boolean {
  if ((input.opacity ?? 1) <= 0) return true
  const height = input.height ?? OVERLAY_HIDE_PARK.height
  if (input.y + height <= input.boundsY) return true
  return input.y === input.boundsY && isTransparentOverlayBackground(input.background ?? OVERLAY_TRANSPARENT_BACKGROUND)
}

/**
 * Ultron / Tony live: 8×2 at workArea.y≈39 with opaque purple (or any visible
 * paint) is FAIL. Opacity 0, off-screen rest, or transparent + bounds.y pass.
 */
export function isForbiddenHideParkHairline(input: {
  width: number
  height: number
  y: number
  workAreaY: number
  boundsY: number
  background?: string
  opacity?: number
}): boolean {
  if (input.width !== OVERLAY_HIDE_PARK.width || input.height !== OVERLAY_HIDE_PARK.height) return false
  if (hideParkIsVisuallyClear(input)) return false
  const clampedToWorkArea = Math.abs(input.y - input.workAreaY) <= 1 && input.workAreaY > input.boundsY
  return clampedToWorkArea
}

/**
 * Display topology change while hide/island is parked.
 * Re-apply the rest rect on the NEW display. Never clampHeight (BAR_MIN_HEIGHT 44)
 * and never slide y into workArea (Tony live after a display move: 8×44 at Y=39).
 * Hide park at bounds.y is "off" the work area on a notch Mac (workArea.y ≈ 39);
 * that is correct, not a reason to grow the hairline.
 */
export function parkedHoverReanchor(
  layout: OverlayLayout,
  resting: boolean,
  nextDisplay: DisplayMetrics,
  topMargin: number
): Rect | null {
  if (!resting || !overlayUsesHover(layout)) return null
  return parkAfterExclusiveOnboarding(layout, nextDisplay, topMargin)
}

/** Tony live fails: 560×44 slab and 560×103 stub. Hide rest must not look like either. */
export function isVisibleHideSlab(win: Pick<Rect, 'width' | 'height'>): boolean {
  return win.height > OVERLAY_HIDE_PARK.height || (win.width >= 220 && win.height >= 20)
}

/**
 * Park the overlay after exclusive onboarding ends. Hide is a 1–8px transparent hairline
 * at `bounds.y` (watch rect stays the notch strip). Island is the peek at the same Y.
 * Bar is classic rest at `workArea.y + margin`. Never 880×816.
 */
export function parkAfterExclusiveOnboarding(
  layout: OverlayLayout,
  m: DisplayMetrics,
  topMargin: number
): Rect {
  if (layout === 'hide') return hideParkRect(m)
  const size = overlayRestSize(layout, m)
  if (layout === 'island') {
    const x = clampAxis(
      Math.round(m.workArea.x + (m.workArea.width - size.width) / 2),
      size.width,
      m.workArea.x,
      m.workArea.width
    )
    return { x, y: hoverRestTop(m), width: size.width, height: size.height }
  }
  const { x, y } = topCenterPosition(size.width, layout, m, topMargin)
  return { x, y, width: size.width, height: size.height }
}

/**
 * First-paint window bounds. While `!onboardingDone` this is the exclusive stage —
 * never Hide/Island 8×2 park. Overlay geometry must not change until onboardingDone.
 */
export function firstPaintOverlayBounds(input: {
  onboardingDone: boolean
  bounds: Rect
  workArea: Rect
  layout: OverlayLayout
  metrics: DisplayMetrics
  topMargin: number
}): Rect {
  if (!input.onboardingDone) return exclusiveOnboardingBounds(input.bounds, input.workArea)
  return parkAfterExclusiveOnboarding(input.layout, input.metrics, input.topMargin)
}

/** Stale exclusive / card measures must not grow a hide/island park back into 880×816.
 *  Also swallows the ~100px hide stub (Tony live: 560×103 at Y=39) while resting. */
export function shouldIgnoreResizeWhilePeekResting(
  resting: boolean,
  reportedHeight: number,
  peekHeight: number
): boolean {
  return resting && reportedHeight > peekHeight + 24
}

/**
 * Leaving ControlPill or Settings back to hide/island: park the hover rest when the
 * pointer is not in the island strip or the revealed bar. The pill itself does not count
 * as the bar — expanding it on Hide must disappear, not restore a ~100px stub.
 */
export function shouldParkHoverRestAfterLeavingSurface(input: {
  layout: OverlayLayout
  pointerInIslandOrBar: boolean
}): boolean {
  return overlayUsesHover(input.layout) && !input.pointerInIslandOrBar
}

/**
 * Full Settings surface. Revealed chrome Y (below the notch), never Hide 8×2 or Island peek.
 * Width/height are Apple-grade Settings mins. Hide/Island park after close, not here.
 */
export function settingsOpenRect(m: DisplayMetrics, _topMargin: number): Rect {
  const width = SETTINGS_WINDOW_MIN.width
  const height = SETTINGS_WINDOW_MIN.height
  const x = clampAxis(
    Math.round(m.workArea.x + (m.workArea.width - width) / 2),
    width,
    m.workArea.x,
    m.workArea.width
  )
  return { x, y: islandSafeTop(m), width, height }
}

/** Leftover 880×133 at workArea.y. Must park Hide/Island instead of leaving this trigger. */
export function isLeftoverSettingsTrigger(win: Pick<Rect, 'width' | 'height' | 'y'>, m: DisplayMetrics): boolean {
  return sharedIsFatHoverTrigger(win, m.workArea.y)
}
