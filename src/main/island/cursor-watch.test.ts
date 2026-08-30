import { describe, expect, it } from 'vitest'
import {
  CURSOR_LEAVE_GRACE_PX,
  CURSOR_WATCH_INTERVAL_MS,
  decideCursorWatch,
  pointInRect,
  shouldWatchOverlayCursor
} from './cursor-watch'
import {
  hoverWatchRestRect,
  parkAfterExclusiveOnboarding,
  type DisplayMetrics
} from './geometry'

const tonyMac: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

describe('cursor-in-rect (Mac Dynamic Island hover)', () => {
  it('point in the notch strip is a hit; Y=200 is not', () => {
    const rest = hoverWatchRestRect('hide', tonyMac)
    expect(rest.y).toBe(0)
    expect(rest.height).toBeGreaterThanOrEqual(tonyMac.menuBarHeight)
    expect(pointInRect({ x: 900, y: 12 }, rest)).toBe(true)
    expect(pointInRect({ x: 900, y: 200 }, rest)).toBe(false)
  })

  it('decideCursorWatch reveals in the strip and hides after leaving the bar', () => {
    const rest = hoverWatchRestRect('hide', tonyMac)
    const revealed = { x: 460, y: 0, width: 880, height: 84 }
    expect(
      decideCursorWatch({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: revealed, revealed: false })
    ).toBe('reveal')
    expect(
      decideCursorWatch({ cursor: { x: 900, y: 200 }, restRect: rest, revealedRect: revealed, revealed: false })
    ).toBe('stay')
    expect(
      decideCursorWatch({ cursor: { x: 900, y: 40 }, restRect: rest, revealedRect: revealed, revealed: true })
    ).toBe('stay')
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 200 },
        restRect: rest,
        revealedRect: revealed,
        revealed: true,
        gracePx: CURSOR_LEAVE_GRACE_PX
      })
    ).toBe('hide')
  })

  it('revealed bar keeps y at bounds.y so a cursor at Y=12 does not leave', () => {
    const park = parkAfterExclusiveOnboarding('hide', tonyMac, 8)
    const revealedY = park.y
    expect(revealedY).toBe(0)
    const revealed = { x: park.x, y: revealedY, width: 880, height: 84 }
    expect(pointInRect({ x: 900, y: 12 }, revealed)).toBe(true)
  })

  it('wires only on darwin/win32 when hide/island and onboardingDone', () => {
    expect(shouldWatchOverlayCursor('darwin', true, 'hide')).toBe(true)
    expect(shouldWatchOverlayCursor('win32', true, 'island')).toBe(true)
    expect(shouldWatchOverlayCursor('linux', true, 'hide')).toBe(false)
    expect(shouldWatchOverlayCursor('darwin', false, 'hide')).toBe(false)
    expect(shouldWatchOverlayCursor('darwin', true, 'bar')).toBe(false)
    expect(CURSOR_WATCH_INTERVAL_MS).toBeGreaterThanOrEqual(16)
    expect(CURSOR_WATCH_INTERVAL_MS).toBeLessThanOrEqual(32)
  })
})
