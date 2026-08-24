import { describe, expect, it } from 'vitest'
import { placeAvoiding } from './intelligence'

/** Overlap area in px^2 — 0 means the surfaces genuinely do not cover each other. */
function overlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return w * h
}

const SIZE = { width: 1280, height: 840, minHeight: 600 }

describe('placeAvoiding — the dashboard must not open under the always-on-top bar', () => {
  it('reproduces the MEASURED overlap when nothing is avoided, and removes it when the bar is passed', () => {
    // Exact numbers from a stress run against the packaged app: work area 1800x1082, bar at (460,24)
    // 880x120. Centring put the dashboard at y=121, so the bar covered its top 23px across 880px.
    const workArea = { x: 0, y: 0, width: 1800, height: 1082 }
    const bar = { x: 460, y: 24, width: 880, height: 120 }

    const centred = placeAvoiding(SIZE, workArea, undefined)
    expect(centred.y).toBe(121)
    expect(overlap(centred, bar)).toBe(20240)

    const avoided = placeAvoiding(SIZE, workArea, bar)
    expect(overlap(avoided, bar)).toBe(0)
    expect(avoided.y).toBeGreaterThanOrEqual(bar.y + bar.height)
  })

  it('stays inside the work area after being pushed down', () => {
    const workArea = { x: 0, y: 0, width: 1800, height: 1082 }
    const bar = { x: 460, y: 24, width: 880, height: 120 }
    const p = placeAvoiding(SIZE, workArea, bar)
    expect(p.x).toBeGreaterThanOrEqual(workArea.x)
    expect(p.y).toBeGreaterThanOrEqual(workArea.y)
    expect(p.y + p.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })

  it('leaves placement centred when the bar does not horizontally overlap the dashboard', () => {
    // A narrow bar parked off to one side is not in the way, so the dashboard should not be displaced.
    const workArea = { x: 0, y: 0, width: 3000, height: 1082 }
    const farLeftBar = { x: 0, y: 24, width: 200, height: 120 }
    const p = placeAvoiding(SIZE, workArea, farLeftBar)
    expect(overlap(p, farLeftBar)).toBe(0)
    expect(p.y).toBe(Math.round((1082 - 840) / 2))
  })

  it('shrinks rather than overflowing when the bar is tall, and never goes below minHeight', () => {
    // A grown bar (onboarding is ~680 tall) leaves little room underneath.
    const workArea = { x: 0, y: 0, width: 1800, height: 1082 }
    const tallBar = { x: 460, y: 24, width: 880, height: 400 }
    const p = placeAvoiding(SIZE, workArea, tallBar)
    expect(overlap(p, tallBar)).toBe(0)
    expect(p.height).toBeGreaterThanOrEqual(SIZE.minHeight)
    expect(p.y + p.height).toBeLessThanOrEqual(workArea.height)
  })

  it('keeps the window ON-SCREEN when even minHeight cannot fit beside the bar', () => {
    // Pathological: a bar covering most of a short screen. The earlier version of this test asserted only
    // "below the bar", which a y of 10000 would have satisfied — it could not have caught the real bug.
    // What actually matters is that the window stays inside the work area, because skipTaskbar means an
    // off-screen dashboard has no taskbar button to recover it and simply looks like a dead button.
    const workArea = { x: 0, y: 0, width: 1800, height: 700 }
    const hugeBar = { x: 460, y: 0, width: 880, height: 600 }
    const p = placeAvoiding(SIZE, workArea, hugeBar)
    expect(p.height).toBe(SIZE.minHeight)
    expect(p.y).toBeGreaterThanOrEqual(workArea.y)
    expect(p.y + p.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })

  it('goes ABOVE a bar parked low instead of pushing the window off the bottom', () => {
    // The bar is movable; a user who drags it low so it stops covering their call must not lose the
    // dashboard. Measured failure of the first version: bar at y=1000 placed the window at y=1092 on a
    // 1040-tall work area — entirely below the screen.
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const lowBar = { x: 520, y: 1000, width: 880, height: 84 }
    const p = placeAvoiding(SIZE, workArea, lowBar)
    expect(overlap(p, lowBar)).toBe(0)
    expect(p.y).toBeGreaterThanOrEqual(workArea.y)
    expect(p.y + p.height).toBeLessThanOrEqual(workArea.y + workArea.height)
    expect(p.y).toBeLessThan(lowBar.y) // chose the roomier side: above
  })

  it('never places the window outside the work area, for a bar at ANY vertical position', () => {
    // Property sweep rather than one example: whatever the bar's y, the result must be on-screen.
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    for (let barY = 0; barY <= workArea.height - 84; barY += 37) {
      const bar = { x: 520, y: barY, width: 880, height: 84 }
      const p = placeAvoiding(SIZE, workArea, bar)
      expect(p.y).toBeGreaterThanOrEqual(workArea.y)
      expect(p.y + p.height).toBeLessThanOrEqual(workArea.y + workArea.height)
      expect(p.height).toBeGreaterThanOrEqual(SIZE.minHeight)
    }
  })

  it('never returns a window wider or taller than the work area itself', () => {
    const small = { x: 0, y: 0, width: 1024, height: 768 }
    const p = placeAvoiding(SIZE, small, undefined)
    expect(p.width).toBeLessThanOrEqual(small.width)
    expect(p.height).toBeLessThanOrEqual(small.height)
  })

  it('respects a non-zero work-area origin (taskbar on the left / menu bar on top)', () => {
    const workArea = { x: 120, y: 40, width: 1680, height: 1000 }
    const p = placeAvoiding(SIZE, workArea, undefined)
    expect(p.x).toBeGreaterThanOrEqual(workArea.x)
    expect(p.y).toBeGreaterThanOrEqual(workArea.y)
    expect(p.x + p.width).toBeLessThanOrEqual(workArea.x + workArea.width)
  })
})
