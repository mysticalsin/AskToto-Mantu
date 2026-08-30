import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY_LAYOUT,
  OVERLAY_LAYOUTS,
  autoHideOverlayForLayout,
  migrateOverlayLayout,
  overlayRestsHidden,
  overlayUsesHover,
  overlayUsesSafeTop,
  parseOverlayLayout
} from './overlay-chrome'

describe('overlay chrome modes', () => {
  it('default is hide (fresh install, no reinstall required to change later)', () => {
    expect(DEFAULT_OVERLAY_LAYOUT).toBe('hide')
    expect(OVERLAY_LAYOUTS).toEqual(['hide', 'island', 'bar'])
    expect(parseOverlayLayout(undefined)).toBe('hide')
    expect(parseOverlayLayout('nope')).toBe('hide')
    expect(overlayRestsHidden('hide')).toBe(true)
    expect(overlayRestsHidden('island')).toBe(false)
    expect(overlayUsesHover('hide')).toBe(true)
    expect(overlayUsesHover('island')).toBe(true)
    expect(overlayUsesHover('bar')).toBe(false)
    expect(autoHideOverlayForLayout('bar')).toBe(false)
  })

  it('Settings can switch to island and bar without a reinstall (migrate keeps a saved layout)', () => {
    expect(migrateOverlayLayout({ overlayLayout: 'island' })).toBe('island')
    expect(migrateOverlayLayout({ overlayLayout: 'bar' })).toBe('bar')
    expect(migrateOverlayLayout({ overlayLayout: 'hide' })).toBe('hide')
  })

  it('legacy autoHideOverlay maps to island or bar; an empty profile stays on the hide default', () => {
    expect(migrateOverlayLayout({})).toBeUndefined()
    expect(migrateOverlayLayout({ autoHideOverlay: true })).toBe('island')
    expect(migrateOverlayLayout({ autoHideOverlay: false })).toBe('bar')
  })

  it('hide and island use the safe top; bar does not', () => {
    expect(overlayUsesSafeTop('hide')).toBe(true)
    expect(overlayUsesSafeTop('island')).toBe(true)
    expect(overlayUsesSafeTop('bar')).toBe(false)
  })
})
