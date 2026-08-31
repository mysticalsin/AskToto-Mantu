/**
 * Island / Hide hover hit — hardware camera / Dynamic Island square only.
 *
 * Tony live (Teams): mute lives in the menu bar under the camera housing.
 * A 560×~37 top slab still reveals Métis. Reveal only on the black camera
 * pill: top-center, notchWidth × housing height. These tests fail if the
 * watch rect is 560-wide or 44-tall.
 */
import { describe, expect, it } from 'vitest'
import { decideCursorWatch, pointInRect } from './cursor-watch'
import {
  HOVER_ISLAND_HEIGHT_MAX_PX,
  HOVER_ISLAND_WIDTH_MAX_PX,
  OVERLAY_HIDE_TARGET,
  TEAMS_MEETING_CHROME_Y,
  TEAMS_UNDER_ISLAND_Y,
  hoverHitBandHeight,
  hoverRestWidth,
  hoverWatchRestRect,
  type DisplayMetrics
} from './geometry'

/** Tony built-in Retina (notch). workArea.y ≈ 39. notchWidth 200. */
const TOTOS_MAC: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

const LEFT_MENU_BAR = { x: 24, y: 12 }
const NOTCH_CENTER = { x: 900, y: 12 }

describe('hover hit is the camera / Dynamic Island square only', () => {
  it('watch rect is notch-wide and housing-tall — never 560×44', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(hoverRestWidth(TOTOS_MAC)).toBe(TOTOS_MAC.notchWidth)
      expect(rest.width).toBe(TOTOS_MAC.notchWidth)
      expect(rest.width).toBeLessThanOrEqual(HOVER_ISLAND_WIDTH_MAX_PX)
      expect(rest.width).toBeLessThan(OVERLAY_HIDE_TARGET.width)
      expect(rest.width).not.toBe(560)
      expect(rest.height).toBe(hoverHitBandHeight(TOTOS_MAC))
      expect(rest.height).toBeLessThanOrEqual(HOVER_ISLAND_HEIGHT_MAX_PX)
      expect(rest.height).toBeLessThan(44)
      expect(rest.height).toBeLessThan(TOTOS_MAC.menuBarHeight)
      expect(HOVER_ISLAND_HEIGHT_MAX_PX).toBeLessThan(44)
      expect(HOVER_ISLAND_WIDTH_MAX_PX).toBeLessThanOrEqual(250)
      expect(rest.y).toBe(TOTOS_MAC.bounds.y)
    }
  })

  it('(a) notch center Y≈8–12 reveals hide and island', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(pointInRect({ x: NOTCH_CENTER.x, y: 8 }, rest)).toBe(true)
      expect(pointInRect(NOTCH_CENTER, rest)).toBe(true)
      expect(
        decideCursorWatch({
          cursor: NOTCH_CENTER,
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('reveal')
    }
  })

  it('(b) same Y in the left menu-bar misses', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(pointInRect(LEFT_MENU_BAR, rest)).toBe(false)
      expect(
        decideCursorWatch({
          cursor: LEFT_MENU_BAR,
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('stay')
    }
  })

  it('(c) center X at TEAMS_MEETING_CHROME_Y 48 misses', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(TEAMS_MEETING_CHROME_Y).toBe(48)
      expect(pointInRect({ x: NOTCH_CENTER.x, y: TEAMS_MEETING_CHROME_Y }, rest)).toBe(false)
      expect(
        decideCursorWatch({
          cursor: { x: NOTCH_CENTER.x, y: TEAMS_MEETING_CHROME_Y },
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('stay')
    }
  })

  it('(d) center X at Y=40 under the island (typical Teams) misses', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(TEAMS_UNDER_ISLAND_Y).toBe(40)
      expect(pointInRect({ x: NOTCH_CENTER.x, y: TEAMS_UNDER_ISLAND_Y }, rest)).toBe(false)
      expect(
        decideCursorWatch({
          cursor: { x: NOTCH_CENTER.x, y: TEAMS_UNDER_ISLAND_Y },
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('stay')
    }
  })

  it('a leftover 560×44 slab is clamped to the camera island so menu-bar and Teams miss', () => {
    const fat = { x: 620, y: 0, width: 560, height: 44 }
    expect(pointInRect(LEFT_MENU_BAR, fat)).toBe(true)
    expect(pointInRect({ x: NOTCH_CENTER.x, y: TEAMS_UNDER_ISLAND_Y }, fat)).toBe(true)
    expect(
      decideCursorWatch({
        cursor: LEFT_MENU_BAR,
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('stay')
    expect(
      decideCursorWatch({
        cursor: { x: NOTCH_CENTER.x, y: TEAMS_UNDER_ISLAND_Y },
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('stay')
    expect(
      decideCursorWatch({
        cursor: NOTCH_CENTER,
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('reveal')
  })

  it('leaving the island does not sticky-reveal from a mid-window hover', () => {
    const rest = hoverWatchRestRect('island', TOTOS_MAC)
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 200 },
        restRect: rest,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('stay')
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 200 },
        restRect: rest,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: true
      })
    ).toBe('hide')
  })
})
