import {
  deriveMarkTransform,
  MAX_SCREEN_MARKS,
  resolveMark,
  ScreenMarkShapeSchema,
  type LiveObservation,
  type MarkView,
  type PlaceMarkResult,
  type Rect,
  type ScreenMark,
  type ScreenMarkShape
} from '@shared/screen-marks'

/**
 * Screen marks store (G43, CAP-25): the marks Métis currently draws, each bound to the screenshot it came from.
 *
 * The store learns the live screenshot only through noteFrame() (called by the G16 observation when it issues a
 * frame). A mark can be placed only on THAT screenshot. When a newer screenshot, another generation or another
 * display becomes live, the older marks are deleted (never re-projected). A scale or bounds change on the same
 * screenshot recomputes the projection from the display's current bounds; a display that is gone hides its marks
 * until it returns. clear() ends everything: Stop, lock, sign-out, Private View, permission loss.
 *
 * Electron-free; the display geometry is injected.
 */

/** What the observation reports about a frame it just issued. No pixels. */
export interface FrameNote {
  observationId: string
  generation: number
  displayId: number
  screenshot: { width: number; height: number }
  /** For a region capture: the region as fractions of the display. */
  region?: Rect
}

export interface ScreenMarksDeps {
  /** The display's current bounds in points, or null when that display is gone. */
  displayBounds: (displayId: number) => Rect | null
  newId: () => string
}

export interface ScreenMarks {
  noteFrame(frame: FrameNote): void
  place(input: { screenshotId: string; shape: ScreenMarkShape }): PlaceMarkResult
  remove(markId: string): boolean
  /** Forget every mark and the live screenshot. */
  clear(reason: string): void
  /** Re-resolve against the current display geometry (display metrics changed). */
  refresh(): void
  /** The marks to draw, grouped by display id; only displays with at least one visible mark appear. */
  views(): Map<number, MarkView[]>
  count(): number
  onChange(listener: () => void): () => void
}

export function createScreenMarks(deps: ScreenMarksDeps): ScreenMarks {
  let frame: FrameNote | null = null
  let marks: ScreenMark[] = []
  let lastSignature = ''
  const listeners = new Set<() => void>()

  function live(): LiveObservation | null {
    if (!frame) return null
    const displayBounds = deps.displayBounds(frame.displayId)
    if (!displayBounds) return null
    return {
      observationId: frame.observationId,
      generation: frame.generation,
      displayId: frame.displayId,
      displayBounds,
      screenshot: frame.screenshot,
      ...(frame.region ? { region: frame.region } : {})
    }
  }

  function compute(): Map<number, MarkView[]> {
    const current = live()
    const out = new Map<number, MarkView[]>()
    const kept: ScreenMark[] = []
    for (const mark of marks) {
      // A mark of a screenshot that is no longer the live one is deleted for good. A mark of the live screenshot is
      // hidden but kept while its display is unavailable or the mark is off the display, and shown again on return.
      const stale = frame === null || mark.screenshotId !== frame.observationId || mark.generation !== frame.generation
      if (stale) continue
      const resolution = resolveMark(mark, current)
      kept.push(mark)
      if (!resolution.visible) continue
      const list = out.get(mark.displayId) ?? []
      list.push(resolution.view)
      out.set(mark.displayId, list)
    }
    marks = kept
    return out
  }

  function emitIfChanged(force = false): void {
    const signature = JSON.stringify([...compute()])
    if (!force && signature === lastSignature) return
    lastSignature = signature
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // a listener never changes what the store holds
      }
    }
  }

  return {
    noteFrame(next) {
      frame = { ...next }
      emitIfChanged()
    },
    place(input) {
      const shape = ScreenMarkShapeSchema.safeParse(input.shape)
      if (!frame) return { ok: false, reason: 'no-observation' }
      if (input.screenshotId !== frame.observationId) return { ok: false, reason: 'stale-screenshot' }
      if (!shape.success) return { ok: false, reason: 'out-of-image' }
      const current = live()
      const transform = current ? deriveMarkTransform(current) : null
      if (!current || !transform) return { ok: false, reason: 'no-transform' }
      if (!insideImage(shape.data, frame.screenshot)) return { ok: false, reason: 'out-of-image' }
      if (marks.length >= MAX_SCREEN_MARKS) return { ok: false, reason: 'too-many' }
      const markId = deps.newId()
      marks.push({
        markId,
        screenshotId: frame.observationId,
        generation: frame.generation,
        displayId: frame.displayId,
        shape: shape.data,
        transform
      })
      emitIfChanged()
      return { ok: true, markId }
    },
    remove(markId) {
      const before = marks.length
      marks = marks.filter((m) => m.markId !== markId)
      if (marks.length === before) return false
      emitIfChanged()
      return true
    },
    clear() {
      const had = marks.length > 0 || frame !== null
      marks = []
      frame = null
      if (had) emitIfChanged()
    },
    refresh: () => emitIfChanged(),
    views: () => compute(),
    count: () => marks.length,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function insideImage(shape: ScreenMarkShape, size: { width: number; height: number }): boolean {
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x <= size.width && y <= size.height
  if (shape.kind === 'arrow') return inside(shape.from.x, shape.from.y) && inside(shape.to.x, shape.to.y)
  if (shape.kind === 'box') return inside(shape.x, shape.y) && inside(shape.x + shape.width, shape.y + shape.height)
  return inside(shape.x, shape.y)
}
