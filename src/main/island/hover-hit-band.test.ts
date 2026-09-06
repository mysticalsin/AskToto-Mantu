/**
 * Hide / Island hover hit — full top-edge approach strip.
 *
 * Tony live 2026-09-05: mouse at the top of the screen did not show Métis.
 * Only tray Show/Hide worked. Reveal must hit the top edge (left, camera, right)
 * without hunting the menu Show item. Teams mute at Y≈40 still misses.
 */
import { describe, expect, it } from 'vitest'
import { decideCursorWatch, pointInRect } from './cursor-watch'
import {
  HOVER_ISLAND_HEIGHT_MAX_PX,
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

const LEFT_TOP = { x: 24, y: 12 }
const NOTCH_CENTER = { x: 900, y: 12 }
const RIGHT_TOP = { x: 1770, y: 8 }

describe('hover hit is the full top-edge approach strip', () => {
  it('watch rect is work-area-wide and covers the menu bar plus first work-area row', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(hoverRestWidth(TOTOS_MAC)).toBe(TOTOS_MAC.workArea.width)
      expect(rest.width).toBe(TOTOS_MAC.workArea.width)
      expect(rest.x).toBe(TOTOS_MAC.workArea.x)
      expect(rest.width).toBeGreaterThan(OVERLAY_HIDE_TARGET.width)
      expect(rest.height).toBe(hoverHitBandHeight(TOTOS_MAC))
      expect(rest.height).toBe(TOTOS_MAC.workArea.y - TOTOS_MAC.bounds.y + 1)
      expect(rest.height).toBeLessThanOrEqual(HOVER_ISLAND_HEIGHT_MAX_PX)
      expect(rest.height).toBeLessThan(44)
      expect(HOVER_ISLAND_HEIGHT_MAX_PX).toBe(TEAMS_UNDER_ISLAND_Y)
      expect(HOVER_ISLAND_HEIGHT_MAX_PX).toBeLessThan(44)
      expect(rest.y).toBe(TOTOS_MAC.bounds.y)
    }
  })

  it('top edge left / camera / right reveals hide and island', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      for (const cursor of [LEFT_TOP, NOTCH_CENTER, RIGHT_TOP, { x: 900, y: 0 }]) {
        expect(pointInRect(cursor, rest)).toBe(true)
        expect(
          decideCursorWatch({
            cursor,
            restRect: rest,
            revealedRect: { x: 460, y: 39, width: 880, height: 84 },
            revealed: false
          })
        ).toBe('reveal')
      }
    }
  })

  it('approach from below at workArea.y 39 reveals — the 32px housing cap was a dead zone', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      for (const y of [32, 37, 38, TOTOS_MAC.workArea.y]) {
        expect(pointInRect({ x: 24, y }, rest)).toBe(true)
        expect(
          decideCursorWatch({
            cursor: { x: 24, y },
            restRect: rest,
            revealedRect: { x: 460, y: 39, width: 880, height: 84 },
            revealed: false
          })
        ).toBe('reveal')
      }
    }
  })

  it('helper-miss (hasNotch false) still uses the Electron workArea inset', () => {
    const noHelper: DisplayMetrics = { ...TOTOS_MAC, hasNotch: false, notchWidth: 0, source: 'heuristic' }
    const rest = hoverWatchRestRect('hide', noHelper)
    expect(pointInRect({ x: 24, y: TOTOS_MAC.workArea.y }, rest)).toBe(true)
    expect(pointInRect({ x: 24, y: TEAMS_UNDER_ISLAND_Y }, rest)).toBe(false)
  })

  it('center X at TEAMS_MEETING_CHROME_Y 48 misses', () => {
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

  it('center X at Y=40 under the island (typical Teams) misses', () => {
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

  it('a leftover 560×44 slab is height-clamped so Teams mute still misses', () => {
    const fat = { x: 0, y: 0, width: TOTOS_MAC.bounds.width, height: 44 }
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
        cursor: LEFT_TOP,
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('reveal')
  })

  it('leaving the top edge does not sticky-reveal from a mid-window hover', () => {
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
