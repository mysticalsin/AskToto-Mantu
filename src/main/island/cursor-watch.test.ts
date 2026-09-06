import { describe, expect, it } from 'vitest'
import {
  CURSOR_LEAVE_GRACE_PX,
  CURSOR_WATCH_INTERVAL_MS,
  decideCursorWatch,
  overlayWatchNeedsRestore,
  overlayWatchTreatAsRevealed,
  pointInRect,
  shouldWatchOverlayCursor
} from './cursor-watch'
import { hoverWatchRestRect, islandSafeTop, type DisplayMetrics } from './geometry'

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
    expect(rest.height).toBe(tonyMac.workArea.y - tonyMac.bounds.y + 1)
    expect(rest.height).toBeLessThan(44)
    expect(rest.width).toBe(tonyMac.workArea.width)
    expect(pointInRect({ x: 900, y: 12 }, rest)).toBe(true)
    expect(pointInRect({ x: 900, y: 200 }, rest)).toBe(false)
  })

  it('revealed bar at y=39 stays open when the pointer is in the island (Y=12)', () => {
    const rest = { x: 620, y: 0, width: 560, height: 39 }
    const revealed = { x: 460, y: 39, width: 880, height: 84 }
    expect(islandSafeTop(tonyMac)).toBe(39)
    expect(
      decideCursorWatch({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: revealed, revealed: false })
    ).toBe('reveal')
    expect(
      decideCursorWatch({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: revealed, revealed: true })
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

  it('after a display move, island hover at Y=12 still reveals (watch stays at bounds.y)', () => {
    const second: DisplayMetrics = {
      bounds: { x: 1800, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1800, y: 39, width: 1920, height: 1041 },
      hasNotch: true,
      notchWidth: 200,
      menuBarHeight: 39,
      source: 'helper'
    }
    const rest = hoverWatchRestRect('island', second)
    expect(rest.y).toBe(second.bounds.y)
    expect(rest.y).not.toBe(second.workArea.y)
    expect(
      decideCursorWatch({
        cursor: { x: 1800 + 960, y: 12 },
        restRect: rest,
        revealedRect: { x: 1800 + 520, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('reveal')
  })

  it('does not treat a cursor at Y=12 as having left a macOS-clamped bar', () => {
    const rest = hoverWatchRestRect('hide', tonyMac)
    const revealed = { x: 460, y: 39, width: 880, height: 84 }
    expect(pointInRect({ x: 900, y: 12 }, revealed)).toBe(false)
    expect(
      decideCursorWatch({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: revealed, revealed: true })
    ).toBe('stay')
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

  it('hidden LSUIElement is not revealed; stuck hovering latch still restores', () => {
    expect(overlayWatchTreatAsRevealed(true, true)).toBe(false)
    expect(overlayWatchTreatAsRevealed(false, true)).toBe(true)
    expect(overlayWatchTreatAsRevealed(false, false)).toBe(false)
    expect(overlayWatchTreatAsRevealed(true, false)).toBe(false)
    expect(
      overlayWatchNeedsRestore({
        decision: 'reveal',
        alreadyHovering: false,
        islandResting: true,
        windowVisible: true
      })
    ).toBe(true)
    expect(
      overlayWatchNeedsRestore({
        decision: 'reveal',
        alreadyHovering: true,
        islandResting: false,
        windowVisible: false
      })
    ).toBe(true)
    expect(
      overlayWatchNeedsRestore({
        decision: 'reveal',
        alreadyHovering: true,
        islandResting: true,
        windowVisible: true
      })
    ).toBe(true)
    expect(
      overlayWatchNeedsRestore({
        decision: 'reveal',
        alreadyHovering: true,
        islandResting: false,
        windowVisible: true
      })
    ).toBe(false)
    expect(
      overlayWatchNeedsRestore({
        decision: 'stay',
        alreadyHovering: false,
        islandResting: true,
        windowVisible: true
      })
    ).toBe(false)
  })
})
