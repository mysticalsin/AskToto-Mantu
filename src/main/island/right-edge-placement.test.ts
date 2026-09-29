import { describe, expect, it } from 'vitest'
import { pointInRect } from './cursor-watch'
import {
  RIGHT_EDGE_MARGIN_PX,
  hideParkWindowOpacity,
  normalizeRightEdgeY,
  overlayPlacementPosition,
  parkAfterExclusiveOnboarding,
  resolveOverlayPlacement,
  rightEdgePlacementFits,
  rightEdgeHoverRestRect,
  rightEdgeParkLayout,
  rightEdgeSidecarBounds,
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
  it('keeps the tab and opened drawer on one shared right boundary', () => {
    const tab = rightEdgeSidecarBounds(METRICS, { open: false, normalizedY: 0.5 })
    const drawer = rightEdgeSidecarBounds(METRICS, { open: true, normalizedY: 0.5 })
    expect(tab.x + tab.width).toBe(drawer.x + drawer.width)
    expect(tab.width).toBeGreaterThanOrEqual(48)
    expect(drawer.width).toBeGreaterThanOrEqual(336)
  })

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

  it('reveals from a band flush with the physical right edge that spans the drawer height, never an inset square', () => {
    // Owner report on 1.9.6: the hover target was the 52x52 tab, 12 px inside the work area, so pushing the
    // pointer to the screen edge never revealed the dock.
    const drawer = rightEdgeSidecarBounds(METRICS, { open: true, normalizedY: 0.5 })
    const rect = hoverWatchRestRect('hide', METRICS, 'right-edge', 0.5)
    expect(rightEdgeHoverRestRect(0.5, METRICS)).toEqual(rect)
    expect(rect.x + rect.width).toBe(METRICS.bounds.x + METRICS.bounds.width)
    expect(rect.width).toBeLessThan(RIGHT_EDGE_MARGIN_PX)
    expect(rect.y).toBe(drawer.y)
    expect(rect.height).toBe(drawer.height)
    // The pointer stopped by the screen edge, level with the middle of the drawer.
    expect(pointInRect({ x: METRICS.bounds.x + METRICS.bounds.width - 1, y: drawer.y + drawer.height / 2 }, rect)).toBe(true)
    // The old tab position, 40 px inside the work area, is no longer a reveal target.
    const tab = rightEdgeSidecarBounds(METRICS, { open: false, normalizedY: 0.5 })
    expect(pointInRect({ x: WORK_AREA.x + WORK_AREA.width - 40, y: tab.y + 20 }, rect)).toBe(false)
    expect(hoverWatchRestRect('island', METRICS, 'right-edge', 0.5)).toEqual(rect)
  })

  it('reveals from the work-area edge when the Dock or taskbar sits on the right', () => {
    const dockRight: DisplayMetrics = { ...METRICS, workArea: { ...WORK_AREA, width: WORK_AREA.width - 70 } }
    const rect = hoverWatchRestRect('hide', dockRight, 'right-edge', 0.5)
    const drawer = rightEdgeSidecarBounds(dockRight, { open: true, normalizedY: 0.5 })
    expect(rect.x + rect.width).toBe(dockRight.workArea.x + dockRight.workArea.width)
    expect(rect.height).toBe(drawer.height)
    expect(pointInRect({ x: dockRight.workArea.x + dockRight.workArea.width - 1, y: drawer.y + 1 }, rect)).toBe(true)
  })

  it('parks Hide as the invisible reveal band and Island as its visible rail', () => {
    expect(parkAfterExclusiveOnboarding('hide', METRICS, 8, 'right-edge', 0.5)).toEqual(rightEdgeHoverRestRect(0.5, METRICS))
    expect(parkAfterExclusiveOnboarding('island', METRICS, 8, 'right-edge', 0.5)).toEqual(
      rightEdgeSidecarBounds(METRICS, { open: false, normalizedY: 0.5 })
    )
    expect(hideParkWindowOpacity('hide', true)).toBe(0)
    expect(hideParkWindowOpacity('island', true)).toBe(1)
  })

  it('parks Hide as the visible rail where another display continues past the right edge', () => {
    const neighbour: Rect = { x: METRICS.bounds.x + METRICS.bounds.width, y: 0, width: 1920, height: 1080 }
    expect(rightEdgeParkLayout('hide', METRICS, [neighbour], 0.5)).toBe('island')
    expect(rightEdgeParkLayout('island', METRICS, [neighbour], 0.5)).toBe('island')
    // A display on the left, or one to the right that does not reach the drawer's height, leaves the edge free.
    const left: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
    const below: Rect = { ...neighbour, y: METRICS.bounds.y + METRICS.bounds.height }
    expect(rightEdgeParkLayout('hide', METRICS, [left, below], 0.5)).toBe('hide')
    expect(rightEdgeParkLayout('hide', METRICS, [], 0.5)).toBe('hide')
  })

  it('falls back to the established top-center geometry when a full sidecar cannot fit', () => {
    const narrow: DisplayMetrics = { ...METRICS, bounds: { x: 0, y: 0, width: 360, height: 900 }, workArea: { x: 0, y: 0, width: 360, height: 864 } }
    expect(rightEdgePlacementFits(narrow)).toBe(false)
    expect(resolveOverlayPlacement('right-edge', narrow)).toBe('top-center')
    expect(overlayPlacementPosition({ placement: 'right-edge', width: 880, height: 140, layout: 'bar', metrics: narrow, topMargin: 8 })).toEqual({ x: 0, y: 8 })
    expect(hoverWatchRestRect('hide', narrow, 'right-edge')).toEqual(hoverWatchRestRect('hide', narrow, 'top-center'))
    expect(parkAfterExclusiveOnboarding('hide', narrow, 8, 'right-edge')).toEqual(parkAfterExclusiveOnboarding('hide', narrow, 8, 'top-center'))
  })
})
