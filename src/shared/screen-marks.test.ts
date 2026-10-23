import { describe, expect, it } from 'vitest'
import {
  deriveMarkTransform,
  mapPointToDisplay,
  resolveMark,
  ScreenMarkShapeSchema,
  type LiveObservation,
  type ScreenMark
} from './screen-marks'

const RETINA_DISPLAY = { x: 0, y: 0, width: 1440, height: 900 }

/** A Retina (2x) capture of a 1440x900 point display: the image is 2880x1800 pixels. */
const live = (over: Partial<LiveObservation> = {}): LiveObservation => ({
  observationId: 'obs-7',
  generation: 3,
  displayId: 11,
  displayBounds: RETINA_DISPLAY,
  screenshot: { width: 2880, height: 1800 },
  ...over
})

const markFor = (l: LiveObservation, shape: ScreenMark['shape']): ScreenMark => {
  const transform = deriveMarkTransform(l)
  if (!transform) throw new Error('no transform')
  return {
    markId: 'm1',
    screenshotId: l.observationId,
    generation: l.generation,
    displayId: l.displayId,
    shape,
    transform
  }
}

describe('screen mark transform math (G43, CAP-25)', () => {
  it('maps Retina 2x screenshot pixels to display points', () => {
    const t = deriveMarkTransform(live())
    expect(t).toEqual({ scale: 2, offsetX: 0, offsetY: 0, displayBounds: RETINA_DISPLAY })
    expect(mapPointToDisplay(t!, { x: 2880, y: 1800 })).toEqual({ x: 1440, y: 900 })
    expect(mapPointToDisplay(t!, { x: 1000, y: 500 })).toEqual({ x: 500, y: 250 })
  })

  it('maps a 1x screenshot of a 1x display one to one', () => {
    const t = deriveMarkTransform(
      live({ displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, screenshot: { width: 1920, height: 1080 } })
    )
    expect(t?.scale).toBe(1)
    expect(mapPointToDisplay(t!, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('maps a 2x capture downscaled to 1x width onto the same point positions', () => {
    const t = deriveMarkTransform(live({ screenshot: { width: 1440, height: 900 } }))
    expect(t?.scale).toBe(1)
    expect(mapPointToDisplay(t!, { x: 720, y: 450 })).toEqual({ x: 720, y: 450 })
  })

  it('adds the region origin for a region capture', () => {
    const t = deriveMarkTransform(
      live({ screenshot: { width: 1440, height: 900 }, region: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 } })
    )
    // 0.5 * 1440 = 720 points wide shown in 1440 pixels: scale 2; origin at (720, 225).
    expect(t).toMatchObject({ scale: 2, offsetX: 720, offsetY: 225 })
    expect(mapPointToDisplay(t!, { x: 0, y: 0 })).toEqual({ x: 720, y: 225 })
    expect(mapPointToDisplay(t!, { x: 1440, y: 900 })).toEqual({ x: 1440, y: 675 })
  })

  it('works on a secondary display placed at an offset, including negative origins (window-local output)', () => {
    const secondary = { x: -1920, y: 120, width: 1920, height: 1080 }
    const l = live({ displayId: 22, displayBounds: secondary, screenshot: { width: 1920, height: 1080 } })
    const mark = markFor(l, { kind: 'point', x: 960, y: 540 })
    const r = resolveMark(mark, l)
    expect(r).toMatchObject({ visible: true, view: { kind: 'point', x: 960, y: 540 } })
  })

  it('rejects a degenerate display or screenshot instead of dividing by zero', () => {
    expect(deriveMarkTransform(live({ screenshot: { width: 0, height: 0 } }))).toBeNull()
    expect(deriveMarkTransform(live({ displayBounds: { x: 0, y: 0, width: 0, height: 0 } }))).toBeNull()
  })
})

describe('resolving a mark against the live observation', () => {
  const l = live()
  const box = markFor(l, { kind: 'box', x: 200, y: 100, width: 400, height: 300 })

  it('projects each kind into display points', () => {
    expect(resolveMark(box, l)).toMatchObject({
      visible: true,
      view: { kind: 'box', x: 100, y: 50, width: 200, height: 150 }
    })
    expect(resolveMark(markFor(l, { kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 2880, y: 1800 } }), l)).toMatchObject(
      {
        visible: true,
        view: { kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 1440, y: 900 } }
      }
    )
    expect(resolveMark(markFor(l, { kind: 'label-anchor', x: 400, y: 400, stepNumber: 2 }), l)).toMatchObject({
      visible: true,
      view: { kind: 'label-anchor', x: 200, y: 200, stepNumber: 2 }
    })
  })

  it('hides a mark whose screenshot is no longer the live observation (never re-projected onto another image)', () => {
    expect(resolveMark(box, live({ observationId: 'obs-8' }))).toEqual({ visible: false, reason: 'stale-screenshot' })
  })

  it('hides a mark from an older generation', () => {
    expect(resolveMark(box, live({ generation: 4 }))).toEqual({ visible: false, reason: 'stale-generation' })
  })

  it('hides a mark when the live observation is of another display', () => {
    expect(resolveMark(box, live({ displayId: 12 }))).toEqual({ visible: false, reason: 'other-display' })
  })

  it('hides every mark when there is no live observation', () => {
    expect(resolveMark(box, null)).toEqual({ visible: false, reason: 'no-observation' })
  })

  it('recomputes the transform after a DPI change on the same screenshot (Retina 2x display now 1x points)', () => {
    // The display is now reported at 2880x1800 points (scale factor 1); the same image maps proportionally.
    const after = live({ displayBounds: { x: 0, y: 0, width: 2880, height: 1800 } })
    const r = resolveMark(box, after)
    expect(r).toMatchObject({
      visible: true,
      recomputed: true,
      view: { kind: 'box', x: 200, y: 100, width: 400, height: 300 }
    })
  })

  it('recomputes after a display bounds change and moves the mark with it', () => {
    const after = live({ displayBounds: { x: 0, y: 0, width: 720, height: 450 } })
    expect(resolveMark(box, after)).toMatchObject({
      visible: true,
      recomputed: true,
      view: { x: 50, y: 25, width: 100, height: 75 }
    })
  })

  it('reports recomputed false when nothing changed', () => {
    expect(resolveMark(box, l)).toMatchObject({ visible: true, recomputed: false })
  })

  it('hides a mark that falls outside the display after a recompute', () => {
    const p = markFor(l, { kind: 'point', x: 2800, y: 1700 })
    const smaller = live({ screenshot: { width: 1000, height: 600 } })
    // 1000 px over 1440 points: scale 0.694; 2800 px is far past the display edge.
    expect(resolveMark(p, smaller)).toEqual({ visible: false, reason: 'off-display' })
  })

  it('hides when the live observation has no usable geometry', () => {
    expect(resolveMark(box, live({ screenshot: { width: 0, height: 0 } }))).toEqual({
      visible: false,
      reason: 'no-transform'
    })
  })
})

describe('mark shape schema', () => {
  it('accepts the four kinds and refuses unknown fields, NaN and negatives', () => {
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'point', x: 1, y: 2 }).success).toBe(true)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'box', x: 1, y: 2, width: 3, height: 4 }).success).toBe(true)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }).success).toBe(
      true
    )
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'label-anchor', x: 1, y: 2, stepNumber: 15 }).success).toBe(true)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'label-anchor', x: 1, y: 2, stepNumber: 16 }).success).toBe(false)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'point', x: Number.NaN, y: 2 }).success).toBe(false)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'point', x: -1, y: 2 }).success).toBe(false)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'point', x: 1, y: 2, text: 'screen words' }).success).toBe(false)
    expect(ScreenMarkShapeSchema.safeParse({ kind: 'box', x: 1, y: 2, width: 0, height: 4 }).success).toBe(false)
  })
})
