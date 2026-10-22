import { describe, expect, it } from 'vitest'
import { cropNormalizedRegion, type CroppableImage } from './crop'

type Rect = { x: number; y: number; width: number; height: number }

function fakeImage(width: number, height: number, crops: Rect[] = []): CroppableImage {
  return {
    getSize: () => ({ width, height }),
    crop: (rect: Rect) => {
      crops.push(rect)
      return fakeImage(rect.width, rect.height, crops)
    }
  }
}

describe('cropNormalizedRegion (G16)', () => {
  it('maps a fraction of the display to whole pixels of the frame', () => {
    const crops: Rect[] = []
    const out = cropNormalizedRegion(fakeImage(2000, 1000, crops), { x: 0.25, y: 0.5, width: 0.5, height: 0.25 })
    expect(crops).toEqual([{ x: 500, y: 500, width: 1000, height: 250 }])
    expect(out.getSize()).toEqual({ width: 1000, height: 250 })
  })

  it('never returns an empty or out-of-bounds rectangle, even for a sliver at the far edge', () => {
    const crops: Rect[] = []
    cropNormalizedRegion(fakeImage(100, 100, crops), { x: 0.999, y: 0.999, width: 0.01, height: 0.01 })
    const [rect] = crops
    expect(rect.width).toBeGreaterThanOrEqual(1)
    expect(rect.height).toBeGreaterThanOrEqual(1)
    expect(rect.x + rect.width).toBeLessThanOrEqual(100)
    expect(rect.y + rect.height).toBeLessThanOrEqual(100)
  })

  it('is deterministic on a size that does not divide evenly', () => {
    const a: Rect[] = []
    const b: Rect[] = []
    cropNormalizedRegion(fakeImage(1919, 1079, a), { x: 0.1, y: 0.1, width: 0.3, height: 0.3 })
    cropNormalizedRegion(fakeImage(1919, 1079, b), { x: 0.1, y: 0.1, width: 0.3, height: 0.3 })
    expect(a).toEqual(b)
  })
})
