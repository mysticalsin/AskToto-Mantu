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
  exclusiveOnboardingBounds,
  onboardingFitsWorkArea,
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
    expect(topClamp('hide', m, 8)).toBe(m.workArea.y)
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
    expect(topClamp('hide', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
    expect(topClamp('island', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
    expect(topClamp('bar', m, 8)).toBe(RETINA_WORK_AREA.y + 8)
    expect(topClamp('hide', m, 8)).not.toBe(ISLAND_NOTCH_STRUT_PX)
  })

  it('Windows top taskbar uses workArea.y — no fake notch strut', () => {
    const m = metrics({
      workArea: { x: 0, y: 40, width: 1920, height: 1040 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      hasNotch: false,
      menuBarHeight: 0,
      source: 'heuristic'
    })
    expect(hasNotchHeuristic(40, 'win32')).toBe(false)
    expect(islandSafeTop(m)).toBe(40)
    expect(topClamp('hide', m, 8)).toBe(40)
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

describe('DESIGN.md overlay contract', () => {
  const design = readFileSync(join(__dirname, '../../../DESIGN.md'), 'utf8')

  it('lives at the repo root and names path A then path C (never another y=0 push)', () => {
    expect(design).toMatch(/workArea\.y/)
    expect(design).toMatch(/Path A/)
    expect(design).toMatch(/Path C/)
    expect(design).toMatch(/strut/i)
    expect(design).toMatch(/Never park at `display\.bounds\.y`/)
    expect(design).toMatch(/Do not push `y = 0` again/)
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
    expect(design).toMatch(/original Web Audio/)
    expect(design).toMatch(/Mute control/)
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
    expect(index).toMatch(/if \(onboardingExclusiveLive\(\)\) \{\s*applyExclusiveOnboardingStage\(win\)/)
    expect(index).not.toMatch(/Math\.min\(680/)
    expect(index).toMatch(/islandTopCenter\(BAR_WIDTH, display, ISLAND_TOP_MARGIN\)/)
  })

  it('App fills the stage — OnboardingV2 is not wrapped in the overlapping Panel card', () => {
    const app = readFileSync(join(__dirname, '../../renderer/src/App.tsx'), 'utf8')
    const gate = app.slice(app.indexOf("settings && !settings.onboardingDone && DEMO == null"))
    const block = gate.slice(0, gate.indexOf('const panelOpen'))
    expect(block).toMatch(/<OnboardingV2/)
    expect(block).not.toMatch(/<Panel>/)
    expect(block).toMatch(/onboard-stage/)
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
    const app = readFileSync(join(__dirname, '../../renderer/src/App.tsx'), 'utf8')
    const peek = readFileSync(join(__dirname, '../../renderer/src/components/OverlayPeek.tsx'), 'utf8')
    const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')
    const autohide = readFileSync(join(__dirname, '../../renderer/src/lib/overlay-autohide.ts'), 'utf8')
    expect(ipc).toMatch(/overlayLayout: z\.enum\(\['hide', 'island', 'bar'\]\)\.default\('hide'\)/)
    expect(ipc).toMatch(/overlayLayout: 'hide'/)
    expect(settings).toMatch(/OVERLAY_LAYOUTS/)
    expect(settings).toMatch(/overlayLayout: id/)
    expect(settings).toMatch(/aria-label="Overlay chrome"/)
    expect(settings).toMatch(/Default/)
    expect(settings).not.toMatch(/label="Auto-hide overlay"/)
    expect(app).toMatch(/parseOverlayLayout/)
    expect(app).toMatch(/overlayRestsHidden\(overlayLayout\) \? 'hide' : 'island'/)
    expect(app).toMatch(/pointer-leave/)
    expect(peek).toMatch(/rest === 'hide'/)
    expect(css).toMatch(/\.overlay-hide-target/)
    expect(autohide).toMatch(/case 'pointer-leave'/)
  })
})
