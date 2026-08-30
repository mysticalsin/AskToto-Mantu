import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  clampAxis,
  clampAxisMargin,
  clampHeight,
  clampWithMargin,
  hasNotchHeuristic,
  isReachable,
  recenterXForWidth,
  refitToDisplay,
  slideWithinMargin,
  topCenterPosition,
  topClamp,
  islandSafeTop,
  ISLAND_NOTCH_STRUT_PX,
  type DisplayMetrics,
  type Rect
} from './geometry'

/**
 * geometry.test.ts — MQA-275. Pins the pure positioning math extracted from src/main/index.ts (the
 * top-center anchor, the peek↔revealed footprint recenter, multi-display centering, and the notch-aware
 * top clamp) so it is verifiable without booting Electron. See docs/plans/metis-vibe-island-rebuild.plan.md
 * §3 Phase 1b.
 */

const RETINA_WORK_AREA: Rect = { x: 0, y: 0, width: 3840, height: 2112 }
const LAPTOP_WORK_AREA: Rect = { x: 0, y: 0, width: 1512, height: 944 } // 14"/16" MBP notch dims
const LAPTOP_RIGHT_WORK_AREA: Rect = { x: 3840, y: 0, width: 1512, height: 944 }

function metrics(overrides: Partial<DisplayMetrics> & { workArea: Rect }): DisplayMetrics {
  return {
    bounds: { x: overrides.workArea.x, y: 0, width: overrides.workArea.width, height: overrides.workArea.height + 37 },
    hasNotch: false,
    notchWidth: 0,
    menuBarHeight: 37,
    source: 'heuristic',
    ...overrides
  }
}

describe('MQA-275 — top-center anchor math', () => {
  it('centers a window horizontally on the work area and floors it at workArea.y + topMargin (non-notch)', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA, hasNotch: false })
    const { x, y } = topCenterPosition(880, 'island', m, 8)
    expect(x).toBe(Math.round((RETINA_WORK_AREA.width - 880) / 2))
    expect(y).toBe(RETINA_WORK_AREA.y + 8)
  })

  it('uses a different topMargin for the initial-placement call site than the auto-hide anchor', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA })
    expect(topCenterPosition(880, 'island', m, 24).y).toBe(24)
    expect(topCenterPosition(880, 'island', m, 8).y).toBe(8)
  })

  it('clamps x into the work area when the width exceeds it (never inverts min/max)', () => {
    const narrow: Rect = { x: 100, y: 0, width: 200, height: 200 }
    const m = metrics({ workArea: narrow })
    const { x } = topCenterPosition(500, 'island', m, 8)
    expect(x).toBe(narrow.x) // pinned to the area's left edge, not pushed negative or off the right
  })
})

describe('MQA-275 — multi-display centering', () => {
  it('centers correctly on the PRIMARY display work area', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA })
    const { x } = topCenterPosition(880, 'island', m, 8)
    expect(x).toBe(Math.round(RETINA_WORK_AREA.x + (RETINA_WORK_AREA.width - 880) / 2))
  })

  it('centers correctly on a SECONDARY display offset to the right, not the primary one', () => {
    const m = metrics({ workArea: LAPTOP_RIGHT_WORK_AREA })
    const { x } = topCenterPosition(880, 'island', m, 8)
    // Must be centered WITHIN the laptop's own span (offset 3840..5352), not at the primary's origin.
    expect(x).toBe(Math.round(LAPTOP_RIGHT_WORK_AREA.x + (LAPTOP_RIGHT_WORK_AREA.width - 880) / 2))
    expect(x).toBeGreaterThan(RETINA_WORK_AREA.width)
  })

  it('a laptop display half the width of a 4K display still centers proportionally, not identically', () => {
    const laptop = topCenterPosition(880, 'island', metrics({ workArea: LAPTOP_WORK_AREA }), 8)
    const retina = topCenterPosition(880, 'island', metrics({ workArea: RETINA_WORK_AREA }), 8)
    expect(laptop.x).not.toBe(retina.x)
    expect(laptop.x).toBe(Math.round((LAPTOP_WORK_AREA.width - 880) / 2))
  })
})

describe('MQA-275 — the notch clamp (topClamp)', () => {
  it('path A — parks just below the notch: y = workArea.y, never bounds.y = 0', () => {
    const m = metrics({
      workArea: { x: 0, y: 39, width: 1512, height: 943 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      notchWidth: 200,
      menuBarHeight: 39,
      source: 'helper'
    })
    expect(islandSafeTop(m)).toBe(39)
    expect(topClamp('island', m, 8)).toBe(m.workArea.y)
    expect(topClamp('island', m, 8)).not.toBe(m.bounds.y)
    expect(topClamp('island', m, 8)).toBe(39)
  })

  it('path C — when workArea.y is 0 on a notch display, apply a strut so the capsule is not clipped', () => {
    const m = metrics({
      workArea: { x: 0, y: 0, width: 1512, height: 982 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      notchWidth: 200,
      menuBarHeight: 0,
      source: 'helper'
    })
    expect(islandSafeTop(m)).toBe(ISLAND_NOTCH_STRUT_PX)
    expect(topClamp('island', m, 8)).toBe(ISLAND_NOTCH_STRUT_PX)
    expect(topClamp('island', m, 8)).not.toBe(0)
  })

  it('path C uses menuBarHeight when it is larger than the default strut', () => {
    const m = metrics({
      workArea: { x: 0, y: 0, width: 1512, height: 982 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      menuBarHeight: 44,
      source: 'helper'
    })
    expect(islandSafeTop(m)).toBe(44)
  })

  it('peek and revealed share the same safe Y so hover expands down', () => {
    const m = metrics({
      workArea: { x: 0, y: 39, width: 1512, height: 943 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      menuBarHeight: 39,
      source: 'helper'
    })
    const peekY = topClamp('island', m, 8)
    const revealedY = topClamp('island', m, 8)
    expect(peekY).toBe(revealedY)
    expect(peekY).toBe(39)
  })

  it('floats below the work-area top on a NON-notch Mac even in island layout', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA, hasNotch: false, source: 'helper' })
    expect(topClamp('island', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
  })

  it('floats below the work-area top in BAR layout even when the display has a notch', () => {
    const m = metrics({
      workArea: LAPTOP_WORK_AREA,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      notchWidth: 200,
      source: 'helper'
    })
    expect(topClamp('bar', m, 8)).toBe(LAPTOP_WORK_AREA.y + 8)
  })

  it('a wrong heuristic guess can only make the island float, never clip under a real menu bar', () => {
    // Heuristic says "notch" (source: 'heuristic') but is actually wrong (e.g. a future OS with a taller
    // traditional menu bar). It still floors no HIGHER than bounds.y (never negative / above the screen).
    const m = metrics({
      workArea: LAPTOP_WORK_AREA,
      bounds: { x: 0, y: -4, width: 1512, height: 982 },
      hasNotch: true,
      source: 'heuristic'
    })
    const y = topClamp('island', m, 8)
    expect(y).toBeGreaterThanOrEqual(m.workArea.y)
    expect(y).toBeGreaterThan(m.bounds.y)
  })

  it('windows (no notch concept) always floors at workArea.y + margin regardless of layout', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA, hasNotch: false, source: 'heuristic' })
    expect(topClamp('island', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
    expect(topClamp('bar', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
  })
})

describe('MQA-275 — hasNotchHeuristic', () => {
  it('flags a notch-Mac-shaped menu bar (>= 32px) on darwin', () => {
    expect(hasNotchHeuristic(37, 'darwin')).toBe(true)
    expect(hasNotchHeuristic(44, 'darwin')).toBe(true)
  })

  it('does not flag a traditional ~24-25px menu bar on darwin', () => {
    expect(hasNotchHeuristic(24, 'darwin')).toBe(false)
    expect(hasNotchHeuristic(25, 'darwin')).toBe(false)
  })

  it('never flags a notch on a non-darwin platform, whatever the menu-bar math says', () => {
    expect(hasNotchHeuristic(40, 'win32')).toBe(false)
    expect(hasNotchHeuristic(40, 'linux')).toBe(false)
  })
})

describe('MQA-275 — peek vs revealed footprint (recenterXForWidth)', () => {
  it('reveal from the peek strip recenters the wider bar on the peek’s own midpoint', () => {
    const peekBounds = { x: 1000, width: 132 } // OverlayPeek's hugged width
    const x = recenterXForWidth(peekBounds.x, peekBounds.width, 880, RETINA_WORK_AREA, 8)
    const oldMid = peekBounds.x + peekBounds.width / 2
    const newMid = x + 880 / 2
    expect(newMid).toBeCloseTo(oldMid, 0)
  })

  it('is a no-op position when the width does not change', () => {
    const x = recenterXForWidth(500, 880, 880, RETINA_WORK_AREA, 8)
    expect(x).toBe(500)
  })

  it('collapsing to the mini-pill also recenters around the old midpoint', () => {
    const barBounds = { x: 1600, width: 880 }
    const x = recenterXForWidth(barBounds.x, barBounds.width, 220, RETINA_WORK_AREA, 8)
    const oldMid = barBounds.x + barBounds.width / 2
    const newMid = x + 220 / 2
    expect(newMid).toBeCloseTo(oldMid, 0)
  })

  it('clamps the recentered x into the work area with the given margin', () => {
    const x = recenterXForWidth(3700, 132, 880, RETINA_WORK_AREA, 8)
    expect(x).toBeLessThanOrEqual(RETINA_WORK_AREA.x + RETINA_WORK_AREA.width - 880 - 8)
  })
})

describe('MQA-275 — clamp primitives (moved verbatim from index.ts)', () => {
  it('clampAxis pins to areaPos instead of inverting when size >= areaSpan', () => {
    expect(clampAxis(50, 500, 0, 200)).toBe(0)
  })

  it('clampAxis is a straightforward min/max clamp otherwise', () => {
    expect(clampAxis(-50, 100, 0, 1000)).toBe(0)
    expect(clampAxis(950, 100, 0, 1000)).toBe(900)
    expect(clampAxis(400, 100, 0, 1000)).toBe(400)
  })

  it('clampWithMargin(..., 0) is exactly clampAxis', () => {
    expect(clampWithMargin(-50, 100, 0, 1000, 0)).toBe(clampAxis(-50, 100, 0, 1000))
  })

  it('clampHeight floors at minHeight and ceilings at areaHeight - 48', () => {
    expect(clampHeight(10, 1000, 44)).toBe(44)
    expect(clampHeight(2000, 1000, 44)).toBe(952)
    expect(clampHeight(500, 1000, 44)).toBe(500)
  })

  it('slideWithinMargin keeps a tall window inside the work area with margin on both edges', () => {
    const y = slideWithinMargin(-100, 400, RETINA_WORK_AREA, 8)
    expect(y).toBe(RETINA_WORK_AREA.y + 8)
    const y2 = slideWithinMargin(RETINA_WORK_AREA.height, 400, RETINA_WORK_AREA, 8)
    expect(y2).toBe(RETINA_WORK_AREA.y + RETINA_WORK_AREA.height - 400 - 8)
  })

  it('isReachable requires only a margin of overlap on at least one display', () => {
    const displays = [RETINA_WORK_AREA, LAPTOP_RIGHT_WORK_AREA]
    // Hanging mostly off both displays but with 40px overlapping the seam.
    expect(isReachable(3820, 0, 200, 200, displays, 40)).toBe(true)
    // Fully off every display.
    expect(isReachable(-5000, -5000, 200, 200, displays, 40)).toBe(false)
  })

  it('clampAxisMargin lets most of the window hang off an edge, keeping only `margin` px inside', () => {
    const x = clampAxisMargin(-190, 200, 0, 1000, 40)
    expect(x).toBe(-160) // only 40px of the 200px-wide window stays inside [0, 1000)
  })

  it('refitToDisplay is a no-op when the matched display id has not changed', () => {
    const next: Rect = { x: 100, y: 100, width: 880, height: 2000 }
    const result = refitToDisplay(next, 1, RETINA_WORK_AREA, 1, 44, 40)
    expect(result).toBe(next)
  })

  it('refitToDisplay re-ceilings the height (and re-clamps y) when dragged onto a shorter display', () => {
    const tall: Rect = { x: 3900, y: 0, width: 880, height: RETINA_WORK_AREA.height - 48 }
    const result = refitToDisplay(tall, 2, LAPTOP_RIGHT_WORK_AREA, 1, 44, 40)
    expect(result.height).toBeLessThanOrEqual(LAPTOP_RIGHT_WORK_AREA.height - 48)
    expect(result.y + result.height).toBeLessThanOrEqual(LAPTOP_RIGHT_WORK_AREA.y + LAPTOP_RIGHT_WORK_AREA.height)
  })
})

describe('island reveal/collapse wiring (index.ts)', () => {
  it('restoreBarWidth grows height at the same topClamp Y; resizeTo pins that Y', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(index).toMatch(/revealedHeight = Math\.max\(b\.height, lastBarHeight, BAR_HEIGHT\)/)
    expect(index).toMatch(/const y = topClamp\('island', getDisplayMetrics\(display\), ISLAND_TOP_MARGIN\)/)
    expect(index).toMatch(/function resizeTo/)
  })
})
