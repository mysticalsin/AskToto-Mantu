import { describe, expect, it } from 'vitest'
import { hideParkWindowOpacity, rightEdgeSidecarBounds, settingsOpenRect, type DisplayMetrics, type Rect } from './geometry'
import {
  openOverlaySettingsSurface,
  revealOverlaySurface,
  skipUnchangedChrome,
  type OverlaySurfaceWindow
} from './overlay-surface'
import { OVERLAY_REST_BACKGROUND, SETTINGS_SURFACE_BACKGROUND } from '@shared/settings-bounds'

/**
 * M2-0431 — no hard cuts on reveal, park or Settings. A mock window records every native call in order: a
 * window raised to opacity 1 (or given the opaque Settings background) before its setBounds paints its old
 * frame, then jumps. `applyChrome` mirrors main's applyOverlaySurfaceChrome: Settings glass at opacity 1, or
 * the transparent rest at the Hide park opacity (0 parked, 1 revealed).
 */
const DISPLAY: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

const PARKED_HIDE: Rect = { x: 896, y: 0, width: 8, height: 2 }
const REVEALED_BAR: Rect = { x: 460, y: 39, width: 880, height: 120 }

interface MockState {
  bounds: Rect
  opacity: number
  background: string
  visible: boolean
}

function mockWindow(start: Partial<MockState> = {}): { w: OverlaySurfaceWindow; calls: string[]; state: MockState } {
  const calls: string[] = []
  const state: MockState = { bounds: PARKED_HIDE, opacity: 0, background: OVERLAY_REST_BACKGROUND, visible: true, ...start }
  const w: OverlaySurfaceWindow = {
    getBounds: () => ({ ...state.bounds }),
    setBounds: (next) => {
      calls.push('setBounds')
      state.bounds = { ...next }
    },
    isVisible: () => state.visible,
    showInactive: () => {
      calls.push('showInactive')
      state.visible = true
    },
    getOpacity: () => state.opacity,
    setOpacity: (value) => {
      calls.push(`setOpacity:${value}`)
      state.opacity = value
    },
    // Electron reports #RRGGBB without alpha.
    getBackgroundColor: () => state.background.slice(0, 7).toUpperCase(),
    setBackgroundColor: (color) => {
      calls.push(`setBackgroundColor:${color}`)
      state.background = color
    }
  }
  return { w, calls, state }
}

function chromeFor(w: OverlaySurfaceWindow, surface: { settingsOpen: boolean; parked: boolean }): () => void {
  return () => {
    const chrome = skipUnchangedChrome(w)
    if (surface.settingsOpen) {
      chrome.setBackgroundColor(SETTINGS_SURFACE_BACKGROUND)
      chrome.setOpacity(1)
      return
    }
    chrome.setBackgroundColor(OVERLAY_REST_BACKGROUND)
    chrome.setOpacity(hideParkWindowOpacity('hide', surface.parked))
  }
}

const REVEALED = { settingsOpen: false, parked: false }
const PARKED = { settingsOpen: false, parked: true }
const SETTINGS = { settingsOpen: true, parked: false }

const before = (calls: string[], first: string, second: string): void => {
  expect(calls).toContain(first)
  expect(calls).toContain(second)
  expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(second))
}

describe('M2-0431 reveal sets bounds before opacity 1 (no hard cut)', () => {
  it('a parked top-center Hide gets its revealed bounds before it becomes visible', () => {
    const { w, calls, state } = mockWindow()
    revealOverlaySurface(w, REVEALED_BAR, chromeFor(w, REVEALED))
    before(calls, 'setBounds', 'setOpacity:1')
    expect(state.bounds).toEqual(REVEALED_BAR)
    expect(state.opacity).toBe(1)
  })

  it('a tray-hidden window is resized before it is shown and before opacity 1', () => {
    const { w, calls } = mockWindow({ visible: false })
    revealOverlaySurface(w, REVEALED_BAR, chromeFor(w, REVEALED))
    before(calls, 'setBounds', 'showInactive')
    before(calls, 'showInactive', 'setOpacity:1')
  })

  it('a parked right-edge Hide band gets the drawer bounds before opacity 1', () => {
    const drawer = rightEdgeSidecarBounds(DISPLAY, { open: true })
    const { w, calls, state } = mockWindow({ bounds: { x: 1796, y: 263, width: 4, height: 560 } })
    revealOverlaySurface(w, drawer, chromeFor(w, REVEALED))
    before(calls, 'setBounds', 'setOpacity:1')
    expect(state.bounds).toEqual(drawer)
  })

  it('an already-revealed bar re-applies no bounds, background or opacity', () => {
    const { w, calls } = mockWindow({ bounds: REVEALED_BAR, opacity: 1 })
    revealOverlaySurface(w, REVEALED_BAR, chromeFor(w, REVEALED))
    expect(calls).toEqual([])
  })
})

describe('M2-0431 applyOverlaySurfaceChrome skips unchanged values', () => {
  it('re-applying the same chrome makes no native call', () => {
    const { w, calls } = mockWindow({ opacity: 0 })
    chromeFor(w, PARKED)()
    expect(calls).toEqual([])
  })

  it('a changed value is still applied once, then skipped', () => {
    const { w, calls } = mockWindow({ opacity: 1, background: SETTINGS_SURFACE_BACKGROUND })
    chromeFor(w, PARKED)()
    expect(calls).toEqual([`setBackgroundColor:${OVERLAY_REST_BACKGROUND}`, 'setOpacity:0'])
    chromeFor(w, PARKED)()
    expect(calls).toHaveLength(2)
  })

  it('a window whose background cannot be read still gets its chrome', () => {
    const { w, calls } = mockWindow()
    w.getBackgroundColor = () => {
      throw new Error('headless')
    }
    skipUnchangedChrome(w).setBackgroundColor(OVERLAY_REST_BACKGROUND)
    expect(calls).toEqual([`setBackgroundColor:${OVERLAY_REST_BACKGROUND}`])
  })
})

describe('M2-0431 Settings never shows an opaque slab before its resize', () => {
  it('opening Settings from a parked Hide resizes before the opaque background and opacity 1', () => {
    const rect = settingsOpenRect(DISPLAY, 8)
    const { w, calls, state } = mockWindow()
    openOverlaySettingsSurface(w, rect, chromeFor(w, SETTINGS))
    before(calls, 'setBounds', `setBackgroundColor:${SETTINGS_SURFACE_BACKGROUND}`)
    before(calls, 'setBounds', 'setOpacity:1')
    expect(state.bounds).toEqual(rect)
  })

  it('opening Settings from a revealed bar resizes before the opaque background', () => {
    const { w, calls } = mockWindow({ bounds: REVEALED_BAR, opacity: 1 })
    openOverlaySettingsSurface(w, settingsOpenRect(DISPLAY, 8), chromeFor(w, SETTINGS))
    before(calls, 'setBounds', `setBackgroundColor:${SETTINGS_SURFACE_BACKGROUND}`)
    expect(calls).not.toContain('setOpacity:1')
  })
})
