import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from '@shared/ipc'
import {
  OVERLAY_DOCK_PANEL,
  dockPanelRectAnchoredTo,
  dockSliverRect,
  hideParkWindowOpacity,
  hoverWatchRestRect,
  rightEdgePosition,
  type DisplayMetrics
} from './geometry'

/**
 * dock-invisible.test.ts
 *
 * The dock can rest invisibly, the same bargain Hide makes at the top edge: nothing on screen until the
 * pointer reaches the edge. The whole risk in that feature is one mistake — letting "cannot be seen"
 * quietly become "cannot be reached". Hide already has a documented history of exactly that class of
 * regression (a park that swallowed its own hover band), so the reachability half is pinned here
 * separately from the paint half.
 */
const TOTOS_MAC: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

describe('an invisible dock is a PAINT choice, never a reachability one', () => {
  it('paints nothing while resting', () => {
    expect(hideParkWindowOpacity('dock', true, 'hidden')).toBe(0)
  })

  it('still paints when it is NOT resting, so a revealed dock is never invisible', () => {
    // The panel you just opened must be visible even in hidden mode, or the feature is a disappearing app.
    expect(hideParkWindowOpacity('dock', false, 'hidden')).toBe(1)
  })

  it('keeps the default visible sliver untouched', () => {
    expect(hideParkWindowOpacity('dock', true, 'sliver')).toBe(1)
    expect(hideParkWindowOpacity('dock', true)).toBe(1)
  })

  it('changes nothing for any other chrome', () => {
    expect(hideParkWindowOpacity('hide', true, 'sliver')).toBe(0)
    expect(hideParkWindowOpacity('island', true, 'hidden')).toBe(1)
    expect(hideParkWindowOpacity('bar', true, 'hidden')).toBe(1)
  })

  it('the hover band and the parked window are IDENTICAL in both modes', () => {
    // This is the contract. Opacity is the only difference; the sensor and the geometry do not move,
    // so an invisible dock is exactly as reachable as a visible one.
    const band = hoverWatchRestRect('dock', TOTOS_MAC, 'right-edge')
    const park = dockSliverRect(TOTOS_MAC)
    expect(band).toEqual(park)
    expect(band.width).toBeGreaterThan(0)
    expect(band.height).toBeGreaterThan(0)
  })
})

describe('opening the dock must not move the pill that was already there', () => {
  it('keeps the sliver centre exactly, wherever the panel can be centred on it', () => {
    // A sliver in the middle of the work area: the panel fits either side of it, so the centres match
    // and the pill does not move at all.
    const rest = { ...dockSliverRect(TOTOS_MAC), y: 350 }
    const panel = dockPanelRectAnchoredTo(rest, TOTOS_MAC)
    expect(Math.abs((panel.y + panel.height / 2) - (rest.y + rest.height / 2))).toBeLessThanOrEqual(1)
  })

  it('near an edge it gets as close as the screen allows, rather than hanging off it', () => {
    // The DEFAULT sliver sits high (normalized 0.2), so a 560 panel centred on it would run off the
    // top. Staying on screen wins, and the residual offset is small enough to read as growth.
    const rest = dockSliverRect(TOTOS_MAC)
    const panel = dockPanelRectAnchoredTo(rest, TOTOS_MAC)
    const drift = Math.abs((panel.y + panel.height / 2) - (rest.y + rest.height / 2))
    expect(drift).toBeLessThan(60)
    expect(panel.y).toBeGreaterThanOrEqual(TOTOS_MAC.workArea.y)
  })

  it('the OLD behaviour really did move it, which is why this exists', () => {
    // Same normalized Y through a height-dependent range: a 108 sliver and a 560 panel do not share a
    // centre, and the gap is large enough to read as a jump rather than a growth.
    const rest = dockSliverRect(TOTOS_MAC)
    const naive = rightEdgePosition(OVERLAY_DOCK_PANEL.width, OVERLAY_DOCK_PANEL.height, TOTOS_MAC)
    const naiveCentre = naive.y + OVERLAY_DOCK_PANEL.height / 2
    const restCentre = rest.y + rest.height / 2
    expect(Math.abs(naiveCentre - restCentre)).toBeGreaterThan(40)
  })

  it('a sliver near the top edge still yields a panel fully on screen', () => {
    const high = { ...dockSliverRect(TOTOS_MAC), y: TOTOS_MAC.workArea.y }
    const panel = dockPanelRectAnchoredTo(high, TOTOS_MAC)
    expect(panel.y).toBeGreaterThanOrEqual(TOTOS_MAC.workArea.y)
    expect(panel.y + panel.height).toBeLessThanOrEqual(TOTOS_MAC.workArea.y + TOTOS_MAC.workArea.height)
  })

  it('and a sliver near the bottom edge does too', () => {
    const low = {
      ...dockSliverRect(TOTOS_MAC),
      y: TOTOS_MAC.workArea.y + TOTOS_MAC.workArea.height - 108
    }
    const panel = dockPanelRectAnchoredTo(low, TOTOS_MAC)
    expect(panel.y).toBeGreaterThanOrEqual(TOTOS_MAC.workArea.y)
    expect(panel.y + panel.height).toBeLessThanOrEqual(TOTOS_MAC.workArea.y + TOTOS_MAC.workArea.height)
  })
})

describe('the setting itself', () => {
  it('defaults to the visible sliver, so nobody loses their dock by upgrading', () => {
    expect(DEFAULT_SETTINGS.dockRest).toBe('sliver')
    expect(BaseSettingsSchema.shape.dockRest.parse(undefined)).toBe('sliver')
  })

  it('heals an unknown value rather than throwing a profile away', () => {
    expect(BaseSettingsSchema.shape.dockRest.safeParse('nonsense').success).toBe(false)
    expect(BaseSettingsSchema.shape.dockRest.parse('hidden')).toBe('hidden')
  })
})

describe('the renderer half keeps the pointer affordance', () => {
  const peek = readFileSync(
    join(__dirname, '..', '..', 'renderer', 'src', 'components', 'OverlayPeek.tsx'),
    'utf8'
  )

  it('a hidden dock stays mounted and still reveals on click and focus', () => {
    expect(peek).toMatch(/const dockHidden = rest === 'dock-hidden'/)
    // Only Hide drops the pointer-enter affordance; the dock's own window is what the pointer lands on.
    expect(peek).toMatch(/onPointerEnter=\{rest === 'hide' \? undefined : onReveal\}/)
    expect(peek).toMatch(/onClick=\{onReveal\}/)
    expect(peek).toMatch(/onFocus=\{onReveal\}/)
  })

  it('it paints nothing but keeps its box, so the hit area survives', () => {
    expect(peek).toMatch(/overlay-dock-peek--invisible/)
    const css = readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'styles.css'), 'utf8')
    const rule = css.slice(css.indexOf('.overlay-dock-peek--invisible {'))
    expect(rule).toMatch(/background: transparent/)
    // display:none or visibility:hidden would remove the hit area along with the paint.
    expect(rule.slice(0, 260)).not.toMatch(/display:\s*none/)
    expect(rule.slice(0, 260)).not.toMatch(/visibility:\s*hidden/)
  })
})
