import { describe, expect, it } from 'vitest'
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
  RIGHT_EDGE_ISLAND_CHROME_PX,
  RIGHT_EDGE_MIN_WORK_AREA,
  islandSlotMax,
  rightEdgeFits,
  type Rect
} from './right-edge-geometry'
import { RE_TYPING_PIN_MS, RIGHT_EDGE_TIMINGS, RIGHT_EDGE_TIMING_RANGES } from './right-edge-timing'

const wa = (width: number, height: number, x = 0, y = 0): Rect => ({ x, y, width, height })
/** The three floor sizes (spec v3 §7) plus the macOS row and two common desktops. */
const SIZES: Rect[] = [
  wa(853, 432),
  wa(853, 440),
  wa(1024, 528),
  wa(1280, 626, 0, 25),
  wa(1440, 875, 0, 25),
  wa(1920, 1032)
]
const FRACTIONS = [0, 0.05, 0.15, 0.33, 0.5, 0.8, 1]
/** A leave grace like main's cursor-watch one; the hold-region invariants hold for any non-negative grace. */
const GRACE_PX = 8
const bottom = (r: Rect): number => r.y + r.height
const right = (r: Rect): number => r.x + r.width

function insideInset(r: Rect, area: Rect, inset: number): boolean {
  return (
    r.x >= area.x + inset &&
    r.y >= area.y + inset &&
    right(r) <= right(area) - inset &&
    bottom(r) <= bottom(area) - inset
  )
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
        for (const content of [0, 240, 400, 10_000])
          expect(insideInset(islandRect(area, a, content), area, 12)).toBe(true)
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
    // legacyTabCentreY is checked against main's legacy tab placement in island/right-edge-anchor.test.ts.
    for (const area of SIZES) {
      for (let legacy = 0; legacy <= 1.0001; legacy += 0.05) {
        const legacyCentre = legacyTabCentreY(area, legacy)
        expect(legacyCentre).toBeGreaterThanOrEqual(area.y + 12 + 26)
        expect(legacyCentre).toBeLessThanOrEqual(bottom(area) - 12 - 26)
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
    const managed = resolveRightEdgeAnchor({
      workArea: area,
      anchor: 0.9,
      legacyY: 0.2,
      lockedKeys: ['overlayRightEdgeYByDisplay']
    })
    expect(managed.persist).toBe(false)
    expect(anchorY(area, managed.f)).toBe(anchorY(area, resolveRightEdgeAnchor({ workArea: area, legacyY: 0.2 }).f))
    expect(
      resolveRightEdgeAnchor({ workArea: area, legacyY: 0.2, lockedKeys: ['overlayRightEdgeAnchorByDisplay'] }).persist
    ).toBe(false)
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
          const region = holdRegion(area, open, a, { gracePx: GRACE_PX })
          for (const point of [...pointsOf(open), ...pointsOf(revealBand(area, a))])
            expect(pointInRegion(point, region)).toBe(true)
          // The strip between the open rect and the edge holds too: no gap the leave rule can fall into.
          for (let x = right(open); x < right(area); x += 1)
            expect(pointInRegion({ x, y: open.y + 10 }, region)).toBe(true)
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
        const withCorridor = holdRegion(area, open, a, { gracePx: GRACE_PX, corridor })
        const without = holdRegion(area, open, a, { gracePx: GRACE_PX })
        let missedWithout = false
        // 800 ms of 24 ms watch ticks along the diagonal.
        for (let t = 0; t <= 800; t += 24) {
          const point = {
            x: Math.round(reveal.x + ((target.x - reveal.x) * t) / 800),
            y: Math.round(reveal.y + ((target.y - reveal.y) * t) / 800)
          }
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

describe('right-edge fit and timing (M2-0202 S2)', () => {
  it('RE-G09: a work area under 432 tall or 384 wide does not fit the right edge; 853x432 does', () => {
    expect(RIGHT_EDGE_MIN_WORK_AREA).toEqual({ width: 384, height: 432 })
    for (const area of SIZES) expect(rightEdgeFits(area), `${area.width}x${area.height}`).toBe(true)
    expect(rightEdgeFits(wa(853, 432))).toBe(true)
    expect(rightEdgeFits(wa(384, 432))).toBe(true)
    expect(rightEdgeFits(wa(853, 431))).toBe(false)
    expect(rightEdgeFits(wa(383, 900))).toBe(false)
    expect(rightEdgeFits(wa(360, 864))).toBe(false)
  })

  it('the content slot is H_max less the island chrome at every floor size', () => {
    expect(islandSlotMax(wa(853, 432))).toBe(392 - RIGHT_EDGE_ISLAND_CHROME_PX)
    expect(islandSlotMax(wa(853, 440))).toBe(400 - RIGHT_EDGE_ISLAND_CHROME_PX)
    expect(islandSlotMax(wa(1024, 528))).toBe(488 - RIGHT_EDGE_ISLAND_CHROME_PX)
    for (const area of SIZES) expect(islandSlotMax(area)).toBeGreaterThan(0)
  })

  it('RE-T01: every right-edge timing constant lies inside its kit §5.4 range', () => {
    const names = Object.keys(RIGHT_EDGE_TIMING_RANGES) as Array<keyof typeof RIGHT_EDGE_TIMING_RANGES>
    expect(Object.keys(RIGHT_EDGE_TIMINGS).sort()).toEqual([...names].sort())
    for (const name of names) {
      const [min, max] = RIGHT_EDGE_TIMING_RANGES[name]
      expect(RIGHT_EDGE_TIMINGS[name], name).toBeGreaterThanOrEqual(min)
      expect(RIGHT_EDGE_TIMINGS[name], name).toBeLessThanOrEqual(max)
    }
    // The click-into-an-empty-composer hold of RE-P01.
    expect(RE_TYPING_PIN_MS).toBe(8000)
  })
})
