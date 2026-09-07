/**
 * The map's zoom floor, which is the reason the Realtime map could be zoomed out into a corner.
 *
 * `clampTransform` deliberately never lets the map pan away from its own edges. That rule and a zoom
 * floor below 1 cannot both hold: at k < 1 the content is smaller than the frame, so the lower pan
 * bound (width - width*k) goes positive while the upper bound stays 0, the two cross, and every
 * position collapses to 0,0. The world ends up pinned to the top-left with dead space down and
 * right. These tests pin the arithmetic rather than the symptom, so a future change to either the
 * clamp or the default floor has to face the interaction.
 */
import { describe, expect, it } from 'vitest'
import { clampTransform, IDENTITY_TRANSFORM, zoomToward } from './map-dom'

const W = 1152
const H = 576

describe('clampTransform', () => {
  it('collapses every offset to the corner below 1x, which is why the floor is 1', () => {
    const out = clampTransform({ x: -300, y: -120, k: 0.5 }, W, H, 0.5, 4)
    expect(out.k).toBe(0.5)
    // Not "some sensible offset" -- exactly the corner, for any input, at any k below 1.
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
  })

  it('at exactly 1x the map fills the frame and cannot be panned off it', () => {
    expect(clampTransform({ x: -50, y: -50, k: 1 }, W, H, 1, 4)).toEqual({ x: 0, y: 0, k: 1 })
    expect(clampTransform({ x: 80, y: 30, k: 1 }, W, H, 1, 4)).toEqual({ x: 0, y: 0, k: 1 })
  })

  it('above 1x there is real room to pan, bounded by the map edges', () => {
    const out = clampTransform({ x: -400, y: -200, k: 2 }, W, H, 1, 4)
    expect(out).toEqual({ x: -400, y: -200, k: 2 })
    // Past the edge, it stops at the edge rather than revealing background.
    expect(clampTransform({ x: -9999, y: -9999, k: 2 }, W, H, 1, 4)).toEqual({ x: -W, y: -H, k: 2 })
    expect(clampTransform({ x: 9999, y: 9999, k: 2 }, W, H, 1, 4)).toEqual({ x: 0, y: 0, k: 2 })
  })
})

describe('zoomToward with the shipped 1x..4x range', () => {
  const zoom = (k: number, at = { x: W / 2, y: H / 2 }): ReturnType<typeof zoomToward> =>
    zoomToward(IDENTITY_TRANSFORM, at, k, W, H, 1, 4)

  it('refuses to zoom out past the whole world', () => {
    expect(zoom(0.25).k).toBe(1)
    expect(zoom(0.9).k).toBe(1)
    expect(zoom(1).k).toBe(1)
  })

  it('still zooms in to 4x, and no further', () => {
    expect(zoom(2).k).toBe(2)
    expect(zoom(4).k).toBe(4)
    expect(zoom(50).k).toBe(4)
  })

  it('keeps the pointed-at spot under the cursor while zooming in', () => {
    const point = { x: 300, y: 200 }
    const out = zoomToward(IDENTITY_TRANSFORM, point, 2, W, H, 1, 4)
    // Content coordinate under the cursor before and after must match.
    const before = { x: (point.x - IDENTITY_TRANSFORM.x) / IDENTITY_TRANSFORM.k, y: (point.y - IDENTITY_TRANSFORM.y) / IDENTITY_TRANSFORM.k }
    const after = { x: (point.x - out.x) / out.k, y: (point.y - out.y) / out.k }
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })
})
