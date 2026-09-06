/**
 * Mac-test for why PR 58 was frozen: Hide idle after a display move must be 8×2
 * at bounds.y (Tony listwins), and Island hover at Y=12 must still reveal.
 * This is geometry + cursor-watch. Live Totos-Mac listwins is not this Linux host.
 */
import { describe, expect, it } from 'vitest'
import { OVERLAY_LEAVE_PARK_MS, decideCursorWatch, overlayWatchStep, pointInRect } from './cursor-watch'
import {
  MANTU_BRAND_PURPLE,
  OVERLAY_HIDE_PARK,
  OVERLAY_TRANSPARENT_BACKGROUND,
  TEAMS_MEETING_CHROME_Y,
  ULTRON_PURPLE_HAIRLINE,
  hideParkIsVisuallyClear,
  hideParkRect,
  hideParkWindowOpacity,
  hoverWatchRestRect,
  isForbiddenHideParkHairline,
  isLeftoverSettingsTrigger,
  isOpaqueMantuPurple,
  isVisibleHideSlab,
  parkedHoverReanchor,
  parkAfterExclusiveOnboarding,
  type DisplayMetrics
} from './geometry'
import { TONY_LIVE_SETTINGS_CRUSH, isFatHoverTrigger } from '@shared/settings-bounds'

/** Tony built-in Retina (notch). workArea.y ≈ 39. */
const TOTOS_MAC: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

/** Second display after a move. Same notch inset. */
const SECOND: DisplayMetrics = {
  bounds: { x: 1800, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1800, y: 39, width: 1920, height: 1041 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

describe('Mac-test Hide 8×2 after a display move', () => {
  it('listwins-shaped hide park is W=8 H=2 at Y=bounds.y, never 8×44 at Y=39', () => {
    const park = parkedHoverReanchor('hide', true, SECOND, 8)
    expect(park).not.toBeNull()
    expect(park!.width).toBe(OVERLAY_HIDE_PARK.width)
    expect(park!.height).toBe(OVERLAY_HIDE_PARK.height)
    expect(park!.height).toBeLessThanOrEqual(8)
    expect(park!.width).toBe(8)
    expect(park!.y).toBe(SECOND.bounds.y)
    expect(park!.y).not.toBe(SECOND.workArea.y)
    expect(park!.y).not.toBe(39)
    expect(isVisibleHideSlab(park!)).toBe(false)
  })

  it('bar layout does not steal the hide re-park path', () => {
    expect(parkedHoverReanchor('bar', true, SECOND, 8)).toBeNull()
  })
})

describe('Mac-test Island hover', () => {
  it('pointer in the hardware island (Y=12) reveals hide and island on Totos-Mac metrics', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(rest.y).toBe(0)
      expect(pointInRect({ x: 900, y: 12 }, rest)).toBe(true)
      expect(
        decideCursorWatch({
          cursor: { x: 900, y: 12 },
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('reveal')
      expect(pointInRect({ x: 900, y: TEAMS_MEETING_CHROME_Y }, rest)).toBe(false)
      expect(
        decideCursorWatch({
          cursor: { x: 900, y: TEAMS_MEETING_CHROME_Y },
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('stay')
    }
  })

  it('after a display move, island hover at Y=12 still reveals and does not flatten to workArea.y', () => {
    const island = parkedHoverReanchor('island', true, SECOND, 8)
    expect(island).not.toBeNull()
    expect(island!.y).toBe(SECOND.bounds.y)
    expect(island!.height).toBeLessThan(44)
    const rest = hoverWatchRestRect('island', SECOND)
    expect(rest.y).toBe(SECOND.bounds.y)
    expect(
      decideCursorWatch({
        cursor: { x: 1800 + 960, y: 12 },
        restRect: rest,
        revealedRect: { x: 1800 + 520, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('reveal')
  })
})

describe('Mac-test Hide hover reveal + leave park (Ultron top-edge re-check)', () => {
  const rest = hoverWatchRestRect('hide', TOTOS_MAC)
  const park = parkAfterExclusiveOnboarding('hide', TOTOS_MAC, 8)
  const ask = { x: 460, y: 39, width: 880, height: 120 }

  it('listwins 8x2@(896,0): cursor at the camera strip reveals; revealed bar sits in the work area', () => {
    expect(park).toEqual({ x: 896, y: 0, width: 8, height: 2 })
    const s = overlayWatchStep({ cursor: { x: 900, y: 12 }, restRect: rest, revealedRect: park, islandResting: true, windowVisible: true, osHoverSeen: false })
    expect(s).toEqual({ action: 'restore', osHoverSeen: true })
    expect(ask.y).toBe(TOTOS_MAC.workArea.y)
    expect(ask.x).toBeGreaterThanOrEqual(TOTOS_MAC.workArea.x)
    expect(ask.x + ask.width).toBeLessThanOrEqual(TOTOS_MAC.workArea.x + TOTOS_MAC.workArea.width)
  })

  it('mouse away to (900,600) parks within OVERLAY_LEAVE_PARK_MS and the park is the 8x2 hairline', () => {
    const s = overlayWatchStep({ cursor: { x: 900, y: 600 }, restRect: rest, revealedRect: ask, islandResting: false, windowVisible: true, osHoverSeen: true })
    expect(s).toEqual({ action: 'park', osHoverSeen: false })
    expect(OVERLAY_LEAVE_PARK_MS).toBeLessThanOrEqual(2000)
    expect(isVisibleHideSlab(park)).toBe(false)
  })

  it('a reveal main never hovered (forced toast / synthetic pointer) is left to the renderer', () => {
    const s = overlayWatchStep({ cursor: { x: 900, y: 600 }, restRect: rest, revealedRect: ask, islandResting: false, windowVisible: true, osHoverSeen: false })
    expect(s.action).toBe('leave-ignored')
  })
})

describe('Ultron live — 8×2 at y=39 with opaque purple is FAIL', () => {
  it('CGWindowList 8×2@(896,39) painting #3A0B6B is the hairline FAIL', () => {
    expect(ULTRON_PURPLE_HAIRLINE).toEqual({
      width: 8,
      height: 2,
      y: 39,
      background: MANTU_BRAND_PURPLE,
      opacity: 1
    })
    expect(isOpaqueMantuPurple(ULTRON_PURPLE_HAIRLINE.background)).toBe(true)
    expect(
      isForbiddenHideParkHairline({
        ...ULTRON_PURPLE_HAIRLINE,
        workAreaY: TOTOS_MAC.workArea.y,
        boundsY: TOTOS_MAC.bounds.y
      })
    ).toBe(true)
    expect(
      hideParkIsVisuallyClear({
        y: 39,
        boundsY: 0,
        width: 8,
        height: 2,
        background: '#3A0B6B',
        opacity: 1
      })
    ).toBe(false)
  })

  it('transparent + bounds.y, opacity 0, or off-screen rest pass; hover watch still reveals', () => {
    const park = hideParkRect(TOTOS_MAC)
    expect(park).toEqual({ x: 896, y: 0, width: 8, height: 2 })
    expect(park.y).toBe(TOTOS_MAC.bounds.y)
    expect(park.y).not.toBe(39)
    expect(hideParkWindowOpacity('hide', true)).toBe(0)
    expect(hideParkWindowOpacity('hide', false)).toBe(1)
    expect(hideParkWindowOpacity('island', true)).toBe(1)
    expect(hideParkWindowOpacity('bar', true)).toBe(1)
    expect(
      isForbiddenHideParkHairline({
        ...park,
        workAreaY: TOTOS_MAC.workArea.y,
        boundsY: TOTOS_MAC.bounds.y,
        background: OVERLAY_TRANSPARENT_BACKGROUND,
        opacity: 1
      })
    ).toBe(false)
    expect(
      isForbiddenHideParkHairline({
        width: 8,
        height: 2,
        y: 39,
        workAreaY: 39,
        boundsY: 0,
        background: '#3A0B6B',
        opacity: 0
      })
    ).toBe(false)
    expect(hideParkIsVisuallyClear({ y: 39, boundsY: 0, opacity: 0 })).toBe(true)
    expect(hideParkIsVisuallyClear({ y: -2, boundsY: 0, height: 2, opacity: 1 })).toBe(true)
    const rest = hoverWatchRestRect('hide', TOTOS_MAC)
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 12 },
        restRect: rest,
        revealedRect: park,
        revealed: false
      })
    ).toBe('reveal')
  })
})

describe('MQA-289 — leftover 880×133 at Y=39 is a fat trigger; park stays Y=0', () => {
  it('Hide/Island park at bounds.y after Settings; 880×133 at Y=39 must not remain', () => {
    const leftover = { width: 880, height: 133, y: 39 }
    expect(isFatHoverTrigger(leftover, TOTOS_MAC.workArea.y)).toBe(true)
    expect(isLeftoverSettingsTrigger(leftover, TOTOS_MAC)).toBe(true)
    expect(isFatHoverTrigger({ width: 880, height: 325, y: 39 }, TOTOS_MAC.workArea.y)).toBe(true)
    expect(isFatHoverTrigger(TONY_LIVE_SETTINGS_CRUSH, TOTOS_MAC.workArea.y)).toBe(true)
    const hide = parkAfterExclusiveOnboarding('hide', TOTOS_MAC, 8)
    expect(hide.y).toBe(0)
    expect(hide.y).not.toBe(39)
    expect(hide.width).toBe(8)
    expect(hide.height).toBe(2)
    expect(isFatHoverTrigger(hide, TOTOS_MAC.workArea.y)).toBe(false)
    const island = parkAfterExclusiveOnboarding('island', TOTOS_MAC, 8)
    expect(island.y).toBe(0)
    expect(island.width).toBeLessThan(200)
    const rest = hoverWatchRestRect('hide', TOTOS_MAC)
    expect(rest.y).toBe(0)
    expect(rest.width).toBe(TOTOS_MAC.workArea.width)
    expect(rest.height).toBe(TOTOS_MAC.workArea.y - TOTOS_MAC.bounds.y + 1)
    expect(rest.height).toBeLessThan(44)
    expect(pointInRect({ x: 40, y: TOTOS_MAC.workArea.y }, rest)).toBe(true)
    expect(pointInRect({ x: 40, y: 12 }, rest)).toBe(true)
  })
})
