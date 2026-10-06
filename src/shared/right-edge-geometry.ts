/**
 * right-edge-geometry.ts — the one geometry authority for the right-edge overlay (M2-0202, spec v3 §2).
 * Pure: no Electron, no DOM. Main resolves the live display and hands the work area in; the renderer reads
 * the same constants. Every right-edge rect (open window, rest, reveal band, hold region, Reader) is a
 * function of the work area and the anchor A, the handle centre's y in DIP.
 *
 * Invariants:
 * - A = wa.y + f·wa.h, clamped to [wa.y+84, wa.bottom−84]; f is what is persisted per display.
 * - The reveal band is [wa.y+48, wa.bottom−48] for every A and every content height, so streaming never
 *   moves it, and the handle [A−36, A+36] always lies inside it.
 * - Park and rest rects lie inside the work area at the stored anchor (never at y=0, DEV-RE-5).
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Breathing room between every right-edge surface and the work-area edges. */
export const RIGHT_EDGE_MARGIN_PX = 12
/** Default handle centre, normalized to the work-area height (kit §5.10 "Reset position"). */
export const RIGHT_EDGE_DEFAULT_ANCHOR = 0.15
/** A stays this far from the work-area top and bottom. */
export const RIGHT_EDGE_ANCHOR_INSET_PX = 84
/** The card's top sits this far above A: the handle centre lines up with the header row. */
export const RIGHT_EDGE_CARD_ANCHOR_OFFSET_PX = 36
/** The reveal band leaves this much of each work-area corner free. */
export const RIGHT_EDGE_BAND_CORNER_PX = 48
/** Width (px) of the reveal band: the pointer pushed against the edge always lands inside it (M2-0428). */
export const RIGHT_EDGE_REVEAL_BAND_PX = 4

export const RIGHT_EDGE_CARD_WIDTH = 344
export const RIGHT_EDGE_CARD_MIN_HEIGHT = 200
/** H_max = wa.h − this. */
export const RIGHT_EDGE_CARD_HEIGHT_RESERVE_PX = 40
export const RIGHT_EDGE_HANDLE = { width: 24, height: 72 } as const
export const RIGHT_EDGE_READER_MAX_WIDTH = 720

/** Legacy sidecar (S1 until the S5 flip): the open drawer and the Island rail tab. */
export const RIGHT_EDGE_TAB_WIDTH = 52
export const RIGHT_EDGE_TAB_HEIGHT = 52
export const RIGHT_EDGE_DRAWER_WIDTH = 360
export const RIGHT_EDGE_DRAWER_MAX_HEIGHT = 560
/** The legacy tab's centre sat this far below its top. */
const LEGACY_TAB_CENTRE_OFFSET_PX = 26

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function bottom(wa: Rect): number {
  return wa.y + wa.height
}

function right(wa: Rect): number {
  return wa.x + wa.width
}

/** The right edge the pointer stops at. Edge classes (S6) may move it to the display edge. */
function edgeOf(wa: Rect, edgeX?: number): number {
  return edgeX ?? right(wa)
}

/** The anchor A (handle-centre y) for a stored fraction f on this work area. */
export function anchorY(wa: Rect, f: number = RIGHT_EDGE_DEFAULT_ANCHOR): number {
  const fraction = Number.isFinite(f) ? f : RIGHT_EDGE_DEFAULT_ANCHOR
  return clamp(
    Math.round(wa.y + fraction * wa.height),
    wa.y + RIGHT_EDGE_ANCHOR_INSET_PX,
    bottom(wa) - RIGHT_EDGE_ANCHOR_INSET_PX
  )
}

/** The fraction f persisted for a handle centre at `centreY` (inverse of anchorY inside its clamp). */
export function anchorFraction(wa: Rect, centreY: number): number {
  if (wa.height <= 0) return RIGHT_EDGE_DEFAULT_ANCHOR
  return clamp((centreY - wa.y) / wa.height, 0, 1)
}

/** H_max: the tallest card the work area holds. */
export function islandMaxHeight(wa: Rect): number {
  return wa.height - RIGHT_EDGE_CARD_HEIGHT_RESERVE_PX
}

/** The smallest work area the right edge serves (RE-G09); 853x432 (1280x720 at Windows 150%) still fits. */
export const RIGHT_EDGE_MIN_WORK_AREA = { width: 384, height: 432 } as const

export function rightEdgeFits(wa: Rect): boolean {
  return wa.width >= RIGHT_EDGE_MIN_WORK_AREA.width && wa.height >= RIGHT_EDGE_MIN_WORK_AREA.height
}

/** The island card's fixed chrome around its content slot: header 44, composer 52, action rail 44 and the
 *  card's 8 px top and bottom padding. */
export const RIGHT_EDGE_ISLAND_CHROME_PX = 156

/** The tallest content slot the tallest card holds. */
export function islandSlotMax(wa: Rect): number {
  return Math.max(0, islandMaxHeight(wa) - RIGHT_EDGE_ISLAND_CHROME_PX)
}

/** H = clamp(ceil8(contentHeight), 200, H_max). */
export function islandHeight(wa: Rect, contentHeight: number): number {
  const content = Number.isFinite(contentHeight) ? contentHeight : RIGHT_EDGE_CARD_MIN_HEIGHT
  return clamp(Math.ceil(content / 8) * 8, RIGHT_EDGE_CARD_MIN_HEIGHT, islandMaxHeight(wa))
}

/** The card grows down from A−36 and moves up only once it reaches the bottom margin. */
export function cardTop(wa: Rect, a: number, height: number): number {
  return clamp(
    a - RIGHT_EDGE_CARD_ANCHOR_OFFSET_PX,
    wa.y + RIGHT_EDGE_MARGIN_PX,
    bottom(wa) - RIGHT_EDGE_MARGIN_PX - height
  )
}

/** The island window, which is exactly the card (no transparent gutter). */
export function islandRect(wa: Rect, a: number, contentHeight: number): Rect {
  const height = islandHeight(wa, contentHeight)
  return {
    x: right(wa) - RIGHT_EDGE_MARGIN_PX - RIGHT_EDGE_CARD_WIDTH,
    y: cardTop(wa, a, height),
    width: RIGHT_EDGE_CARD_WIDTH,
    height
  }
}

/** The legacy open window: the `.right-edge-sidecar` drawer is `inset: 0`, so the window is the drawer. */
export function legacyDrawerRect(wa: Rect, a: number): Rect {
  const height = Math.min(RIGHT_EDGE_DRAWER_MAX_HEIGHT, wa.height - RIGHT_EDGE_MARGIN_PX * 2)
  return {
    x: right(wa) - RIGHT_EDGE_MARGIN_PX - RIGHT_EDGE_DRAWER_WIDTH,
    y: clamp(
      a - RIGHT_EDGE_CARD_ANCHOR_OFFSET_PX,
      wa.y + RIGHT_EDGE_MARGIN_PX,
      bottom(wa) - RIGHT_EDGE_MARGIN_PX - height
    ),
    width: RIGHT_EDGE_DRAWER_WIDTH,
    height
  }
}

/** The legacy Island rest: the 52x52 rail tab, centred on A where the margins allow. */
export function legacyTabRect(wa: Rect, a: number): Rect {
  return {
    x: right(wa) - RIGHT_EDGE_MARGIN_PX - RIGHT_EDGE_TAB_WIDTH,
    y: clamp(
      a - LEGACY_TAB_CENTRE_OFFSET_PX,
      wa.y + RIGHT_EDGE_MARGIN_PX,
      bottom(wa) - RIGHT_EDGE_MARGIN_PX - RIGHT_EDGE_TAB_HEIGHT
    ),
    width: RIGHT_EDGE_TAB_WIDTH,
    height: RIGHT_EDGE_TAB_HEIGHT
  }
}

/**
 * The reveal band: M2-0428's 4 px strip flush with the edge, spanning the tallest card's y extent less the
 * 48 px corners. cardTop(A, H_max) is wa.y+28 for every A, so the span is [wa.y+48, wa.bottom−48]: the
 * band never depends on A or on the content height.
 */
export function revealBand(wa: Rect, a: number, edgeX?: number): Rect {
  const tallest = islandMaxHeight(wa)
  const top = Math.max(cardTop(wa, a, tallest), wa.y + RIGHT_EDGE_BAND_CORNER_PX)
  const end = Math.min(cardTop(wa, a, tallest) + tallest, bottom(wa) - RIGHT_EDGE_BAND_CORNER_PX)
  const edge = edgeOf(wa, edgeX)
  return {
    x: edge - RIGHT_EDGE_REVEAL_BAND_PX,
    y: top,
    width: RIGHT_EDGE_REVEAL_BAND_PX,
    height: Math.max(0, end - top)
  }
}

/** 'none' is M2-0428's Hide park (the invisible band); 'handle' is the 24x72 rest window centred on A. */
export type RightEdgeRestKind = 'none' | 'handle'

export function restRect(kind: RightEdgeRestKind, wa: Rect, a: number, edgeX?: number): Rect {
  if (kind === 'none') return revealBand(wa, a, edgeX)
  const edge = edgeOf(wa, edgeX)
  return {
    x: edge - RIGHT_EDGE_HANDLE.width,
    y: a - RIGHT_EDGE_HANDLE.height / 2,
    width: RIGHT_EDGE_HANDLE.width,
    height: RIGHT_EDGE_HANDLE.height
  }
}

/** The Reader document surface, at the same edge and the full work-area height less the margins. */
export function readerRect(wa: Rect): Rect {
  const width = Math.min(RIGHT_EDGE_READER_MAX_WIDTH, wa.width - RIGHT_EDGE_MARGIN_PX * 2)
  return {
    x: right(wa) - RIGHT_EDGE_MARGIN_PX - width,
    y: wa.y + RIGHT_EDGE_MARGIN_PX,
    width,
    height: wa.height - RIGHT_EDGE_MARGIN_PX * 2
  }
}

/**
 * After a band reveal the open rect can sit far from the point the pointer revealed it at. Until the
 * pointer first enters it, the corridor from the reveal point's y to the rect's nearest edge (across the
 * rect's x span to the edge) holds it open, so a diagonal move into it is not a leave. Null when the
 * reveal point already lies within the rect's y span.
 */
export function revealCorridor(openRect: Rect, revealY: number, edgeX: number): Rect | null {
  const top = openRect.y
  const end = openRect.y + openRect.height
  if (revealY >= top && revealY < end) return null
  const y = Math.min(revealY, end)
  const height = revealY < top ? top - revealY : revealY - end + 1
  return { x: openRect.x, y, width: edgeX - openRect.x, height }
}

function grow(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
}

/**
 * Where the pointer keeps a revealed right-edge surface open (leave detection): the union of the live
 * open rect widened to the edge over its y span, the reveal band and, after a band reveal, the corridor,
 * each grown by `gracePx`. A pointer resting anywhere on the band keeps an edge-revealed surface open.
 */
export function holdRegion(
  wa: Rect,
  openRect: Rect,
  a: number,
  options: { gracePx: number; edgeX?: number; corridor?: Rect | null }
): Rect[] {
  const edge = edgeOf(wa, options.edgeX)
  const toEdge = {
    x: openRect.x,
    y: openRect.y,
    width: Math.max(openRect.width, edge - openRect.x),
    height: openRect.height
  }
  const region = [toEdge, revealBand(wa, a, edge)]
  if (options.corridor) region.push(options.corridor)
  return region.map((rect) => grow(rect, options.gracePx))
}

export function pointInRegion(point: { x: number; y: number }, region: readonly Rect[]): boolean {
  return region.some(
    (rect) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
  )
}

/**
 * The legacy tab's centre for a legacy normalized Y (`overlayRightEdgeYByDisplay`): the tab top spans
 * [wa.y+12, wa.bottom−64], so the centre spans [wa.y+38, wa.bottom−38].
 */
export function legacyTabCentreY(wa: Rect, legacyNormalizedY: number): number {
  const min = wa.y + RIGHT_EDGE_MARGIN_PX
  const max = bottom(wa) - RIGHT_EDGE_TAB_HEIGHT - RIGHT_EDGE_MARGIN_PX
  return Math.round(min + (max - min) * clamp(legacyNormalizedY, 0, 1)) + LEGACY_TAB_CENTRE_OFFSET_PX
}

/** Settings keys: the anchor fraction, and the legacy normalized Y it migrates from (read-only for one release). */
export const RIGHT_EDGE_ANCHOR_KEY = 'overlayRightEdgeAnchorByDisplay'
export const RIGHT_EDGE_LEGACY_Y_KEY = 'overlayRightEdgeYByDisplay'

/** A lock on either key locks the anchor: the legacy key is still the one older policies manage. */
export function rightEdgeAnchorLocked(lockedKeys: readonly string[]): boolean {
  return lockedKeys.includes(RIGHT_EDGE_ANCHOR_KEY) || lockedKeys.includes(RIGHT_EDGE_LEGACY_Y_KEY)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Lazy per-display migration. The stored anchor wins, except under a lock on the legacy key, where the
 * managed legacy value does. A display with only a legacy value converts on its first resolve, keeping the
 * handle centre where the legacy tab's centre was; `persist` says the caller should write the converted f
 * (never under a lock). A display with neither gets the default.
 */
export function resolveRightEdgeAnchor(input: {
  workArea: Rect
  anchor?: number
  legacyY?: number
  lockedKeys?: readonly string[]
}): { f: number; persist: boolean } {
  const locked = input.lockedKeys ?? []
  const legacyManaged = locked.includes(RIGHT_EDGE_LEGACY_Y_KEY) && finite(input.legacyY)
  if (finite(input.anchor) && !legacyManaged) return { f: clamp(input.anchor, 0, 1), persist: false }
  if (finite(input.legacyY)) {
    const f = anchorFraction(input.workArea, legacyTabCentreY(input.workArea, input.legacyY))
    return { f, persist: !rightEdgeAnchorLocked(locked) }
  }
  return { f: RIGHT_EDGE_DEFAULT_ANCHOR, persist: false }
}
