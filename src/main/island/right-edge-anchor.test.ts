import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RIGHT_EDGE_DEFAULT_ANCHOR,
  anchorFraction,
  anchorY,
  legacyDrawerRect,
  legacyTabCentreY,
  legacyTabRect,
  pointInRegion,
  readerRect,
  restRect,
  type Rect
} from '@shared/right-edge-geometry'
import { rightEdgePosition, type DisplayMetrics } from './geometry'
import { RIGHT_EDGE_ANCHOR_SAVE_MS, createRightEdgeAnchors, type RightEdgeAnchorDeps } from './right-edge-anchor'

const wa = (width: number, height: number, x = 0, y = 0): Rect => ({ x, y, width, height })
const bottom = (r: Rect): number => r.y + r.height
const right = (r: Rect): number => r.x + r.width

function store(options: { anchors?: Record<string, number>; legacy?: Record<string, number>; locked?: string[]; live?: boolean; failWrites?: boolean } = {}) {
  const anchors: Record<string, number> = { ...options.anchors }
  const legacy: Record<string, number> = { ...options.legacy }
  const saves: Array<Record<string, number>> = []
  const warnings: string[] = []
  const timers: Array<{ run: () => void; ms: number }> = []
  const deps: RightEdgeAnchorDeps = {
    stored: () => ({ anchors, legacy }),
    saveAnchors: (next) => {
      saves.push(next)
      if (options.failWrites) throw new Error('store unavailable')
      Object.assign(anchors, next)
    },
    lockedKeys: () => options.locked ?? [],
    rightEdgeLive: () => options.live ?? true,
    warn: (message) => warnings.push(message),
    later: (run, ms) => timers.push({ run, ms })
  }
  return { anchors, legacy, saves, warnings, timers, edge: createRightEdgeAnchors(deps) }
}

const DISPLAY = { id: 1, workArea: wa(1440, 875, 0, 25) }

describe('right-edge anchor store (M2-0202 spec v3 §2)', () => {
  afterEach(() => vi.useRealTimers())

  it('RE-G04: the converted anchor matches the tab main placed for every legacy normalized Y', () => {
    for (const area of [wa(853, 432), wa(1024, 528), wa(1440, 875, 0, 25), wa(1920, 1040, -1920, 0)]) {
      const metrics: DisplayMetrics = { bounds: area, workArea: area, hasNotch: false, notchWidth: 0, menuBarHeight: 0, source: 'heuristic' }
      for (let legacy = 0; legacy <= 1.0001; legacy += 0.05) {
        // The legacy oracle: the 52x52 tab main placed for that stored normalized Y, and its centre.
        const legacyCentre = rightEdgePosition(52, 52, metrics, legacy).y + 26
        expect(legacyTabCentreY(area, legacy)).toBe(legacyCentre)
        const { edge } = store({ legacy: { 'display:1': legacy } })
        const a = edge.y({ id: 1, workArea: area })
        const lo = area.y + 84
        const hi = bottom(area) - 84
        if (legacyCentre < lo) expect(a).toBe(lo)
        else if (legacyCentre > hi) expect(a).toBe(hi)
        else expect(Math.abs(a - legacyCentre)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('RE-G04: a display migrates once on its first resolve; the legacy key stays read-only', () => {
    const s = store({ legacy: { 'display:1': 0.5, 'display:2': 0.25 } })
    const f = s.edge.fraction(DISPLAY)
    s.edge.fraction(DISPLAY)
    expect(s.saves).toEqual([{ 'display:1': f }])
    // Display 2 converts only when it is first resolved (attached after the upgrade).
    const second = { id: 2, workArea: wa(1920, 1040, 1440, 0) }
    s.edge.fraction(second)
    expect(s.saves.map((save) => Object.keys(save)[0])).toEqual(['display:1', 'display:2'])
    expect(s.legacy).toEqual({ 'display:1': 0.5, 'display:2': 0.25 })
  })

  it('RE-G04: a failed migration write warns once and is not retried per tick', () => {
    const s = store({ legacy: { 'display:1': 0.5 }, failWrites: true })
    const f = s.edge.fraction(DISPLAY)
    expect(s.edge.fraction(DISPLAY)).toBe(f)
    expect(s.saves).toHaveLength(1)
    expect(s.warnings).toEqual(['could not migrate the right-edge position'])
  })

  it('RE-G04: a lock on either key blocks the migration write and drags', () => {
    for (const locked of [['overlayRightEdgeYByDisplay'], ['overlayRightEdgeAnchorByDisplay']]) {
      const s = store({ legacy: { 'display:1': 0.5 }, locked })
      const a = s.edge.y(DISPLAY)
      s.edge.drag(DISPLAY, a + 60)
      expect(s.edge.y(DISPLAY)).toBe(a)
      expect(s.timers).toEqual([])
      expect(s.saves).toEqual([])
    }
  })

  it('without a display key or anything stored, the anchor is the default', () => {
    expect(store().edge.fraction(DISPLAY)).toBe(RIGHT_EDGE_DEFAULT_ANCHOR)
    expect(store({ anchors: { 'display:0': 0.9 } }).edge.fraction({ id: 0, workArea: DISPLAY.workArea })).toBe(RIGHT_EDGE_DEFAULT_ANCHOR)
  })

  it('a drag moves every rect at once and persists the clamped fraction once, after the drag settles', () => {
    const s = store()
    const area = DISPLAY.workArea
    const a = s.edge.y(DISPLAY)
    s.edge.drag(DISPLAY, a + 20)
    s.edge.drag(DISPLAY, a + 50)
    expect(s.edge.rect('open', DISPLAY)).toEqual(legacyDrawerRect(area, a + 50))
    expect(s.edge.rect('tab', DISPLAY)).toEqual(legacyTabRect(area, a + 50))
    expect(s.edge.rect('band', DISPLAY)).toEqual(restRect('none', area, a + 50))
    expect(s.timers.map((timer) => timer.ms)).toEqual([RIGHT_EDGE_ANCHOR_SAVE_MS])
    s.timers[0].run()
    expect(s.saves).toEqual([{ 'display:1': anchorFraction(area, a + 50) }])
    expect(s.edge.y(DISPLAY)).toBe(a + 50)
    // A drag past the bottom bound is stored at the bound, so dragging back moves at once.
    s.edge.drag(DISPLAY, bottom(area) + 400)
    expect(s.edge.y(DISPLAY)).toBe(bottom(area) - 84)
    s.edge.drag(DISPLAY, bottom(area) - 84 - 10)
    expect(s.edge.y(DISPLAY)).toBe(bottom(area) - 94)
  })

  it('a drag that settles after the placement left the right edge is not persisted', () => {
    const s = store({ live: false })
    s.edge.drag(DISPLAY, s.edge.y(DISPLAY) + 40)
    s.timers[0].run()
    expect(s.saves).toEqual([])
  })

  it('RE-G05: the band-reveal corridor holds until the pointer first enters the drawer', () => {
    const s = store()
    const area = DISPLAY.workArea
    const open = s.edge.rect('open', DISPLAY)
    const reveal = { x: right(area) - 1, y: bottom(area) - 60 }
    expect(reveal.y).toBeGreaterThan(bottom(open))
    const below = { x: open.x + 60, y: reveal.y - 40 }
    expect(pointInRegion(below, s.edge.hold(DISPLAY, below))).toBe(false)
    s.edge.noteReveal(reveal.y)
    expect(pointInRegion(below, s.edge.hold(DISPLAY, below))).toBe(true)
    const inside = { x: open.x + 20, y: open.y + 20 }
    expect(pointInRegion(inside, s.edge.hold(DISPLAY, inside))).toBe(true)
    // Entered: the corridor is gone, so the same spot below the drawer is a leave.
    expect(pointInRegion(below, s.edge.hold(DISPLAY, below))).toBe(false)
    // The band itself always holds.
    expect(pointInRegion(reveal, s.edge.hold(DISPLAY, reveal))).toBe(true)
  })

  it('every rect follows the same anchor A', () => {
    const s = store({ anchors: { 'display:1': 0.3 } })
    const a = anchorY(DISPLAY.workArea, 0.3)
    expect(s.edge.y(DISPLAY)).toBe(a)
    expect(s.edge.rect('tab', DISPLAY).y + 26).toBe(a)
    expect(s.edge.rect('open', DISPLAY).y).toBe(a - 36)
    expect(s.saves).toEqual([])
  })

  it('the Reader window is readerRect: the full work-area height at the same right edge, whatever the anchor', () => {
    for (const f of [0, 0.15, 1]) {
      const s = store({ anchors: { 'display:1': f } })
      const reader = s.edge.rect('reader', DISPLAY)
      expect(reader).toEqual(readerRect(DISPLAY.workArea))
      expect(reader).toEqual({ x: 1440 - 12 - 720, y: 25 + 12, width: 720, height: 875 - 24 })
      expect(right(reader)).toBe(right(s.edge.rect('open', DISPLAY)))
    }
  })
})
