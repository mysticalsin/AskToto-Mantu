import { z } from 'zod'

/**
 * Screen marks (G43, CAP-25, R031/R032): pointing marks that Métis draws over the screen, each bound to the
 * screenshot it was derived from and to the coordinate transform that was true when it was placed.
 *
 * A mark lives in SCREENSHOT PIXEL space. It is shown only while the live screen observation (G16) is still the
 * very screenshot it names: same observation id, same revocation generation, same display. A newer screenshot,
 * a revocation or another display makes the mark stale, and a stale mark is dropped, never re-projected onto
 * different pixels. When the same screenshot is still current but the display's scale or bounds changed
 * (a DPI change), the transform is recomputed from the live geometry; if that cannot be done the mark is hidden.
 *
 * Pure and Electron-free. A mark carries no screenshot pixels and no screen text: the renderer-safe MarkView is
 * geometry in display points plus, for a label anchor, a step number.
 */

const pixel = z.number().finite().min(0).max(100_000)
const extent = z.number().finite().min(0.5).max(100_000)
const pointSchema = z.object({ x: pixel, y: pixel }).strict()

export const MAX_SCREEN_MARKS = 24
/** The walkthrough budget (R033): a label anchor numbers a step within it. */
export const MAX_MARK_STEP_NUMBER = 15

export const ScreenMarkShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), x: pixel, y: pixel }).strict(),
  z.object({ kind: z.literal('box'), x: pixel, y: pixel, width: extent, height: extent }).strict(),
  z.object({ kind: z.literal('arrow'), from: pointSchema, to: pointSchema }).strict(),
  z
    .object({
      kind: z.literal('label-anchor'),
      x: pixel,
      y: pixel,
      stepNumber: z.number().int().min(1).max(MAX_MARK_STEP_NUMBER).optional()
    })
    .strict()
])
export type ScreenMarkShape = z.infer<typeof ScreenMarkShapeSchema>
export type ScreenMarkKind = ScreenMarkShape['kind']

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface Point {
  x: number
  y: number
}

/** How screenshot pixels become display points: `point = offset + pixel / scale`, relative to the display origin. */
export interface MarkTransform {
  /** Screenshot pixels per display point (2 for a full-resolution Retina capture, 1 for a downscaled one). */
  scale: number
  /** Where the screenshot's top-left corner sits on the display, in display points (non-zero for a region). */
  offsetX: number
  offsetY: number
  /** The display's bounds, in global points, when the transform was derived. */
  displayBounds: Rect
}

export interface ScreenMark {
  markId: string
  /** The observation id of the screenshot this mark was derived from (G16 ScreenObservationIdentity). */
  screenshotId: string
  /** The revocation generation of that observation. */
  generation: number
  displayId: number
  shape: ScreenMarkShape
  transform: MarkTransform
}

/** What the live screen observation looks like right now, joined with the display's current geometry. */
export interface LiveObservation {
  observationId: string
  generation: number
  displayId: number
  /** The display's CURRENT bounds in points (changes with a scale or resolution change). */
  displayBounds: Rect
  /** The size of the screenshot in pixels. */
  screenshot: { width: number; height: number }
  /** The captured region as fractions of the display, for a region capture. */
  region?: Rect
}

const round = (n: number): number => Math.round(n * 1e4) / 1e4

/** Derive the transform from the live geometry, or null when it has none that can be trusted. */
export function deriveMarkTransform(live: LiveObservation): MarkTransform | null {
  const { displayBounds: bounds, screenshot, region } = live
  const widthPoints = (region ? region.width : 1) * bounds.width
  const heightPoints = (region ? region.height : 1) * bounds.height
  if (![widthPoints, heightPoints, screenshot.width, screenshot.height].every((n) => Number.isFinite(n) && n > 0)) {
    return null
  }
  return {
    scale: round(screenshot.width / widthPoints),
    offsetX: region ? round(region.x * bounds.width) : 0,
    offsetY: region ? round(region.y * bounds.height) : 0,
    displayBounds: { ...bounds }
  }
}

/** A screenshot pixel as a point relative to the display origin (the annotation window's own origin). */
export function mapPointToDisplay(transform: MarkTransform, pixelPoint: Point): Point {
  return {
    x: round(transform.offsetX + pixelPoint.x / transform.scale),
    y: round(transform.offsetY + pixelPoint.y / transform.scale)
  }
}

/** The renderer-safe view of a visible mark, in display points. No pixels, no screen text. */
export type MarkView =
  | { markId: string; kind: 'point'; x: number; y: number }
  | { markId: string; kind: 'box'; x: number; y: number; width: number; height: number }
  | { markId: string; kind: 'arrow'; from: Point; to: Point }
  | { markId: string; kind: 'label-anchor'; x: number; y: number; stepNumber?: number }

const finite = z.number().finite()
const viewPoint = z.object({ x: finite, y: finite }).strict()
export const MarkViewSchema = z.discriminatedUnion('kind', [
  z.object({ markId: z.string().min(1).max(64), kind: z.literal('point'), x: finite, y: finite }).strict(),
  z
    .object({
      markId: z.string().min(1).max(64),
      kind: z.literal('box'),
      x: finite,
      y: finite,
      width: finite,
      height: finite
    })
    .strict(),
  z.object({ markId: z.string().min(1).max(64), kind: z.literal('arrow'), from: viewPoint, to: viewPoint }).strict(),
  z
    .object({
      markId: z.string().min(1).max(64),
      kind: z.literal('label-anchor'),
      x: finite,
      y: finite,
      stepNumber: z.number().int().min(1).max(MAX_MARK_STEP_NUMBER).optional()
    })
    .strict()
])
export const MarkViewListSchema = z.array(MarkViewSchema).max(MAX_SCREEN_MARKS)

export type MarkHideReason =
  | 'no-observation'
  | 'stale-screenshot'
  | 'stale-generation'
  | 'other-display'
  | 'no-transform'
  | 'off-display'

export type MarkResolution =
  | { visible: true; view: MarkView; recomputed: boolean }
  | { visible: false; reason: MarkHideReason }

const sameTransform = (a: MarkTransform, b: MarkTransform): boolean =>
  a.scale === b.scale &&
  a.offsetX === b.offsetX &&
  a.offsetY === b.offsetY &&
  a.displayBounds.width === b.displayBounds.width &&
  a.displayBounds.height === b.displayBounds.height

function project(shape: ScreenMarkShape, markId: string, t: MarkTransform): MarkView {
  switch (shape.kind) {
    case 'point':
      return { markId, kind: 'point', ...mapPointToDisplay(t, shape) }
    case 'label-anchor':
      return {
        markId,
        kind: 'label-anchor',
        ...mapPointToDisplay(t, shape),
        ...(shape.stepNumber === undefined ? {} : { stepNumber: shape.stepNumber })
      }
    case 'box': {
      const origin = mapPointToDisplay(t, shape)
      return {
        markId,
        kind: 'box',
        ...origin,
        width: round(shape.width / t.scale),
        height: round(shape.height / t.scale)
      }
    }
    case 'arrow':
      return { markId, kind: 'arrow', from: mapPointToDisplay(t, shape.from), to: mapPointToDisplay(t, shape.to) }
  }
}

function viewBounds(view: MarkView): Rect {
  if (view.kind === 'box') return { x: view.x, y: view.y, width: view.width, height: view.height }
  if (view.kind === 'arrow') {
    const x = Math.min(view.from.x, view.to.x)
    const y = Math.min(view.from.y, view.to.y)
    return { x, y, width: Math.abs(view.to.x - view.from.x), height: Math.abs(view.to.y - view.from.y) }
  }
  return { x: view.x, y: view.y, width: 0, height: 0 }
}

/**
 * Resolve a mark against the live observation. The screenshot id, generation and display must all still match;
 * the transform is then taken from the live geometry, so a DPI or bounds change moves the mark with the display.
 */
export function resolveMark(mark: ScreenMark, live: LiveObservation | null): MarkResolution {
  if (!live) return { visible: false, reason: 'no-observation' }
  if (live.observationId !== mark.screenshotId) return { visible: false, reason: 'stale-screenshot' }
  if (live.generation !== mark.generation) return { visible: false, reason: 'stale-generation' }
  if (live.displayId !== mark.displayId) return { visible: false, reason: 'other-display' }
  const transform = deriveMarkTransform(live)
  if (!transform) return { visible: false, reason: 'no-transform' }
  const view = project(mark.shape, mark.markId, transform)
  const box = viewBounds(view)
  const { width, height } = live.displayBounds
  if (box.x > width || box.y > height || box.x + box.width < 0 || box.y + box.height < 0) {
    return { visible: false, reason: 'off-display' }
  }
  return { visible: true, view, recomputed: !sameTransform(mark.transform, transform) }
}

/** The one channel shipping builds use: main to the annotation window. Preloads repeat it as a literal; a test pins it. */
export const SCREEN_MARKS_IPC = { marks: 'annotation:marks' } as const

export type PlaceMarkRefusal =
  | 'no-observation'
  | 'stale-screenshot'
  | 'stale-generation'
  | 'no-transform'
  | 'out-of-image'
  | 'too-many'
export type PlaceMarkResult = { ok: true; markId: string } | { ok: false; reason: PlaceMarkRefusal }
