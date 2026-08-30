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
  hoverRestTop,
  hoverRestHeight,
  hoverWatchRestRect,
  exclusiveOnboardingBounds,
  onboardingFitsWorkArea,
  parkAfterExclusiveOnboarding,
  overlayRestSize,
  isForbiddenMidFlowCard,
  shouldIgnoreResizeWhilePeekResting,
  OVERLAY_HIDE_TARGET,
  OVERLAY_ISLAND_PEEK,
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
  it('centers a window horizontally on the work area and floors bar at workArea.y + topMargin (non-notch)', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA, hasNotch: false })
    const { x, y } = topCenterPosition(880, 'bar', m, 8)
    expect(x).toBe(Math.round((RETINA_WORK_AREA.width - 880) / 2))
    expect(y).toBe(RETINA_WORK_AREA.y + 8)
  })

  it('hide/island rest parks at bounds.y; revealed topClamp is islandSafeTop; bar uses the margin', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA })
    expect(hoverRestTop(m)).toBe(m.bounds.y)
    expect(topCenterPosition(880, 'island', m, 24).y).toBe(islandSafeTop(m))
    expect(topCenterPosition(880, 'hide', m, 8).y).toBe(islandSafeTop(m))
    expect(topCenterPosition(880, 'bar', m, 24).y).toBe(24)
    expect(topCenterPosition(880, 'bar', m, 8).y).toBe(8)
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
  it('path A — islandSafeTop is workArea.y; hide/island rest at bounds.y so the island can hit', () => {
    const m = metrics({
      workArea: { x: 0, y: 39, width: 1512, height: 943 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      notchWidth: 200,
      menuBarHeight: 39,
      source: 'helper'
    })
    expect(islandSafeTop(m)).toBe(39)
    expect(islandSafeTop(m)).toBe(m.workArea.y)
    expect(hoverRestTop(m)).toBe(m.bounds.y)
    expect(topClamp('island', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('hide', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('hide', m, 8)).toBe(39)
    expect(hoverRestHeight(m)).toBeGreaterThanOrEqual(m.menuBarHeight)
    expect(parkAfterExclusiveOnboarding('hide', m, 8).y).toBe(0)
  })

  it('path C — strut is the strip HEIGHT when workArea.y is 0; hide/island still rest at y=0', () => {
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
    expect(topClamp('hide', m, 8)).toBe(ISLAND_NOTCH_STRUT_PX)
    expect(parkAfterExclusiveOnboarding('hide', m, 8).y).toBe(0)
    expect(hoverRestHeight(m)).toBeGreaterThanOrEqual(ISLAND_NOTCH_STRUT_PX)
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
    expect(hoverRestHeight(m)).toBeGreaterThanOrEqual(44)
    expect(topClamp('hide', m, 8)).toBe(44)
    expect(parkAfterExclusiveOnboarding('hide', m, 8).y).toBe(0)
  })

  it('rest stays at bounds.y; revealed chrome sits at islandSafeTop (below the notch)', () => {
    const m = metrics({
      workArea: { x: 0, y: 39, width: 1512, height: 943 },
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      hasNotch: true,
      menuBarHeight: 39,
      source: 'helper'
    })
    const restY = parkAfterExclusiveOnboarding('hide', m, 8).y
    const revealedY = topClamp('hide', m, 8)
    expect(restY).toBe(0)
    expect(revealedY).toBe(39)
    expect(revealedY).toBe(islandSafeTop(m))
    expect(isForbiddenMidFlowCard({ width: 880, height: revealedY + 84 })).toBe(false)
  })

  it('hide/island rest at the display top on a NON-notch display; revealed uses islandSafeTop', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA, hasNotch: false, source: 'helper' })
    expect(hoverRestTop(m)).toBe(m.bounds.y)
    expect(topClamp('island', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('hide', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('bar', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
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
    expect(topClamp('hide', m, 8)).toBe(islandSafeTop(m))
    expect(parkAfterExclusiveOnboarding('hide', m, 8).y).toBe(hoverRestTop(m))
  })

  it('hide/island park at bounds.y even when the heuristic notch guess is wrong', () => {
    const m = metrics({
      workArea: LAPTOP_WORK_AREA,
      bounds: { x: 0, y: -4, width: 1512, height: 982 },
      hasNotch: true,
      source: 'heuristic'
    })
    expect(hoverRestTop(m)).toBe(m.bounds.y)
    expect(topClamp('island', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('bar', m, 8)).toBe(m.workArea.y + 8)
    expect(parkAfterExclusiveOnboarding('island', m, 8).y).toBe(m.bounds.y)
  })

  it('windows hide/island rest at the display top; bar keeps workArea + margin; no fake notch', () => {
    const m = metrics({ workArea: RETINA_WORK_AREA, hasNotch: false, source: 'heuristic' })
    expect(hoverRestTop(m)).toBe(m.bounds.y)
    expect(topClamp('hide', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('island', m, 8)).toBe(islandSafeTop(m))
    expect(topClamp('bar', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
    expect(parkAfterExclusiveOnboarding('hide', m, 8).y).toBe(m.bounds.y)
    expect(topClamp('hide', m, 8)).not.toBe(ISLAND_NOTCH_STRUT_PX)
  })

  it('Windows top taskbar: hide rest at bounds.y covering the inset; no fake notch strut', () => {
    const m = metrics({
      workArea: { x: 0, y: 40, width: 1920, height: 1040 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      hasNotch: false,
      menuBarHeight: 0,
      source: 'heuristic'
    })
    expect(hasNotchHeuristic(40, 'win32')).toBe(false)
    expect(islandSafeTop(m)).toBe(40)
    expect(hoverRestTop(m)).toBe(0)
    expect(topClamp('hide', m, 8)).toBe(40)
    expect(topClamp('bar', m, 8)).toBe(40 + 8)
    expect(hoverRestHeight(m)).toBeGreaterThanOrEqual(40)
    expect(parkAfterExclusiveOnboarding('hide', m, 8).y).toBe(0)
    expect(topClamp('hide', m, 8)).not.toBe(ISLAND_NOTCH_STRUT_PX)
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

describe('after exclusive exit — park peek/hide, never 880×816', () => {
  const tonyMac: DisplayMetrics = {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 39, width: 1512, height: 943 },
    hasNotch: true,
    notchWidth: 200,
    menuBarHeight: 39,
    source: 'helper'
  }

  it('hide parks at bounds.y covering the notch strip, never the 880×816 card or a 120px pill', () => {
    const park = parkAfterExclusiveOnboarding('hide', tonyMac, 8)
    expect(park.y).toBe(tonyMac.bounds.y)
    expect(park.y).toBe(0)
    expect(park.height).toBeGreaterThanOrEqual(tonyMac.menuBarHeight)
    expect(park.width).toBeGreaterThanOrEqual(220)
    expect(park.width).toBeLessThan(880)
    expect(park.width).toBe(OVERLAY_HIDE_TARGET.width)
    expect(park.height).toBeLessThan(880)
    expect(isForbiddenMidFlowCard(park)).toBe(false)
    expect(isForbiddenMidFlowCard({ width: 880, height: 816 })).toBe(true)
    expect(park.x).toBe(Math.round((1512 - park.width) / 2))
    const watch = hoverWatchRestRect('hide', tonyMac)
    expect(watch).toEqual(park)
  })

  it('island parks the peek capsule at the same Y; bar keeps the classic rest below the notch', () => {
    const island = parkAfterExclusiveOnboarding('island', tonyMac, 8)
    expect(island.y).toBe(0)
    expect(island.width).toBe(OVERLAY_ISLAND_PEEK.width + 10)
    expect(island.height).toBe(OVERLAY_ISLAND_PEEK.height + 4)
    expect(isForbiddenMidFlowCard(island)).toBe(false)
    const bar = parkAfterExclusiveOnboarding('bar', tonyMac, 8)
    expect(bar.width).toBe(880)
    expect(bar.height).toBe(84)
    expect(bar.y).toBe(tonyMac.workArea.y + 8)
    expect(isForbiddenMidFlowCard(bar)).toBe(false)
  })

  it('path C: workArea.y 0 on a notch Mac still parks hide at y=0 with a strut-tall strip', () => {
    const flush: DisplayMetrics = {
      ...tonyMac,
      workArea: { x: 0, y: 0, width: 1512, height: 982 },
      menuBarHeight: 0
    }
    const park = parkAfterExclusiveOnboarding('hide', flush, 8)
    expect(park.y).toBe(0)
    expect(park.height).toBeGreaterThanOrEqual(ISLAND_NOTCH_STRUT_PX)
  })

  it('stale 816px measures are ignored while hide/island is resting', () => {
    const peek = overlayRestSize('hide').height
    expect(shouldIgnoreResizeWhilePeekResting(true, 816, peek)).toBe(true)
    expect(shouldIgnoreResizeWhilePeekResting(true, peek, peek)).toBe(false)
    expect(shouldIgnoreResizeWhilePeekResting(false, 816, peek)).toBe(false)
  })

  it('peek constants match the CSS hide-target and island capsule', () => {
    const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')
    const hide = css.slice(css.indexOf('.overlay-hide-target {'), css.indexOf('.overlay-peek {'))
    const peek = css.slice(css.indexOf('.overlay-peek {'), css.indexOf('.overlay-peek:hover'))
    expect(hide).toMatch(/width:\s*100%/)
    expect(hide).toMatch(/min-width:\s*220px/)
    expect(hide).toMatch(/max-width:\s*560px/)
    expect(hide).toMatch(/height:\s*100%/)
    expect(hide).toMatch(/min-height:\s*28px/)
    expect(hide).toMatch(/pointer-events:\s*auto/)
    expect(hide).toMatch(/rgba\(\s*8,\s*4,\s*16,\s*0\.04\s*\)/)
    expect(hide).not.toMatch(/opacity:\s*0\.01/)
    expect(hide).not.toMatch(/background:\s*transparent/)
    expect(peek).toMatch(new RegExp(`width:\\s*${OVERLAY_ISLAND_PEEK.width}px`))
    expect(peek).toMatch(new RegExp(`height:\\s*${OVERLAY_ISLAND_PEEK.height}px`))
  })
})

describe('DESIGN.md overlay contract', () => {
  const design = readFileSync(join(__dirname, '../../../DESIGN.md'), 'utf8')

  it('lives at the repo root and names path A then path C; hide/island rest at bounds.y', () => {
    expect(design).toMatch(/workArea\.y/)
    expect(design).toMatch(/Path A/)
    expect(design).toMatch(/Path C/)
    expect(design).toMatch(/strut/i)
    expect(design).toMatch(/display\.bounds\.y/)
    expect(design).toMatch(/cursor watch/i)
    expect(design).toMatch(/getCursorScreenPoint/)
    expect(design).toMatch(/islandSafeTop/)
    expect(design).toMatch(/stay tick/i)
  })

  it('names hover-down, exclusive fullscreen, large CTA, and Métis demo', () => {
    expect(design).toMatch(/expands \*\*down\*\*/)
    expect(design).toMatch(/exclusive fullscreen/)
    expect(design).toMatch(/exclusiveOnboardingBounds/)
    expect(design).toMatch(/52×220|min 52/)
    expect(design).toMatch(/Métis/)
    expect(design).toMatch(/meeting \/ transcript \/ copilot \/ Intelligence/)
    expect(design).toMatch(/Mantu purple/)
    expect(design).toMatch(/#3A0B6B/)
    expect(design).toMatch(/#7F00DA/)
    expect(design).toMatch(/No auto-advance/)
    expect(design).toMatch(/never a solid black void/)
    expect(design).toMatch(/download\/install progress/)
    expect(design).toMatch(/MODE_RECAP_LAYOUTS/)
    expect(design).toMatch(/hardware-decoded/)
    expect(design).toMatch(/Goldberg Variations/)
    expect(design).toMatch(/CC0 1\.0/)
    expect(design).toMatch(/Mute control/)
    expect(design).toMatch(/rotating stripe|stripe layers/)
    expect(design).toMatch(/0\.30/)
    expect(design).toMatch(/em dash/)
    expect(design).toMatch(/Tell the room/)
    expect(design).toMatch(/primary window/)
    expect(design).toMatch(/Act 4 light/)
    expect(design).toMatch(/GDPR/)
    expect(design).toMatch(/Portal/)
    expect(design).toMatch(/Skip the tour/)
    expect(design).toMatch(/full-viewport muted looping video/)
    expect(design).toMatch(/liquid glass/)
    expect(design).toMatch(/Do not add or restyle overlay \/ onboarding UI unless it matches this document/)
    expect(design).toMatch(/\*\*hide\*\* \(default\)/)
    expect(design).toMatch(/no fake notch/)
  })
})

describe('island reveal/collapse wiring (index.ts)', () => {
  it('restoreBarWidth grows height at the same topClamp Y; resizeTo pins that Y', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(index).toMatch(/revealedHeight = Math\.max\(b\.height, lastBarHeight, BAR_HEIGHT\)/)
    expect(index).toMatch(/const y = topClamp\(liveOverlayLayout\(\), getDisplayMetrics\(display\), ISLAND_TOP_MARGIN\)/)
    expect(index).toMatch(/function resizeTo/)
    expect(index).toMatch(/never setBounds on a stay tick/)
    expect(index).toMatch(/islandResting \? hoverRestTop/)
  })

  it('main wires cursor-watch when layout is hide/island and onboardingDone', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(index).toMatch(/function startOverlayCursorWatch/)
    expect(index).toMatch(/function stopOverlayCursorWatch/)
    expect(index).toMatch(/function tickOverlayCursorWatch/)
    expect(index).toMatch(/shouldWatchOverlayCursor/)
    expect(index).toMatch(/getCursorScreenPoint/)
    expect(index).toMatch(/overlayCursorHover/)
    expect(index).toMatch(/CURSOR_WATCH_INTERVAL_MS/)
    expect(index).toMatch(/startOverlayCursorWatch\(\)/)
    expect(index).toMatch(/stopOverlayCursorWatch\(\)/)
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/startOverlayCursorWatch/)
    const exit = index.slice(index.indexOf('function exitExclusiveOnboardingStage'), index.indexOf('function createWindow'))
    expect(exit).toMatch(/startOverlayCursorWatch/)
    const apply = index.slice(index.indexOf('function applyExclusiveOnboardingStage'), index.indexOf('function exitExclusiveOnboardingStage'))
    expect(apply).toMatch(/stopOverlayCursorWatch/)
  })
})

describe('exclusive onboarding stage (never a mid-flow card)', () => {
  // Tony live fail (Totos-Mac, 64c3967): Electron Métis Y=39 Width=880 Height=816 X=460.
  const tonyCard: Rect = { x: 460, y: 39, width: 880, height: 816 }
  const macbookBounds: Rect = { x: 0, y: 0, width: 1512, height: 982 }
  const macbookWorkArea: Rect = { x: 0, y: 39, width: 1512, height: 943 }

  it('exclusiveOnboardingBounds covers the display and is never smaller than the work area', () => {
    const stage = exclusiveOnboardingBounds(macbookBounds, macbookWorkArea)
    expect(stage.x).toBe(macbookBounds.x)
    expect(stage.y).toBe(macbookBounds.y)
    expect(stage.width).toBeGreaterThanOrEqual(macbookWorkArea.width)
    expect(stage.height).toBeGreaterThanOrEqual(macbookWorkArea.height)
    expect(onboardingFitsWorkArea(stage, macbookWorkArea)).toBe(true)
  })

  it('the 880×816 overlapping card fails the wiped-profile acceptance', () => {
    expect(onboardingFitsWorkArea(tonyCard, macbookWorkArea)).toBe(false)
  })

  it('a work-area-sized window passes; a smaller mid-flow window does not', () => {
    expect(onboardingFitsWorkArea(macbookWorkArea, macbookWorkArea)).toBe(true)
    expect(onboardingFitsWorkArea({ x: 0, y: 0, width: 1511, height: 943 }, macbookWorkArea)).toBe(false)
  })

  it('index.ts applies the stage until onboardingDone, then exits to the island (never Math.min(680))', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(index).toMatch(/function applyExclusiveOnboardingStage/)
    expect(index).toMatch(/function exitExclusiveOnboardingStage/)
    expect(index).toMatch(/exclusiveOnboardingBounds/)
    expect(index).toMatch(/setSimpleFullScreen\(true\)/)
    expect(index).toMatch(/!cur\.onboardingDone && next\.onboardingDone/)
    expect(index).toMatch(/exitExclusiveOnboardingStage\(\)/)
    const experience = readFileSync(join(__dirname, '../../renderer/src/components/OnboardingExperience.tsx'), 'utf8')
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('closeOnboardingPortal')).toBeGreaterThan(-1)
    expect(finish.indexOf('closeOnboardingPortal')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
    expect(index).toMatch(/if \(onboardingExclusiveLive\(\)\) \{\s*applyExclusiveOnboardingStage\(win\)/)
    expect(index).not.toMatch(/Math\.min\(680/)
    const exit = index.slice(index.indexOf('function exitExclusiveOnboardingStage'), index.indexOf('function createWindow'))
    expect(exit).toMatch(/parkAfterExclusiveOnboarding/)
    expect(exit).toMatch(/applyOverlayAlwaysOnTop/)
    expect(exit).toMatch(/setAlwaysOnTop\(true, 'screen-saver'\)/)
    expect(exit).not.toMatch(/width: BAR_WIDTH, height: BAR_HEIGHT/)
    expect(exit).not.toMatch(/currentWidth = BAR_WIDTH/)
    expect(index).toMatch(/shouldIgnoreResizeWhilePeekResting/)
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/parkAfterExclusiveOnboarding/)
    expect(create).toMatch(/onboardingLive \? stage.width : restPark.width/)
    expect(create).toMatch(/islandResting = overlayUsesHover\(layout\)/)
    expect(create).not.toMatch(/width: onboardingLive \? stage.width : BAR_WIDTH/)
  })

  it('App fills the stage — OnboardingV2 is not wrapped in the overlapping Panel card', () => {
    const app = readFileSync(join(__dirname, '../../renderer/src/App.tsx'), 'utf8')
    const gate = app.slice(app.indexOf("settings && !settings.onboardingDone && DEMO == null"))
    const block = gate.slice(0, gate.indexOf('const panelOpen'))
    expect(block).toMatch(/<OnboardingV2/)
    expect(block).not.toMatch(/<Panel>/)
    expect(block).toMatch(/onboard-stage/)
    expect(block).toMatch(/onboard-stripes/)
    expect(block).toMatch(/onboard-stripes--b/)
    expect(block).not.toMatch(/bg-\[#0c0c0e\]/)
    expect(block).toMatch(/h-full min-h-0 w-full/)
  })

  it('primary onboarding CTAs use onboard-cta (min 52×220) and Act 2 is full-bar Métis + Intelligence', () => {
    const experience = readFileSync(join(__dirname, '../../renderer/src/components/OnboardingExperience.tsx'), 'utf8')
    const demo = readFileSync(join(__dirname, '../../renderer/src/components/OnboardingDemoScene.tsx'), 'utf8')
    const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(css).toMatch(/\.onboard-cta\s*\{/)
    expect(css).toMatch(/min-height:\s*52px/)
    expect(css).toMatch(/min-width:\s*220px/)
    expect(css).toMatch(/\.onboard-stage\s*\{/)
    expect(css).toMatch(/#3a0b6b|#3A0B6B/)
    expect(css).toMatch(/#7f00da|#7F00DA/)
    expect(css).toMatch(/#9a2bf0|#9A2BF0/)
    expect(css).not.toMatch(/#3a2416|#5a3218|#2c1810|#f4b060/)
    expect(css).not.toMatch(/\.onboard-stage\s*\{[^}]*#0c0c0e/)
    expect(css).not.toMatch(/\.onboard-stage\s*\{[^}]*#000(?:000)?\b/)
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
    expect(experience).toMatch(/className="onboard-cta onboard-glass fade-up no-drag focus-ring"/)
    expect(experience.match(/className="onboard-cta no-drag focus-ring"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(demo).toMatch(/onboard-cta/)
    expect(demo).toMatch(/max-w-\[880px\]/)
    expect(demo).toMatch(/Mantu Intelligence/)
    expect(demo).toMatch(/demoRecapMarkdown/)
    expect(demo).toMatch(/ModeRecapView/)
    expect(demo).not.toMatch(/max-w-\[520px\]/)
    expect(demo).not.toMatch(/Recap · next steps/)
    expect(demo).toMatch(/<Bar/)
    expect(demo).toMatch(/<Copilot/)
    expect(demo).not.toMatch(/terminal|xterm|pty/i)
    expect(demo).not.toMatch(/setTimeout\(/)
    expect(demo).toMatch(/requestAnimationFrame\(/)
    expect(demo).toMatch(/useDemoPlayback/)
    expect(demo).toMatch(/demoPlaybackElapsed/)
    expect(demo).toMatch(/demoPlaybackAfterNext/)
    expect(demo).toMatch(/onPlayVideo\?\.\(\)/)
    expect(demo).toMatch(/setLocalMs\(next\.localMs\)/)
    expect(demo).toMatch(/Next/)
    expect(demo).toMatch(/Set me up/)
    expect(demo).toMatch(/This clip plays on its own/)
    expect(demo).not.toMatch(/anywhere on the stage/)
    expect(experience).toMatch(/href="https:\/\/www\.linkedin\.com\/in\/tonywalteur\/"/)
    expect(experience).toMatch(/Tony Walteur/)
    expect(experience).toMatch(/<a[\s\S]*tonywalteur[\s\S]*Tony Walteur/)
    expect(experience).toMatch(/createOnboardingMusicBed/)
    expect(experience).toMatch(/onboard-mute/)
    expect(experience).toMatch(/Mute music/)
    expect(experience).toMatch(/aria-pressed=\{music\.muted\}/)
    expect(css).toMatch(/\.onboard-mute\s*\{/)
    const stageCss = css.slice(css.indexOf('.onboard-stage {'))
    expect(stageCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation:\s*none/)
    expect(stageCss).not.toMatch(/#3a2416|#5a3218|#2c1810|#f4b060/)
    expect(index).toMatch(/backgroundColor: onboardingLive \? '#3A0B6B'/)
  })
})

describe('overlay chrome modes (hide / island / bar)', () => {
  it('default is hide; Settings switches island and bar; hide rest + leave collapse', () => {
    const ipc = readFileSync(join(__dirname, '../../shared/ipc.ts'), 'utf8')
    const settings = readFileSync(join(__dirname, '../../renderer/src/components/Settings.tsx'), 'utf8')
    const picker = readFileSync(join(__dirname, '../../renderer/src/components/OverlayChromePicker.tsx'), 'utf8')
    const app = readFileSync(join(__dirname, '../../renderer/src/App.tsx'), 'utf8')
    const peek = readFileSync(join(__dirname, '../../renderer/src/components/OverlayPeek.tsx'), 'utf8')
    const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')
    const autohide = readFileSync(join(__dirname, '../../renderer/src/lib/overlay-autohide.ts'), 'utf8')
    expect(ipc).toMatch(/overlayLayout: z\.enum\(\['hide', 'island', 'bar'\]\)\.default\('hide'\)/)
    expect(ipc).toMatch(/overlayLayout: 'hide'/)
    expect(settings).toMatch(/OverlayChromePicker/)
    expect(settings).toMatch(/overlayLayout: id/)
    expect(picker).toMatch(/OVERLAY_LAYOUTS/)
    expect(picker).toMatch(/aria-label="Overlay chrome"/)
    expect(picker).toMatch(/Default/)
    expect(picker).toMatch(/data-chrome-diagram=\{id\}/)
    expect(picker).toMatch(/overlay-chrome-diagram--\$\{id\}/)
    expect(css).toMatch(/\.overlay-chrome-diagram--hide/)
    expect(css).toMatch(/\.overlay-chrome-diagram--island/)
    expect(css).toMatch(/\.overlay-chrome-diagram--bar/)
    expect(settings).not.toMatch(/label="Auto-hide overlay"/)
    expect(app).toMatch(/parseOverlayLayout/)
    expect(app).toMatch(/overlayRestsHidden\(overlayLayout\) \? 'hide' : 'island'/)
    expect(app).toMatch(/pointer-leave/)
    expect(app).toMatch(/onOverlayCursorHover/)
    expect(app).toMatch(/dwell-elapsed/)
    expect(peek).toMatch(/rest === 'hide'/)
    expect(peek).toMatch(/onPointerEnter=\{onReveal\}/)
    expect(peek).toMatch(/data-hug-width=\{hidden \? undefined : true\}/)
    expect(css).toMatch(/\.overlay-hide-target/)
    expect(css).toMatch(/\.overlay-chrome-diagram--hide/)
    expect(autohide).toMatch(/case 'pointer-leave'/)
  })
})
