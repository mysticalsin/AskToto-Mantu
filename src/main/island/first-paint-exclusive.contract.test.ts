import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exclusiveOnboardingBounds,
  firstPaintOverlayBounds,
  OVERLAY_HIDE_PARK,
  type DisplayMetrics,
  type Rect
} from './geometry'

const macbookBounds: Rect = { x: 0, y: 0, width: 1512, height: 982 }
const macbookWorkArea: Rect = { x: 0, y: 39, width: 1512, height: 943 }

function tonyMac(): DisplayMetrics {
  return {
    bounds: macbookBounds,
    workArea: macbookWorkArea,
    hasNotch: true,
    notchWidth: 200,
    menuBarHeight: 39,
    source: 'heuristic'
  }
}

describe('first-paint exclusive stage while !onboardingDone', () => {
  it('first-paint bounds equal the exclusive stage — never Hide/Island 8×2', () => {
    const exclusive = exclusiveOnboardingBounds(macbookBounds, macbookWorkArea)
    const first = firstPaintOverlayBounds({
      onboardingDone: false,
      bounds: macbookBounds,
      workArea: macbookWorkArea,
      layout: 'hide',
      metrics: tonyMac(),
      topMargin: 8
    })
    expect(first).toEqual(exclusive)
    expect(first.width).toBeGreaterThan(OVERLAY_HIDE_PARK.width)
    expect(first.height).toBeGreaterThan(OVERLAY_HIDE_PARK.height)
    expect(first.width).toBeGreaterThanOrEqual(macbookWorkArea.width)
    expect(first.height).toBeGreaterThanOrEqual(macbookWorkArea.height)
  })

  it('after onboardingDone, first paint may park hide — not before', () => {
    const parked = firstPaintOverlayBounds({
      onboardingDone: true,
      bounds: macbookBounds,
      workArea: macbookWorkArea,
      layout: 'hide',
      metrics: tonyMac(),
      topMargin: 8
    })
    expect(parked.width).toBe(OVERLAY_HIDE_PARK.width)
    expect(parked.height).toBe(OVERLAY_HIDE_PARK.height)
  })

  it('createWindow uses firstPaintOverlayBounds for constructor size', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/firstPaintOverlayBounds/)
    expect(create).toMatch(/width: firstPaint.width/)
    expect(create).toMatch(/height: firstPaint.height/)
    expect(create).not.toMatch(/restPark/)
    expect(create.indexOf('firstPaintOverlayBounds')).toBeLessThan(create.indexOf('new BrowserWindow'))
    expect(create.indexOf('if (onboardingLive) applyExclusiveOnboardingStage')).toBeGreaterThan(
      create.indexOf('new BrowserWindow')
    )
  })
})
