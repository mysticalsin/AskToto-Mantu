import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformWithEsbuild } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_LEAVE_GRACE_PX, pointInRect } from '../main/island/cursor-watch'
import {
  hideParkWindowOpacity,
  hoverWatchRestRect,
  overlayPlacementPosition,
  parkAfterExclusiveOnboarding,
  parkedHoverReanchor,
  resolveOverlayPlacement,
  rightAnchoredParkPosition,
  rightEdgeParkLayout,
  rightEdgePosition,
  type DisplayMetrics
} from '../main/island/geometry'
import { revealOverlaySurface } from '../main/island/overlay-surface'
import { overlayUsesHover } from './overlay-chrome'
import { overlayDisplayKey } from './overlay-placement'
import {
  RIGHT_EDGE_DEFAULT_ANCHOR,
  RIGHT_EDGE_MARGIN_PX,
  anchorFraction,
  anchorY,
  cardTop,
  holdRegion,
  islandHeight,
  islandMaxHeight,
  islandRect,
  legacyDrawerRect,
  legacyTabCentreY,
  legacyTabRect,
  pointInRegion,
  readerRect,
  resolveRightEdgeAnchor,
  restRect,
  revealBand,
  revealCorridor,
  rightEdgeAnchorLocked,
  type Rect
} from './right-edge-geometry'

const wa = (width: number, height: number, x = 0, y = 0): Rect => ({ x, y, width, height })
/** The three floor sizes (spec v3 §7) plus the macOS row and two common desktops. */
const SIZES: Rect[] = [wa(853, 432), wa(853, 440), wa(1024, 528), wa(1280, 626, 0, 25), wa(1440, 875, 0, 25), wa(1920, 1032)]
const FRACTIONS = [0, 0.05, 0.15, 0.33, 0.5, 0.8, 1]
const bottom = (r: Rect): number => r.y + r.height
const right = (r: Rect): number => r.x + r.width

function insideInset(r: Rect, area: Rect, inset: number): boolean {
  return r.x >= area.x + inset && r.y >= area.y + inset && right(r) <= right(area) - inset && bottom(r) <= bottom(area) - inset
}

function pointsOf(r: Rect): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = []
  for (let x = r.x; x < right(r); x += Math.max(1, Math.floor(r.width / 8))) {
    for (let y = r.y; y < bottom(r); y += Math.max(1, Math.floor(r.height / 8))) points.push({ x, y })
  }
  points.push({ x: right(r) - 1, y: bottom(r) - 1 }, { x: r.x, y: bottom(r) - 1 }, { x: right(r) - 1, y: r.y })
  return points
}

describe('right-edge geometry authority (spec v3 §2)', () => {
  it('RE-G01: H = clamp(ceil8(content), 200, wa.h − 40) and the window is the card', () => {
    expect(islandMaxHeight(wa(853, 432))).toBe(392)
    expect(islandMaxHeight(wa(853, 440))).toBe(400)
    expect(islandMaxHeight(wa(1024, 528))).toBe(488)
    for (const area of [wa(853, 432), wa(853, 440), wa(1024, 528)]) {
      const a = anchorY(area)
      expect(islandRect(area, a, 10_000).height).toBe(islandMaxHeight(area))
    }
    const area = wa(1024, 528)
    expect(islandHeight(area, 0)).toBe(200)
    expect(islandHeight(area, 201)).toBe(208)
    expect(islandHeight(area, 208)).toBe(208)
    expect(islandHeight(area, 313)).toBe(320)
    const card = islandRect(area, anchorY(area), 240)
    expect(card).toEqual({ x: 1024 - 356, y: card.y, width: 344, height: 240 })
    expect(right(card)).toBe(right(area) - RIGHT_EDGE_MARGIN_PX)
  })

  it('RE-G02: every open, rest and Reader rect keeps the work-area margins at every anchor', () => {
    for (const area of SIZES) {
      for (const f of FRACTIONS) {
        const a = anchorY(area, f)
        expect(a).toBeGreaterThanOrEqual(area.y + 84)
        expect(a).toBeLessThanOrEqual(bottom(area) - 84)
        for (const content of [0, 240, 400, 10_000]) expect(insideInset(islandRect(area, a, content), area, 12)).toBe(true)
        expect(insideInset(legacyDrawerRect(area, a), area, 12)).toBe(true)
        expect(insideInset(legacyTabRect(area, a), area, 12)).toBe(true)
        expect(insideInset(readerRect(area), area, 12)).toBe(true)
        // The rest windows sit flush with the edge, inside the work area.
        for (const rest of [restRect('none', area, a), restRect('handle', area, a)]) {
          expect(insideInset(rest, area, 0)).toBe(true)
          expect(right(rest)).toBe(right(area))
        }
      }
    }
  })

  it('RE-G03: a height change never moves the card top unless the bottom clamp applies', () => {
    for (const area of SIZES) {
      for (const f of FRACTIONS) {
        const a = anchorY(area, f)
        for (let h = 200; h <= islandMaxHeight(area); h += 8) {
          const top = islandRect(area, a, h).y
          if (a - 36 + h <= bottom(area) - 12) expect(top).toBe(a - 36)
          else expect(top + h).toBe(bottom(area) - 12)
        }
      }
    }
  })

  it('RE-G04: the anchor is stored as f, and the tab, drawer and handle all follow the same A', () => {
    const area = wa(1440, 875, 0, 25)
    expect(anchorY(area)).toBe(Math.round(25 + RIGHT_EDGE_DEFAULT_ANCHOR * 875))
    // Fractions whose drawer and card are not bottom-clamped on this work area.
    for (const f of [0.15, 0.25, 0.35]) {
      const a = anchorY(area, f)
      expect(anchorY(area, anchorFraction(area, a))).toBe(a)
      const tab = legacyTabRect(area, a)
      const handle = restRect('handle', area, a)
      expect(tab.y + tab.height / 2).toBe(a)
      expect(handle.y + handle.height / 2).toBe(a)
      expect(legacyDrawerRect(area, a).y).toBe(a - 36)
      expect(islandRect(area, a, 200).y).toBe(a - 36)
    }
    // Clamped anchors move every surface together, too.
    const low = anchorY(area, 1)
    expect(low).toBe(bottom(area) - 84)
    expect(restRect('handle', area, low).y + 36).toBe(low)
  })

  it('RE-G04: lazy migration keeps the legacy handle centre within ±1 DIP or at the nearest clamp bound', () => {
    for (const area of SIZES) {
      const metrics: DisplayMetrics = { bounds: area, workArea: area, hasNotch: false, notchWidth: 0, menuBarHeight: 0, source: 'heuristic' }
      for (let legacy = 0; legacy <= 1.0001; legacy += 0.05) {
        // The legacy oracle: the tab main placed for that stored normalized Y, and its centre.
        const legacyCentre = rightEdgePosition(52, 52, metrics, legacy).y + 26
        expect(legacyTabCentreY(area, legacy)).toBe(legacyCentre)
        const { f, persist } = resolveRightEdgeAnchor({ workArea: area, legacyY: legacy })
        expect(persist).toBe(true)
        const a = anchorY(area, f)
        const lo = area.y + 84
        const hi = bottom(area) - 84
        if (legacyCentre < lo) expect(a).toBe(lo)
        else if (legacyCentre > hi) expect(a).toBe(hi)
        else expect(Math.abs(a - legacyCentre)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('RE-G04: a stored anchor wins and is not rewritten; nothing stored is the default', () => {
    const area = wa(1024, 528)
    expect(resolveRightEdgeAnchor({ workArea: area, anchor: 0.4, legacyY: 0.9 })).toEqual({ f: 0.4, persist: false })
    expect(resolveRightEdgeAnchor({ workArea: area })).toEqual({ f: RIGHT_EDGE_DEFAULT_ANCHOR, persist: false })
  })

  it('RE-G04: a lock on the old key locks the new one, and its managed value wins', () => {
    const area = wa(1024, 528)
    expect(rightEdgeAnchorLocked(['overlayRightEdgeYByDisplay'])).toBe(true)
    expect(rightEdgeAnchorLocked(['overlayRightEdgeAnchorByDisplay'])).toBe(true)
    expect(rightEdgeAnchorLocked(['overlayLayout'])).toBe(false)
    const managed = resolveRightEdgeAnchor({ workArea: area, anchor: 0.9, legacyY: 0.2, lockedKeys: ['overlayRightEdgeYByDisplay'] })
    expect(managed.persist).toBe(false)
    expect(anchorY(area, managed.f)).toBe(anchorY(area, resolveRightEdgeAnchor({ workArea: area, legacyY: 0.2 }).f))
    expect(resolveRightEdgeAnchor({ workArea: area, legacyY: 0.2, lockedKeys: ['overlayRightEdgeAnchorByDisplay'] }).persist).toBe(false)
  })

  it('RE-G05: the reveal band is [wa.y+48, wa.bottom−48] for every A and never changes with content', () => {
    for (const area of SIZES) {
      for (const f of FRACTIONS) {
        const a = anchorY(area, f)
        const band = revealBand(area, a)
        expect(band).toEqual({ x: right(area) - 4, y: area.y + 48, width: 4, height: area.height - 96 })
        expect(restRect('none', area, a)).toEqual(band)
        // The handle lies inside the band and inside the card's y span for every H.
        const handle = restRect('handle', area, a)
        expect(handle.y).toBeGreaterThanOrEqual(band.y)
        expect(bottom(handle)).toBeLessThanOrEqual(bottom(band))
        for (let h = 200; h <= islandMaxHeight(area); h += 8) {
          const top = cardTop(area, a, h)
          expect(handle.y).toBeGreaterThanOrEqual(top)
          expect(bottom(handle)).toBeLessThanOrEqual(top + h)
        }
      }
    }
  })

  it('RE-G05: the band and the whole live open rect (legacy drawer and island card) lie inside the hold region', () => {
    for (const area of SIZES) {
      for (const f of FRACTIONS) {
        const a = anchorY(area, f)
        for (const open of [legacyDrawerRect(area, a), islandRect(area, a, 200), islandRect(area, a, 10_000)]) {
          const region = holdRegion(area, open, a, { gracePx: CURSOR_LEAVE_GRACE_PX })
          for (const point of [...pointsOf(open), ...pointsOf(revealBand(area, a))]) expect(pointInRegion(point, region)).toBe(true)
          // The strip between the open rect and the edge holds too: no gap the leave rule can fall into.
          for (let x = right(open); x < right(area); x += 1) expect(pointInRegion({ x, y: open.y + 10 }, region)).toBe(true)
          // Well left of the open rect, away from the band, is outside.
          expect(pointInRegion({ x: open.x - 40, y: open.y + 10 }, region)).toBe(false)
        }
      }
    }
  })

  it('RE-G05: after a band reveal at wa.bottom−60 (f = 0.15), a diagonal move into the card stays inside the hold region', () => {
    for (const area of [wa(1280, 626, 0, 25), wa(1440, 875, 0, 25)]) {
      const a = anchorY(area, 0.15)
      for (const open of [islandRect(area, a, 200), legacyDrawerRect(area, a)]) {
        const reveal = { x: right(area) - 1, y: bottom(area) - 60 }
        const target = { x: open.x + open.width / 2, y: open.y + open.height / 2 }
        const corridor = revealCorridor(open, reveal.y, right(area))
        const withCorridor = holdRegion(area, open, a, { gracePx: CURSOR_LEAVE_GRACE_PX, corridor })
        const without = holdRegion(area, open, a, { gracePx: CURSOR_LEAVE_GRACE_PX })
        let missedWithout = false
        // 800 ms of 24 ms watch ticks along the diagonal.
        for (let t = 0; t <= 800; t += 24) {
          const point = { x: Math.round(reveal.x + ((target.x - reveal.x) * t) / 800), y: Math.round(reveal.y + ((target.y - reveal.y) * t) / 800) }
          expect(pointInRegion(point, withCorridor)).toBe(true)
          if (!pointInRegion(point, without)) missedWithout = true
        }
        // The legacy drawer at 1280x626 already spans the reveal point, so it needs no corridor there.
        if (reveal.y >= bottom(open)) {
          expect(corridor).not.toBeNull()
          expect(missedWithout).toBe(true)
        } else {
          expect(corridor).toBeNull()
        }
      }
    }
  })

  it('RE-G06: negative-origin displays keep every rect on that display', () => {
    for (const area of [wa(1920, 1040, -1920, 0), wa(1280, 680, 0, -720), wa(853, 432, -853, -432)]) {
      for (const f of FRACTIONS) {
        const a = anchorY(area, f)
        expect(insideInset(legacyDrawerRect(area, a), area, 12)).toBe(true)
        expect(insideInset(legacyTabRect(area, a), area, 12)).toBe(true)
        expect(insideInset(islandRect(area, a, 300), area, 12)).toBe(true)
        expect(insideInset(readerRect(area), area, 12)).toBe(true)
        expect(revealBand(area, a)).toEqual({ x: right(area) - 4, y: area.y + 48, width: 4, height: area.height - 96 })
      }
    }
  })

  it('RE-G07: the same stored f re-anchors inside a different display after a display is removed', () => {
    const big = wa(2560, 1400, 1440, 0)
    const small = wa(1024, 528)
    for (const f of FRACTIONS) {
      const onSmall = anchorY(small, f)
      expect(onSmall).toBe(Math.min(Math.max(Math.round(small.y + f * small.height), 84), bottom(small) - 84))
      expect(insideInset(legacyDrawerRect(small, onSmall), small, 12)).toBe(true)
      expect(insideInset(legacyTabRect(small, onSmall), small, 12)).toBe(true)
      expect(anchorY(big, f)).toBeGreaterThanOrEqual(big.y + 84)
    }
  })

  it('RE-G08: the Reader rect is its window, at most 720 wide, full height less the margins', () => {
    expect(readerRect(wa(853, 432))).toEqual({ x: 853 - 12 - 720, y: 12, width: 720, height: 408 })
    expect(readerRect(wa(1440, 875, 0, 25))).toEqual({ x: 1440 - 12 - 720, y: 37, width: 720, height: 851 })
    expect(readerRect(wa(600, 700))).toEqual({ x: 12, y: 12, width: 576, height: 676 })
  })
})

/**
 * RE-G10: every right-edge setBounds goes through applyRightEdgeBounds, and windowResize never changes
 * right-edge bounds. index.ts boots Electron at import, so the established pattern applies
 * (overlay-placement.contract.test.ts): lift the shipped right-edge paths out of index.ts, compile them with
 * the esbuild Vite already uses, and run them over a fake window and screen. applyRightEdgeBounds is wrapped
 * after lifting, so every native write records whether it ran inside it.
 */
describe('RE-G10: right-edge window bounds have one writer', () => {
  const index = readFileSync(join(__dirname, '../main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const slice = (from: string, to: string): string => {
    const start = index.indexOf(from)
    expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
    const end = index.indexOf(to, start)
    expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
    return index.slice(start, end)
  }

  interface Display {
    id: number
    bounds: Rect
    workArea: Rect
  }
  interface Write {
    kind: 'setBounds' | 'setPosition'
    rect: Rect
    insideApply: boolean
  }
  interface Harness {
    bounds: () => Rect
    writes: Write[]
    settings: Record<string, unknown>
    settingsWrites: Array<Record<string, unknown>>
    setDisplays: (next: Display[]) => void
    fire: (event: string) => void
    run: Record<string, (...args: unknown[]) => unknown>
    state: () => { islandResting: boolean }
    setResting: (resting: boolean) => void
  }

  afterEach(() => vi.useRealTimers())

  async function harness(options: {
    displays: Display[]
    layout?: 'hide' | 'island'
    resting?: boolean
    settings?: Record<string, unknown>
    lockedKeys?: string[]
    start?: Rect
  }): Promise<Harness> {
    const lifted = [
      slice('function commitParkedOverlayBounds(', 'function stopExclusiveBoundsWatch'),
      slice('function rightEdgeAnchorForDisplay(', 'function overlayCursorWatchWanted'),
      slice('function anchorTopCenter(): void {', 'function applySettingsSurface('),
      slice('function setWindowMode(): void {', 'const reveals = createRevealTrace'),
      slice('function moveBy(dx: number, dy: number): void {', 'function toggleVisible('),
      slice('function resizeTo(height: number): void {', '/** Collapse to / expand'),
      slice('ipcMain.handle(IPC.windowResize,', 'ipcMain.handle(IPC.windowMode')
    ].join('\n')
    const { code } = await transformWithEsbuild(lifted, 'lifted.ts', { loader: 'ts' })
    let displays = options.displays
    let current: Rect = options.start ?? { x: 0, y: 0, width: 4, height: 4 }
    let depth = 0
    const writes: Write[] = []
    const listeners: Record<string, () => void> = {}
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const settings: Record<string, unknown> = {
      overlayRightEdgeAnchorByDisplay: {},
      overlayRightEdgeYByDisplay: {},
      ...options.settings
    }
    const settingsWrites: Array<Record<string, unknown>> = []
    const overlap = (a: Rect, b: Rect): number =>
      Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y))
    const metrics = (d: Display): DisplayMetrics => ({ bounds: d.bounds, workArea: d.workArea, hasNotch: false, notchWidth: 0, menuBarHeight: 0, source: 'heuristic' })
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      showInactive: () => {},
      getBounds: () => ({ ...current }),
      setBounds: (rect: Rect) => {
        current = { ...rect }
        writes.push({ kind: 'setBounds', rect: { ...rect }, insideApply: depth > 0 })
      },
      setPosition: (x: number, y: number) => {
        current = { ...current, x, y }
        writes.push({ kind: 'setPosition', rect: { ...current }, insideApply: depth > 0 })
      },
      setAlwaysOnTop: () => {},
      setBackgroundColor: () => {},
      getBackgroundColor: () => '#000000',
      setOpacity: () => {},
      getOpacity: () => 1,
      setIgnoreMouseEvents: () => {}
    }
    const stubs = {
      win,
      screen: {
        getDisplayMatching: (rect: Rect) => displays.reduce((best, d) => (overlap(rect, d.workArea) > overlap(rect, best.workArea) ? d : best), displays[0]),
        getAllDisplays: () => displays,
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        on: (event: string, fn: () => void) => {
          listeners[event] = fn
        }
      },
      ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers[channel] = fn } },
      IPC: { windowResize: 'window:resize' },
      assertMainWindow: () => {},
      getSettings: () => settings,
      setSettings: (patch: Record<string, unknown>) => {
        settingsWrites.push(patch)
        Object.assign(settings, patch)
      },
      getLockedKeys: () => options.lockedKeys ?? [],
      overlayDisplayKey,
      mainLog: { warn: () => {}, info: () => {} },
      liveOverlayPlacement: () => 'right-edge',
      liveOverlayLayout: () => options.layout ?? 'hide',
      resolvedOverlayPlacementForDisplay: (d: Display) => resolveOverlayPlacement('right-edge', metrics(d)),
      getDisplayMetrics: metrics,
      onboardingExclusiveLive: () => false,
      overlayUsesHover,
      overlayPlacementPosition,
      parkAfterExclusiveOnboarding,
      parkedHoverReanchor,
      hoverWatchRestRect,
      rightEdgeParkLayout,
      rightAnchoredParkPosition,
      hideParkWindowOpacity,
      revealOverlaySurface,
      pointInRect,
      CURSOR_LEAVE_GRACE_PX,
      RIGHT_EDGE_DEFAULT_ANCHOR,
      anchorFraction,
      anchorY,
      holdRegion,
      legacyDrawerRect,
      legacyTabRect,
      resolveRightEdgeAnchor,
      restRect,
      revealCorridor,
      rightEdgeAnchorLocked,
      ensureWindow: () => win,
      cancelOverlayLeavePark: () => {},
      applyHideClickThrough: () => {},
      applyOverlaySurfaceChrome: () => {},
      parkOverlayAfterHideSpring: () => {},
      rememberBarContentHeight: (h: number) => h,
      ISLAND_TOP_MARGIN: 8,
      BAR_IDLE_HEIGHT_PX: 84,
      BAR_HEIGHT: 120,
      OVERLAY_REST_BACKGROUND: '#00000000',
      enterDepth: () => { depth += 1 },
      leaveDepth: () => { depth -= 1 }
    }
    const body = [
      `const { ${Object.keys(stubs).join(', ')} } = stubs`,
      `let islandResting = ${options.resting ?? false}`,
      'let settingsSurfaceOpen = false',
      'let isMinimized = false',
      'let currentWidth = 0',
      'let userAnchorY = null',
      'let lastBarHeight = 120',
      'let overlayCursorWatchHovering = false',
      'let overlayParkLatched = false',
      'let rightEdgeRevealY = null',
      'let rightEdgeAnchorSaveTimer = null',
      'const pendingRightEdgeAnchorByDisplay = new Map()',
      'const migratedRightEdgeAnchorKeys = new Set()',
      code,
      'const shippedApply = applyRightEdgeBounds',
      'applyRightEdgeBounds = function (...args) { enterDepth(); try { return shippedApply(...args) } finally { leaveDepth() } }',
      'registerScreenListeners()',
      'return {',
      '  run: { commitParkedOverlayBounds, parkedOverlayBounds, restoreBarWidth, repairOverlayBoundsForReveal, setWindowMode, anchorTopCenter, moveBy, resizeTo, rightEdgeAnchorY },',
      '  state: () => ({ islandResting }),',
      '  setResting: (resting) => { islandResting = resting }',
      '}'
    ].join('\n')
    const built = new Function('stubs', body)(stubs) as Pick<Harness, 'run' | 'state' | 'setResting'>
    return {
      ...built,
      run: { ...built.run, windowResize: (payload: unknown) => handlers['window:resize']({}, payload) },
      bounds: () => ({ ...current }),
      writes,
      settings,
      settingsWrites,
      setDisplays: (next) => {
        displays = next
      },
      fire: (event) => listeners[event]()
    }
  }

  const DISPLAY: Display = { id: 1, bounds: wa(1440, 900), workArea: wa(1440, 875, 0, 25) }

  it('parks, reveals, drags, re-anchors and re-modes only through applyRightEdgeBounds, at the authority rects', async () => {
    const h = await harness({ displays: [DISPLAY], layout: 'island', resting: true })
    vi.useFakeTimers()
    const area = DISPLAY.workArea
    const a = anchorY(area)
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('island', DISPLAY))
    expect(h.bounds()).toEqual(legacyTabRect(area, a))
    h.setResting(false)
    h.run.restoreBarWidth()
    expect(h.bounds()).toEqual(legacyDrawerRect(area, a))
    h.run.repairOverlayBoundsForReveal()
    h.run.setWindowMode()
    h.run.anchorTopCenter()
    expect(h.bounds()).toEqual(legacyDrawerRect(area, a))
    // A header drag changes only A: the drawer moves, and the parked tab follows the same anchor.
    h.run.moveBy(0, 40)
    expect(h.bounds()).toEqual(legacyDrawerRect(area, a + 40))
    expect(h.run.rightEdgeAnchorY(DISPLAY)).toBe(a + 40)
    h.setResting(true)
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('island', DISPLAY))
    expect(h.bounds()).toEqual(legacyTabRect(area, a + 40))
    // A drag of the parked tab moves the tab (spec v3 §2: through legacyTabRect(A), not the old normalized Y).
    h.run.moveBy(0, 30)
    expect(h.bounds()).toEqual(legacyTabRect(area, a + 70))
    // Persisted once, after the drag settles, as the anchor fraction; the legacy key is untouched.
    expect(h.settingsWrites).toEqual([])
    vi.advanceTimersByTime(350)
    expect(h.settingsWrites).toEqual([{ overlayRightEdgeAnchorByDisplay: { 'display:1': anchorFraction(area, a + 70) } }])
    expect(h.settings.overlayRightEdgeYByDisplay).toEqual({})
    // A display change re-anchors the rest, then the open drawer, at the stored anchor on the new work area.
    const smaller: Display = { id: 1, bounds: wa(1024, 576), workArea: wa(1024, 528) }
    h.setDisplays([smaller])
    h.fire('display-metrics-changed')
    const f = anchorFraction(area, a + 70)
    expect(h.bounds()).toEqual(legacyTabRect(smaller.workArea, anchorY(smaller.workArea, f)))
    h.setResting(false)
    h.fire('display-removed')
    expect(h.bounds()).toEqual(legacyDrawerRect(smaller.workArea, anchorY(smaller.workArea, f)))
    expect(h.writes.length).toBeGreaterThan(0)
    expect(h.writes.filter((write) => !write.insideApply)).toEqual([])
  })

  it('parks Hide on the reveal band through the same writer', async () => {
    const h = await harness({ displays: [DISPLAY], layout: 'hide', resting: true })
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('hide', DISPLAY))
    expect(h.bounds()).toEqual(revealBand(DISPLAY.workArea, anchorY(DISPLAY.workArea)))
    expect(h.writes.every((write) => write.insideApply)).toBe(true)
  })

  it('windowResize and resizeTo never change right-edge bounds', async () => {
    const h = await harness({ displays: [DISPLAY], layout: 'island' })
    h.run.restoreBarWidth()
    const open = h.bounds()
    const before = h.writes.length
    for (const payload of [{ height: 900 }, { height: 40, width: 220 }, { height: Number.NaN }]) h.run.windowResize(payload)
    h.run.resizeTo(900)
    expect(h.writes.length).toBe(before)
    expect(h.bounds()).toEqual(open)
  })

  it('RE-G04: a legacy-only display converts on its first resolve, and a display absent at upgrade on first attach', async () => {
    const legacy = { 'display:1': 0.5, 'display:2': 0.25 }
    const h = await harness({ displays: [DISPLAY], layout: 'island', resting: true, settings: { overlayRightEdgeYByDisplay: legacy } })
    h.run.commitParkedOverlayBounds(h.run.parkedOverlayBounds('island', DISPLAY))
    const metrics: DisplayMetrics = { bounds: DISPLAY.bounds, workArea: DISPLAY.workArea, hasNotch: false, notchWidth: 0, menuBarHeight: 0, source: 'heuristic' }
    const centre = rightEdgePosition(52, 52, metrics, 0.5).y + 26
    const tab = h.bounds()
    expect(Math.abs(tab.y + tab.height / 2 - centre)).toBeLessThanOrEqual(1)
    expect(Object.keys(h.settings.overlayRightEdgeAnchorByDisplay as object)).toEqual(['display:1'])
    // Display 2 was not attached at upgrade: it converts when the window first lands on it.
    const second: Display = { id: 2, bounds: wa(1920, 1080, 1440, 0), workArea: wa(1920, 1040, 1440, 0) }
    h.setDisplays([second])
    h.fire('display-removed')
    expect(Object.keys(h.settings.overlayRightEdgeAnchorByDisplay as object).sort()).toEqual(['display:1', 'display:2'])
    const secondMetrics: DisplayMetrics = { ...metrics, bounds: second.bounds, workArea: second.workArea }
    const secondTab = h.bounds()
    expect(Math.abs(secondTab.y + secondTab.height / 2 - (rightEdgePosition(52, 52, secondMetrics, 0.25).y + 26))).toBeLessThanOrEqual(1)
    // Each display migrated exactly once; the legacy key stays read-only.
    expect(h.settingsWrites).toHaveLength(2)
    expect(h.settings.overlayRightEdgeYByDisplay).toEqual(legacy)
  })

  it('RE-G04: a lock on the old key locks the new one: no migration write, no persisted drag', async () => {
    const h = await harness({
      displays: [DISPLAY],
      layout: 'island',
      settings: { overlayRightEdgeYByDisplay: { 'display:1': 0.5 } },
      lockedKeys: ['overlayRightEdgeYByDisplay']
    })
    vi.useFakeTimers()
    h.run.restoreBarWidth()
    const open = h.bounds()
    h.run.moveBy(0, 60)
    vi.advanceTimersByTime(1000)
    expect(h.settingsWrites).toEqual([])
    expect(h.bounds()).toEqual(open)
  })
})
