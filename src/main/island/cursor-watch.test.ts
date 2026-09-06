import { describe, expect, it } from 'vitest'
import {
  CURSOR_LEAVE_GRACE_PX,
  CURSOR_WATCH_INTERVAL_MS,
  OVERLAY_LEAVE_PARK_MS,
  decideCursorWatch,
  overlayWatchNeedsRestore,
  overlayWatchShouldParkOnLeave,
  overlayWatchStep,
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
    expect(
      overlayWatchNeedsRestore({
        decision: 'stay',
        alreadyHovering: true,
        islandResting: false,
        windowVisible: true,
        hugStub: true
      })
    ).toBe(true)
  })

  it('leave at ~(900,600) hides a revealed 880×120 Ask bar and parks within 1–2s', () => {
    const rest = hoverWatchRestRect('hide', tonyMac)
    const revealed = { x: 460, y: 39, width: 880, height: 120 }
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 600 },
        restRect: rest,
        revealedRect: revealed,
        revealed: true
      })
    ).toBe('hide')
    expect(overlayWatchShouldParkOnLeave({ decision: 'hide', islandResting: false, osHoverSeen: true })).toBe(true)
    expect(overlayWatchShouldParkOnLeave({ decision: 'hide', islandResting: true, osHoverSeen: true })).toBe(false)
    expect(overlayWatchShouldParkOnLeave({ decision: 'stay', islandResting: false, osHoverSeen: true })).toBe(false)
    // Never saw the OS cursor near the bar: the renderer owns this reveal, main must not park it.
    expect(overlayWatchShouldParkOnLeave({ decision: 'hide', islandResting: false, osHoverSeen: false })).toBe(false)
    expect(OVERLAY_LEAVE_PARK_MS).toBeGreaterThanOrEqual(400)
    expect(OVERLAY_LEAVE_PARK_MS).toBeLessThanOrEqual(2000)
    expect(pointInRect({ x: 900, y: 600 }, rest)).toBe(false)
    expect(pointInRect({ x: 900, y: 600 }, revealed)).toBe(false)
  })
})

/**
 * Main-process Hide hover as one scripted sequence. Every step is what tickOverlayCursorWatch
 * does with `overlayWatchStep`; the latch (`osHoverSeen`) is main's overlayCursorWatchHovering.
 */
describe('Hide top-edge hover: main-process step sequence (Ultron re-check)', () => {
  const rest = hoverWatchRestRect('hide', tonyMac)
  const PARK = { x: 896, y: 0, width: 8, height: 2 }
  const ASK = { x: 460, y: 39, width: 880, height: 120 }
  const AWAY = { x: 900, y: 600 }

  it('parked 8x2, cursor away: stay, latch off, nothing moves', () => {
    const s = overlayWatchStep({ cursor: AWAY, restRect: rest, revealedRect: PARK, islandResting: true, windowVisible: true, osHoverSeen: false })
    expect(s).toEqual({ action: 'stay', osHoverSeen: false })
  })

  it('top edge left / camera / right / first work-area row reveals from park and latches', () => {
    for (const cursor of [{ x: 24, y: 12 }, { x: 900, y: 12 }, { x: 1770, y: 8 }, { x: 900, y: 0 }, { x: 24, y: tonyMac.workArea.y }]) {
      const s = overlayWatchStep({ cursor, restRect: rest, revealedRect: PARK, islandResting: true, windowVisible: true, osHoverSeen: false })
      expect(s).toEqual({ action: 'restore', osHoverSeen: true })
    }
  })

  it('tray-hidden window still reveals from the top edge (showInactive path)', () => {
    const s = overlayWatchStep({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: false, osHoverSeen: true })
    expect(s.action).toBe('restore')
  })

  it('revealed: cursor in the strip or on the bar stays (no setBounds) and keeps the latch', () => {
    for (const cursor of [{ x: 900, y: 12 }, { x: 900, y: 39 }, { x: 900, y: 100 }, { x: 1339 + 4, y: 100 }]) {
      const s = overlayWatchStep({ cursor, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: true, osHoverSeen: true })
      expect(s).toEqual({ action: 'stay', osHoverSeen: true })
    }
  })

  it('c74e389: latched reveal + leave to ~(900,600) parks and drops the latch; next tick is quiet', () => {
    const first = overlayWatchStep({ cursor: AWAY, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: true, osHoverSeen: true })
    expect(first).toEqual({ action: 'park', osHoverSeen: false })
    // The 800ms timer is armed; ticks until it fires must not re-arm or re-notify.
    const next = overlayWatchStep({ cursor: AWAY, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: true, osHoverSeen: first.osHoverSeen })
    expect(next).toEqual({ action: 'leave-ignored', osHoverSeen: false })
    // After park (islandResting true, 8x2) the same cursor is a plain stay.
    const parked = overlayWatchStep({ cursor: AWAY, restRect: rest, revealedRect: PARK, islandResting: true, windowVisible: true, osHoverSeen: false })
    expect(parked).toEqual({ action: 'stay', osHoverSeen: false })
  })

  it('renderer-owned reveal (toast / typed input / synthetic hover) with the OS cursor away is never parked by main', () => {
    let latch = false
    for (let tick = 0; tick < 100; tick++) {
      const s = overlayWatchStep({ cursor: AWAY, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: true, osHoverSeen: latch })
      expect(s.action).toBe('leave-ignored')
      latch = s.osHoverSeen
    }
    expect(latch).toBe(false)
  })

  it('renderer-owned reveal becomes main-owned once the OS cursor visits the bar, then leave parks', () => {
    const visit = overlayWatchStep({ cursor: { x: 900, y: 100 }, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: true, osHoverSeen: false })
    expect(visit).toEqual({ action: 'stay', osHoverSeen: true })
    const leave = overlayWatchStep({ cursor: AWAY, restRect: rest, revealedRect: ASK, islandResting: false, windowVisible: true, osHoverSeen: visit.osHoverSeen })
    expect(leave.action).toBe('park')
  })

  it('full loop: park -> hover -> bar -> leave -> park -> re-hover reveals again', () => {
    let latch = false
    let resting = true
    let bounds = PARK
    const run = (cursor: { x: number; y: number }): ReturnType<typeof overlayWatchStep> => {
      const s = overlayWatchStep({ cursor, restRect: rest, revealedRect: bounds, islandResting: resting, windowVisible: true, osHoverSeen: latch })
      latch = s.osHoverSeen
      if (s.action === 'restore') {
        resting = false
        bounds = ASK
      }
      return s
    }
    expect(run({ x: 900, y: 12 }).action).toBe('restore')
    expect(run({ x: 900, y: 12 }).action).toBe('stay')
    expect(run({ x: 900, y: 100 }).action).toBe('stay')
    expect(run(AWAY).action).toBe('park')
    // OVERLAY_LEAVE_PARK_MS timer fires in main: 8x2, resting.
    resting = true
    bounds = PARK
    expect(run(AWAY).action).toBe('stay')
    expect(run({ x: 24, y: 12 }).action).toBe('restore')
    expect(bounds).toEqual(ASK)
    expect(resting).toBe(false)
  })

  it('a Settings-tall ghost or Show Metis stub under the cursor restores instead of counting as the bar', () => {
    const ghost = { x: 460, y: 39, width: 880, height: 1017 }
    // Parked flag still true on a leftover slab: top-edge hover must reveal (heal fell through).
    const s = overlayWatchStep({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: ghost, islandResting: true, windowVisible: true, osHoverSeen: false })
    expect(s.action).toBe('restore')
    const stub = { x: 460, y: 39, width: 880, height: 44 }
    const t = overlayWatchStep({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: stub, islandResting: false, windowVisible: true, osHoverSeen: true, hugStub: true })
    expect(t.action).toBe('restore')
  })
})
