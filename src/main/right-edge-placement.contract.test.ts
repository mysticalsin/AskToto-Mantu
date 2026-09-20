import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const index = readFileSync(join(__dirname, './index.ts'), 'utf8')
const geometry = readFileSync(join(__dirname, './island/geometry.ts'), 'utf8')
const placement = readFileSync(join(__dirname, '../shared/overlay-placement.ts'), 'utf8')

function section(source: string, start: string, end: string): string {
  // Windows CI checks out CRLF; markers in this file use LF. Normalize both sides.
  const norm = (s: string): string => s.replace(/\r\n/g, '\n')
  const src = norm(source)
  const startKey = norm(start)
  const endKey = norm(end)
  const startAt = src.indexOf(startKey)
  const endAt = src.indexOf(endKey, startAt + startKey.length)
  if (startAt < 0 || endAt < 0) throw new Error(`Could not find ${start}..${end}`)
  return src.slice(startAt, endAt)
}

describe('right-edge placement main-process contract', () => {
  it('uses one placement resolver for cursor hover, parked bounds, resize, and display reanchor', () => {
    expect(index).toMatch(/function overlayPositionForDisplay\(/)
    expect(index).toMatch(/function parkedOverlayBounds\(/)
    expect(index).toMatch(/function overlayHoverRestRect\(/)
    const cursorWatch = section(index, 'function tickOverlayCursorWatch()', 'function notifyOverlayCursorHover')
    expect(cursorWatch).toMatch(/overlayHoverRestRect\(layout, display\)/)
    const reanchor = section(index, 'function registerScreenListeners()', 'function toggleVisible')
    expect(reanchor).toMatch(/resolvedOverlayPlacementForDisplay\(display\) === 'right-edge'/)
    expect(reanchor).toMatch(/overlayPositionForDisplay\(/)
  })

  it('keeps sidecar dragging explicitly vertical and persists its normalized local preference', () => {
    const move = section(index, 'function moveBy(', '/**\n * Keep the overlay reachable')
    expect(move).toMatch(/resolvedOverlayPlacementForDisplay\(display\) === 'right-edge'/)
    expect(move).toMatch(/screen\.getDisplayMatching\(b\)/)
    expect(move).toMatch(/normalizeRightEdgeY\(b\.y \+ dy, height, getDisplayMetrics\(display\)\)/)
    expect(move).toMatch(/queueRightEdgeYForDisplay\(display, normalizedY\)/)
    expect(move).not.toMatch(/x: b\.x \+ dx/)
    expect(move).not.toMatch(/display\.id !== fromDisplayId/)
    const persist = section(index, 'function queueRightEdgeYForDisplay', 'function overlayCursorWatchWanted')
    expect(persist).toMatch(/overlayRightEdgeYByDisplay/)
    expect(persist).toMatch(/\}, 350\)/)
    expect(persist).toMatch(/setSettings\(/)
    expect(persist).toMatch(/if \(!key\) return/)
  })

  it('keeps sidecar placement independent of chrome and notch/hardware state', () => {
    expect(placement).toMatch(/OVERLAY_PLACEMENTS = \['top-center', 'right-edge'\]/)
    expect(placement).toMatch(/overlayDisplayKey\(displayId: number\)/)
    const rightEdge = section(geometry, 'export function rightEdgePosition', '/** Inverse of rightEdgePosition')
    expect(rightEdge).not.toMatch(/hasNotch|notchWidth|menuBarHeight/)
    expect(geometry).toMatch(/placement === 'right-edge'/)
    expect(geometry).toMatch(/return topCenterPosition/)
  })

  it('applies a settings change without treating physical placement as overlay chrome', () => {
    const settings = section(index, 'const layoutChanged = cur.overlayLayout', '// Flipping follow-up memory')
    expect(settings).toMatch(/const placementChanged = cur\.overlayPlacement !== next\.overlayPlacement/)
    expect(settings).toMatch(/else if \(placementChanged && !settingsSurfaceOpen\)/)
    expect(settings).toMatch(/overlayPositionForDisplay\(/)
  })

  it('does not resize native sidecar bounds for streaming renderer content', () => {
    const resize = section(index, 'function resizeTo(height: number): void', '/** Collapse to / expand')
    expect(resize).toMatch(/if \(placement === 'right-edge'\) return/)
    const resizeIpc = section(index, "ipcMain.handle(IPC.windowResize", 'ipcMain.handle(IPC.windowMode')
    expect(resizeIpc).toMatch(/resolvedOverlayPlacementForDisplay\(display\) === 'right-edge'/)
    expect(resizeIpc).toMatch(/return/)
    expect(resizeIpc).not.toMatch(/resizeTo\(height\).*right-edge/)
  })
})
