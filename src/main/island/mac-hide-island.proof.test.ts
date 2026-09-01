/**
 * Mac-test for why PR 58 was frozen: Hide idle after a display move must be 8×2
 * at bounds.y (Tony listwins), and Island hover at Y=12 must still reveal.
 * This is geometry + cursor-watch. Live Totos-Mac listwins is not this Linux host.
 */
import { describe, expect, it } from 'vitest'
import { decideCursorWatch, pointInRect } from './cursor-watch'
import {
  OVERLAY_HIDE_PARK,
  hideParkTop,
  hoverWatchRestRect,
  isLeftoverParkY,
  isVisibleHideSlab,
  parkedHoverReanchor,
  restoreParkAfterShow,
  type DisplayMetrics
} from './geometry'

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

describe('Mac-test Hide park leftover after Show (880×105 at Y=39)', () => {
  it('Hide park is 8×2 at bounds.y, never leftover Y=39', () => {
    const park = restoreParkAfterShow('hide', TOTOS_MAC, { width: 880, height: 105, y: 39 }, 8)
    expect(park.width).toBe(8)
    expect(park.height).toBe(2)
    expect(park.width).toBe(OVERLAY_HIDE_PARK.width)
    expect(park.height).toBe(OVERLAY_HIDE_PARK.height)
    expect(park.y).toBe(hideParkTop(TOTOS_MAC))
    expect(park.y).toBe(TOTOS_MAC.bounds.y)
    expect(park.y).toBe(0)
    expect(park.y).not.toBe(39)
    expect(isLeftoverParkY(39, TOTOS_MAC)).toBe(true)
    expect(isLeftoverParkY(park.y, TOTOS_MAC)).toBe(false)
    expect(isVisibleHideSlab(park)).toBe(false)
  })

  it('post-Show leftover 880×105 at Y=39 restores Hide 8×2; island hover hit is unchanged', () => {
    const leftover = { x: 460, y: 39, width: 880, height: 105 }
    const park = restoreParkAfterShow('hide', TOTOS_MAC, leftover, 8)
    expect(park).toEqual({
      x: park.x,
      y: 0,
      width: 8,
      height: 2
    })
    expect(park.width).not.toBe(880)
    expect(park.height).not.toBe(105)
    const rest = hoverWatchRestRect('hide', TOTOS_MAC)
    expect(rest.y).toBe(0)
    expect(pointInRect({ x: 900, y: 12 }, rest)).toBe(true)
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 12 },
        restRect: rest,
        revealedRect: leftover,
        revealed: false
      })
    ).toBe('reveal')
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
