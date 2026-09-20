import { describe, expect, it } from 'vitest'
import {
  normalizeRightEdgeY,
  overlayPlacementPosition,
  parkAfterExclusiveOnboarding,
  resolveOverlayPlacement,
  rightEdgePlacementFits,
  rightEdgeHoverRestRect,
  rightEdgePosition,
  hoverWatchRestRect,
  type DisplayMetrics,
  type Rect
} from './geometry'

const WORK_AREA: Rect = { x: 1920, y: 36, width: 1440, height: 900 }
const METRICS: DisplayMetrics = {
  bounds: { x: 1920, y: 0, width: 1440, height: 936 },
  workArea: WORK_AREA,
  hasNotch: true,
  notchWidth: 220,
  menuBarHeight: 36,
  source: 'helper'
}

describe('right-edge overlay placement', () => {
  it('anchors the bar to the work-area right edge without using notch geometry', () => {
    const pos = rightEdgePosition(880, 140, METRICS, 0.25)
    expect(pos.x).toBe(WORK_AREA.x + WORK_AREA.width - 880 - 12)
    expect(pos.y).toBeGreaterThanOrEqual(WORK_AREA.y + 12)
    expect(pos.y + 140).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height - 12)
  })

  it('round-trips an explicit vertical drag as a normalized per-display position', () => {
    const placed = rightEdgePosition(880, 140, METRICS, 0.73)
    expect(normalizeRightEdgeY(placed.y, 140, METRICS)).toBeCloseTo(0.73, 2)
  })

  it('clamps a moved edge overlay into the new display instead of retaining raw pixels', () => {
    expect(normalizeRightEdgeY(-1000, 140, METRICS)).toBe(0)
    expect(normalizeRightEdgeY(10000, 140, METRICS)).toBe(1)
  })

  it('preserves existing top-center geometry when that remains selected', () => {
    expect(overlayPlacementPosition({ placement: 'top-center', width: 880, height: 140, layout: 'bar', metrics: METRICS, topMargin: 8 })).toEqual({ x: 2200, y: 44 })
  })

  it('uses a narrow local right-edge hover target so existing dwell/hysteresis can be reused', () => {
    const rect = rightEdgeHoverRestRect(0.5, METRICS)
    expect(rect.x + rect.width).toBe(WORK_AREA.x + WORK_AREA.width)
    expect(rect.width).toBeLessThanOrEqual(24)
    expect(rect.height).toBeLessThanOrEqual(40)
    expect(rect.y).toBeGreaterThanOrEqual(WORK_AREA.y)
  })

  it('falls back to the established top-center geometry when a full sidecar cannot fit', () => {
    const narrow: DisplayMetrics = { ...METRICS, bounds: { x: 0, y: 0, width: 800, height: 900 }, workArea: { x: 0, y: 0, width: 800, height: 864 } }
    expect(rightEdgePlacementFits(narrow)).toBe(false)
    expect(resolveOverlayPlacement('right-edge', narrow)).toBe('top-center')
    expect(overlayPlacementPosition({ placement: 'right-edge', width: 880, height: 140, layout: 'bar', metrics: narrow, topMargin: 8 })).toEqual({ x: 0, y: 8 })
    expect(hoverWatchRestRect('hide', narrow, 'right-edge')).toEqual(hoverWatchRestRect('hide', narrow, 'top-center'))
    expect(parkAfterExclusiveOnboarding('hide', narrow, 8, 'right-edge')).toEqual(parkAfterExclusiveOnboarding('hide', narrow, 8, 'top-center'))
  })
})
