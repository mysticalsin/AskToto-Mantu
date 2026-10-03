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
    expect(cursorWatch).toMatch(/const restoredFromParkedRail = islandResting/)
    expect(cursorWatch).toMatch(/notifyOverlayCursorHover\(true, restoredFromParkedRail\)/)
    const reanchor = section(index, 'function registerScreenListeners()', 'function toggleVisible')
    expect(reanchor).toMatch(/resolvedOverlayPlacementForDisplay\(display\) === 'right-edge'/)
    // M2-0202: the right-edge reanchor places through the geometry authority's one writer.
    expect(reanchor).toMatch(/applyRightEdgeBounds\('open', display\)/)
    expect(reanchor).toMatch(/applyRightEdgeBounds\('rest', display, layout\)/)
  })

  it('keeps sidecar dragging explicitly vertical and persists its per-display anchor', () => {
    const move = section(index, 'function moveBy(', '/**\n * Keep the overlay reachable')
    expect(move).toMatch(/resolvedOverlayPlacementForDisplay\(display\) === 'right-edge'/)
    expect(move).toMatch(/screen\.getDisplayMatching\(b\)/)
    // M2-0202: a drag changes only the anchor A (dy), and every rect follows it from the authority.
    expect(move).toMatch(/rightEdgeAnchors\.drag\(display, rightEdgeAnchors\.y\(display\) \+ dy\)/)
    expect(move).toMatch(/applyRightEdgeBounds\(islandResting \? 'rest' : 'open', display\)/)
    expect(move).not.toMatch(/x: b\.x \+ dx/)
    expect(move).not.toMatch(/display\.id !== fromDisplayId/)
    // The debounce, lock and display-key rules run in island/right-edge-anchor.test.ts; this pins main's wiring
    // of the anchor store to the settings keys and the lock list.
    const persist = section(index, 'const rightEdgeAnchors = createRightEdgeAnchors({', 'function overlayCursorWatchWanted')
    expect(persist).toMatch(/legacy: getSettings\(\)\.overlayRightEdgeYByDisplay/)
    expect(persist).toMatch(/setSettings\(\{ overlayRightEdgeAnchorByDisplay: \{ \.\.\.getSettings\(\)\.overlayRightEdgeAnchorByDisplay, \.\.\.anchors \} \}\)/)
    expect(persist).toMatch(/lockedKeys: getLockedKeys/)
    expect(persist).toMatch(/rightEdgeLive: \(\) => liveOverlayPlacement\(\) === 'right-edge'/)
  })

  it('RE-G10: every right-edge placement path goes through applyRightEdgeBounds, including a placement change', () => {
    // Behavior is proven by the lifted paths in overlay-placement.contract.test.ts; the settings handler is
    // too large to lift, so its revealed right-edge branch is pinned here.
    const settings = section(index, 'const layoutChanged = cur.overlayLayout', '// Flipping follow-up memory')
    expect(settings).toMatch(/=== 'right-edge'\) \{\s*applyRightEdgeBounds\('open', display\)/)
    const writer = section(index, 'function applyRightEdgeBounds(', 'function overlayCursorWatchWanted')
    expect(writer).toMatch(/const rect = rightEdgeBounds\(surface, display, layout\)/)
    // No right-edge rect is computed from the legacy normalized-Y helpers any more.
    expect(index).not.toMatch(/normalizeRightEdgeY|rightEdgeSidecarBounds|rightEdgeYForDisplay/)
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

  it('wires right-edge Hide: toggle parks and latches, reveals tell the page, parks tell the page, layout changes re-apply chrome', () => {
    // Behavior is proven live by the RE-HIDE rows in scripts/qa/packaged-smoke.mjs; these pin the wiring.
    const toggle = section(index, 'function toggleVisible(', 'const shortcutActions')
    expect(toggle).toMatch(/=== 'right-edge'\n[^\n]*rightEdge && parkOverlayAfterHideSpring\(true\)\) return startOverlayCursorWatch\(\)/)
    expect(toggle.indexOf('parkOverlayAfterHideSpring(true)')).toBeLessThan(toggle.indexOf('w.hide()'))
    const park = section(index, 'function parkOverlayAfterHideSpring', 'function applyHideClickThrough')
    expect(park).toMatch(/overlayParkLatched = force/)
    expect(park).toMatch(/=== 'right-edge'\) notifyOverlayCursorHover\(false, false, true\)/)
    const tick = section(index, 'function tickOverlayCursorWatch()', 'function notifyOverlayCursorHover')
    expect(tick).toMatch(/if \(overlayParkLatched && islandResting && pointInRect\(cursor, rest\)\)/)
    expect(tick).toMatch(/placement\n\s*\}\)/)
    const restore = section(index, 'function restoreBarWidth()', 'function repairOverlayBoundsForReveal')
    expect(restore).toMatch(/overlayParkLatched = false/)
    const controller = section(index, 'const revealLifecycle = createRevealLifecycle({', 'const reveal = revealLifecycle.reveal')
    expect(controller).toMatch(/restoreBarWidth\(\)\s*revealRightEdgeDockInPage\(\)/)
    const pageReveal = section(index, 'function revealRightEdgeDockInPage()', 'const revealLifecycle')
    expect(pageReveal).toMatch(/!== 'right-edge'\) return/)
    expect(pageReveal).toMatch(/rightEdgeUnhoveredRevealAt = performance\.now\(\)/)
    expect(pageReveal).toMatch(/notifyOverlayCursorHover\(true, true\)/)
    const settings = section(index, 'const layoutChanged = cur.overlayLayout', '// Flipping follow-up memory')
    const layoutSwitch = settings.slice(settings.indexOf('if (layoutChanged) {'), settings.indexOf('} else if (placementChanged'))
    expect(layoutSwitch).toMatch(/applyOverlaySurfaceChrome\(\)\s*applyHideClickThrough\(\)/)
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
