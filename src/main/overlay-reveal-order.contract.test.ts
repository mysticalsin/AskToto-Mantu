import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  EXCLUSIVE_ONBOARDING_BACKGROUND,
  hideParkWindowOpacity,
  recenterXForWidth,
  rightEdgeSidecarBounds,
  settingsOpenRect,
  topClamp,
  type DisplayMetrics,
  type Rect
} from './island/geometry'
import {
  ASK_REVEAL_MIN_HEIGHT_PX,
  BAR_IDLE_HEIGHT_PX,
  askRevealHeight,
  isSettingsTallHeight,
  overlayUsesHover,
  rememberBarContentHeight
} from '@shared/overlay-chrome'
import { OVERLAY_REST_BACKGROUND, SETTINGS_SURFACE_BACKGROUND, SETTINGS_WINDOW_MIN } from '@shared/settings-bounds'

/**
 * M2-0431 — no hard cuts on reveal, park or Settings. Runs the shipped restoreBarWidth,
 * applyOverlaySurfaceChrome and applySettingsSurface over a mock window that records every native call in
 * order, so the ordering is asserted on real behaviour: a window raised to opacity 1 (or given the opaque
 * Settings background) before its setBounds paints its old frame, then jumps.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

const constant = (name: string): number => {
  const m = new RegExp(`^const ${name} = (\\d+)`, 'm').exec(indexSrc)
  expect(m, `constant not found: ${name}`).not.toBeNull()
  return Number(m?.[1])
}

const DISPLAY: DisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper'
}

const PARKED_HIDE: Rect = { x: 896, y: 0, width: 8, height: 2 }

interface MockState {
  bounds: Rect
  opacity: number
  background: string
  visible: boolean
}

interface Overlay {
  calls: string[]
  state: MockState
  restoreBarWidth: () => void
  applyOverlaySurfaceChrome: () => void
  applySettingsSurface: () => void
}

async function overlay(input: {
  start: Partial<MockState>
  islandResting: boolean
  placement?: 'top-center' | 'right-edge'
}): Promise<Overlay> {
  const region = await transformWithEsbuild(
    [
      sliceBetween('function windowBackgroundIs(', '/** Hide/island park at bounds.y'),
      sliceBetween('function restoreBarWidth(): void {', 'function repairOverlayBoundsForReveal'),
      sliceBetween('function applySettingsSurface(): void {', 'function leaveSettingsSurface')
    ].join('\n'),
    'lifted.ts',
    { loader: 'ts' }
  )
  const calls: string[] = []
  const state: MockState = {
    bounds: PARKED_HIDE,
    opacity: 0,
    background: OVERLAY_REST_BACKGROUND,
    visible: true,
    ...input.start
  }
  const win = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    showInactive: () => {
      calls.push('showInactive')
      state.visible = true
    },
    setAlwaysOnTop: () => calls.push('setAlwaysOnTop'),
    setMinimumSize: () => calls.push('setMinimumSize'),
    getBounds: () => ({ ...state.bounds }),
    setBounds: (next: Rect) => {
      calls.push('setBounds')
      state.bounds = { ...next }
    },
    getOpacity: () => state.opacity,
    setOpacity: (value: number) => {
      calls.push(`setOpacity:${value}`)
      state.opacity = value
    },
    // Electron reports #RRGGBB without alpha.
    getBackgroundColor: () => state.background.slice(0, 7).toUpperCase(),
    setBackgroundColor: (color: string) => {
      calls.push(`setBackgroundColor:${color}`)
      state.background = color
    }
  }
  const stubs = {
    win,
    screen: { getDisplayMatching: () => DISPLAY },
    getDisplayMetrics: (display: DisplayMetrics) => display,
    onboardingExclusiveLive: () => false,
    cancelOverlayLeavePark: () => {},
    applyHideClickThrough: () => {},
    liveOverlayLayout: () => 'hide',
    resolvedOverlayPlacementForDisplay: () => input.placement ?? 'top-center',
    parkLayoutForDisplay: (layout: string) => layout,
    rightEdgeYForDisplay: () => undefined,
    rightEdgeSidecarBounds,
    overlayUsesHover,
    askRevealHeight,
    rememberBarContentHeight,
    isSettingsTallHeight,
    topClamp,
    recenterXForWidth,
    hideParkWindowOpacity,
    settingsOpenRect,
    ASK_REVEAL_MIN_HEIGHT_PX,
    BAR_IDLE_HEIGHT_PX,
    SETTINGS_WINDOW_MIN,
    EXCLUSIVE_ONBOARDING_BACKGROUND,
    SETTINGS_SURFACE_BACKGROUND,
    OVERLAY_REST_BACKGROUND,
    BAR_WIDTH: constant('BAR_WIDTH'),
    BAR_HEIGHT: constant('BAR_HEIGHT'),
    ISLAND_TOP_MARGIN: 8
  }
  const run = new Function(
    ...Object.keys(stubs),
    `
    let islandResting = ${input.islandResting};
    let settingsSurfaceOpen = false;
    let isMinimized = false;
    let overlayParkLatched = false;
    let currentWidth = ${input.islandResting ? PARKED_HIDE.width : constant('BAR_WIDTH')};
    let lastBarHeight = 120;
    ${region.code}
    return { restoreBarWidth, applyOverlaySurfaceChrome, applySettingsSurface };
  `
  ) as (...args: unknown[]) => Pick<Overlay, 'restoreBarWidth' | 'applyOverlaySurfaceChrome' | 'applySettingsSurface'>
  return { calls, state, ...run(...Object.values(stubs)) }
}

const before = (calls: string[], first: string, second: string): void => {
  expect(calls).toContain(first)
  expect(calls).toContain(second)
  expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(second))
}

describe('M2-0431 reveal sets bounds before opacity 1 (no hard cut)', () => {
  it('a parked top-center Hide gets its revealed bounds before it becomes visible', async () => {
    const o = await overlay({ start: {}, islandResting: true })
    o.restoreBarWidth()
    before(o.calls, 'setBounds', 'setOpacity:1')
    expect(o.state.bounds).toEqual({ x: 460, y: 39, width: 880, height: 120 })
    expect(o.state.opacity).toBe(1)
  })

  it('a tray-hidden window is resized before it is shown and before opacity 1', async () => {
    const o = await overlay({ start: { visible: false }, islandResting: true })
    o.restoreBarWidth()
    before(o.calls, 'setBounds', 'showInactive')
    before(o.calls, 'showInactive', 'setOpacity:1')
  })

  it('a parked right-edge Hide band gets the drawer bounds before opacity 1', async () => {
    const band = { x: 1796, y: 263, width: 4, height: 560 }
    const o = await overlay({ start: { bounds: band }, islandResting: true, placement: 'right-edge' })
    o.restoreBarWidth()
    before(o.calls, 'setBounds', 'setOpacity:1')
    expect(o.state.bounds).toEqual(rightEdgeSidecarBounds(DISPLAY, { open: true }))
  })

  it('an already-revealed bar re-applies no bounds, background or opacity', async () => {
    const o = await overlay({
      start: { bounds: { x: 460, y: 39, width: 880, height: 120 }, opacity: 1 },
      islandResting: false
    })
    o.restoreBarWidth()
    expect(o.calls).toEqual(['setAlwaysOnTop'])
  })
})

describe('M2-0431 applyOverlaySurfaceChrome skips unchanged values', () => {
  it('re-applying the same chrome makes no native call', async () => {
    const o = await overlay({ start: { opacity: 0 }, islandResting: true })
    o.applyOverlaySurfaceChrome()
    expect(o.calls).toEqual([])
  })

  it('a changed value is still applied once, then skipped', async () => {
    const o = await overlay({ start: { opacity: 1, background: '#120022' }, islandResting: true })
    o.applyOverlaySurfaceChrome()
    expect(o.calls).toEqual([`setBackgroundColor:${OVERLAY_REST_BACKGROUND}`, 'setOpacity:0'])
    o.applyOverlaySurfaceChrome()
    expect(o.calls).toHaveLength(2)
  })
})

describe('M2-0431 Settings never shows an opaque slab before its resize', () => {
  it('opening Settings from a parked Hide resizes before the opaque background and opacity 1', async () => {
    const o = await overlay({ start: {}, islandResting: true })
    o.applySettingsSurface()
    before(o.calls, 'setBounds', `setBackgroundColor:${SETTINGS_SURFACE_BACKGROUND}`)
    before(o.calls, 'setBounds', 'setOpacity:1')
    expect(o.state.bounds).toEqual(settingsOpenRect(DISPLAY, 8))
  })

  it('opening Settings from a revealed bar resizes before the opaque background', async () => {
    const o = await overlay({ start: { bounds: { x: 460, y: 39, width: 880, height: 120 }, opacity: 1 }, islandResting: false })
    o.applySettingsSurface()
    before(o.calls, 'setBounds', `setBackgroundColor:${SETTINGS_SURFACE_BACKGROUND}`)
    expect(o.calls).not.toContain('setOpacity:1')
  })
})
