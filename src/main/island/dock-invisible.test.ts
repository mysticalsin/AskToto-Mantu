import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from '@shared/ipc'
import { dockSliverRect, hideParkWindowOpacity, hoverWatchRestRect, type DisplayMetrics } from './geometry'

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
