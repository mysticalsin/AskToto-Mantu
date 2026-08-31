/**
 * Island / Hide hover hit band — menu-bar / notch strip only.
 *
 * Tony live (Teams): mute, camera, and share sit under the Mac menu bar, not
 * in the Dynamic Island. A 80–120px pad into the window reveals Métis on those
 * clicks. That is a bug. These tests fail if the watch band is taller than the
 * strip or if a typical Teams-control Y hits.
 */
import { describe, expect, it } from 'vitest'
import { decideCursorWatch, pointInRect } from './cursor-watch'
import {
  HOVER_HIT_BAND_MAX_PX,
  TEAMS_MEETING_CHROME_Y,
  hoverHitBandHeight,
  hoverWatchRestRect,
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

/** Traditional Mac menu bar — no notch. Strip is ~24px, not 28+ pad. */
const TRADITIONAL_MAC: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 24, width: 1440, height: 876 },
  hasNotch: false,
  notchWidth: 0,
  menuBarHeight: 24,
  source: 'helper'
}

describe('hover hit band is the menu-bar / notch strip only', () => {
  it('height equals the strip and never an 80–120px pad', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      const strip = hoverHitBandHeight(TOTOS_MAC)
      expect(rest.y).toBe(TOTOS_MAC.bounds.y)
      expect(rest.height).toBe(strip)
      expect(rest.height).toBe(TOTOS_MAC.menuBarHeight)
      expect(rest.height).toBeLessThanOrEqual(HOVER_HIT_BAND_MAX_PX)
      expect(rest.height).toBeLessThan(80)
      expect(rest.height).toBeLessThan(120)
      expect(HOVER_HIT_BAND_MAX_PX).toBeLessThanOrEqual(44)
    }
  })

  it('traditional 24px menu bar is 24px tall — no leftover 28px floor', () => {
    const rest = hoverWatchRestRect('island', TRADITIONAL_MAC)
    expect(hoverHitBandHeight(TRADITIONAL_MAC)).toBe(24)
    expect(rest.height).toBe(24)
    expect(pointInRect({ x: 720, y: 12 }, rest)).toBe(true)
    expect(pointInRect({ x: 720, y: 23 }, rest)).toBe(true)
    expect(pointInRect({ x: 720, y: 24 }, rest)).toBe(false)
    expect(pointInRect({ x: 720, y: 26 }, rest)).toBe(false)
  })

  it('hardware island Y=12 reveals; Teams meeting chrome Y does not', () => {
    for (const layout of ['hide', 'island'] as const) {
      const rest = hoverWatchRestRect(layout, TOTOS_MAC)
      expect(TEAMS_MEETING_CHROME_Y).toBeGreaterThan(TOTOS_MAC.menuBarHeight)
      expect(pointInRect({ x: 900, y: 12 }, rest)).toBe(true)
      expect(pointInRect({ x: 900, y: TEAMS_MEETING_CHROME_Y }, rest)).toBe(false)
      expect(pointInRect({ x: 900, y: 56 }, rest)).toBe(false)
      expect(pointInRect({ x: 900, y: 80 }, rest)).toBe(false)
      expect(pointInRect({ x: 900, y: 120 }, rest)).toBe(false)
      expect(
        decideCursorWatch({
          cursor: { x: 900, y: 12 },
          restRect: rest,
          revealedRect: { x: 460, y: 39, width: 880, height: 84 },
          revealed: false
        })
      ).toBe('reveal')
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

  it('a leftover 120px hit pad must not reveal at Teams Y (clamp the watch band)', () => {
    const fat = { x: 620, y: 0, width: 560, height: 120 }
    expect(pointInRect({ x: 900, y: TEAMS_MEETING_CHROME_Y }, fat)).toBe(true)
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: TEAMS_MEETING_CHROME_Y },
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('stay')
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 80 },
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('stay')
    expect(
      decideCursorWatch({
        cursor: { x: 900, y: 12 },
        restRect: fat,
        revealedRect: { x: 460, y: 39, width: 880, height: 84 },
        revealed: false
      })
    ).toBe('reveal')
  })

  it('leaving the top band does not sticky-reveal from a mid-window hover', () => {
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
