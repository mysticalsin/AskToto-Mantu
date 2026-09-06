import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exclusiveMayUseSimpleFullScreen,
  exclusiveOnboardingBounds,
  EXCLUSIVE_ONBOARDING_BACKGROUND,
  firstPaintOverlayBounds,
  overlayWindowChrome,
  OVERLAY_HIDE_PARK,
  OVERLAY_TRANSPARENT_BACKGROUND,
  type DisplayMetrics,
  type Rect
} from './geometry'

const macbookBounds: Rect = { x: 0, y: 0, width: 1512, height: 982 }
const macbookWorkArea: Rect = { x: 0, y: 39, width: 1512, height: 943 }

function tonyMac(): DisplayMetrics {
  return {
    bounds: macbookBounds,
    workArea: macbookWorkArea,
    hasNotch: true,
    notchWidth: 200,
    menuBarHeight: 39,
    source: 'heuristic'
  }
}

describe('first-paint exclusive stage while !onboardingDone', () => {
  it('first-paint bounds equal the exclusive stage — never Hide/Island 8×2', () => {
    const exclusive = exclusiveOnboardingBounds(macbookBounds, macbookWorkArea)
    const first = firstPaintOverlayBounds({
      onboardingDone: false,
      bounds: macbookBounds,
      workArea: macbookWorkArea,
      layout: 'hide',
      metrics: tonyMac(),
      topMargin: 8
    })
    expect(first).toEqual(exclusive)
    expect(first.width).toBeGreaterThan(OVERLAY_HIDE_PARK.width)
    expect(first.height).toBeGreaterThan(OVERLAY_HIDE_PARK.height)
    expect(first.width).toBeGreaterThanOrEqual(macbookWorkArea.width)
    expect(first.height).toBeGreaterThanOrEqual(macbookWorkArea.height)
  })

  it('after onboardingDone, first paint may park hide — not before', () => {
    const parked = firstPaintOverlayBounds({
      onboardingDone: true,
      bounds: macbookBounds,
      workArea: macbookWorkArea,
      layout: 'hide',
      metrics: tonyMac(),
      topMargin: 8
    })
    expect(parked.width).toBe(OVERLAY_HIDE_PARK.width)
    expect(parked.height).toBe(OVERLAY_HIDE_PARK.height)
    expect(parked.y).toBe(macbookBounds.y)
    expect(parked.y).not.toBe(39)
  })

  it('createWindow uses firstPaintOverlayBounds for constructor size', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/firstPaintOverlayBounds/)
    expect(create).toMatch(/width: firstPaint.width/)
    expect(create).toMatch(/height: firstPaint.height/)
    expect(create).not.toMatch(/restPark/)
    expect(create.indexOf('firstPaintOverlayBounds')).toBeLessThan(create.indexOf('new BrowserWindow'))
    expect(create.indexOf('if (onboardingLive) applyExclusiveOnboardingStage')).toBeGreaterThan(
      create.indexOf('new BrowserWindow')
    )
  })

  it('exclusive onboarding window is opaque Mantu purple, not transparent', () => {
    const live = overlayWindowChrome(true)
    expect(live.transparent).toBe(false)
    expect(live.backgroundColor).toBe(EXCLUSIVE_ONBOARDING_BACKGROUND)
    expect(live.backgroundColor).toBe('#3A0B6B')
    expect(live.backgroundColor).not.toBe(OVERLAY_TRANSPARENT_BACKGROUND)
    expect(live.backgroundColor).not.toBe('#00000000')
    expect(live.fullscreenable).toBe(true)
    expect(live.roundedCorners).toBe(false)
    expect(exclusiveMayUseSimpleFullScreen(live.transparent)).toBe(true)
  })

  it('after onboardingDone the overlay window is transparent again', () => {
    const parked = overlayWindowChrome(false)
    expect(parked.transparent).toBe(true)
    expect(parked.backgroundColor).toBe(OVERLAY_TRANSPARENT_BACKGROUND)
    expect(parked.backgroundColor).toBe('#00000000')
    expect(parked.fullscreenable).toBe(false)
    expect(parked.roundedCorners).toBe(true)
    expect(exclusiveMayUseSimpleFullScreen(parked.transparent)).toBe(false)
  })

  it('createWindow and exclusive apply never simple-fullscreen a transparent window', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/overlayWindowChrome\(onboardingLive\)/)
    expect(create).toMatch(/transparent: chrome\.transparent/)
    expect(create).toMatch(/backgroundColor: chrome\.backgroundColor/)
    expect(create).not.toMatch(/transparent:\s*true/)
    expect(create).not.toMatch(/backgroundColor: onboardingLive \? '#3A0B6B'/)

    const apply = index.slice(
      index.indexOf('function applyExclusiveOnboardingStage'),
      index.indexOf('function exitExclusiveOnboardingStage')
    )
    expect(apply).toMatch(/if \(overlayWindowTransparent\) \{\s*recreateOverlayWindow\(\)/)
    expect(apply).toMatch(/exclusiveMayUseSimpleFullScreen\(overlayWindowTransparent\)/)
    expect(apply).toMatch(/setSimpleFullScreen\(true\)/)
    expect(apply.indexOf('exclusiveMayUseSimpleFullScreen(overlayWindowTransparent)')).toBeLessThan(
      apply.indexOf('setSimpleFullScreen(true)')
    )
    expect(apply).toMatch(/setBackgroundColor\(EXCLUSIVE_ONBOARDING_BACKGROUND\)/)

    const exit = index.slice(index.indexOf('function exitExclusiveOnboardingStage'), index.indexOf('function createWindow'))
    expect(exit).toMatch(/if \(!overlayWindowTransparent\) \{\s*recreateOverlayWindow\(\)/)

    const settings = readFileSync(join(__dirname, '../../renderer/src/components/Settings.tsx'), 'utf8')
    const replay = settings.slice(settings.indexOf('Replay onboarding from the start?'))
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeLessThan(replay.indexOf('patch({ onboardingDone: false })'))
  })
})

describe('exclusive onboarding cannot be dragged off-screen', () => {
  it('onboard root has no windowDrag and main ignores move while exclusive', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const app = readFileSync(join(__dirname, '../../renderer/src/App.tsx'), 'utf8')
    const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')
    const gate = app.slice(
      app.indexOf("settings && !settings.onboardingDone && DEMO == null"),
      app.indexOf('const panelOpen')
    )
    expect(gate).toMatch(/className="onboard-stage onboard-exclusive-lock"/)
    expect(gate).toMatch(/onboard-exclusive-lock/)
    expect(gate).not.toMatch(/windowDrag/)
    expect(gate).not.toMatch(/onPointerDown/)
    expect(gate).not.toMatch(/windowMoveBy/)
    expect(css).toMatch(/\.onboard-stage \{[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(css).toMatch(/\.onboard-exclusive-lock[\s\S]*?-webkit-app-region:\s*no-drag/)
    expect(css).toMatch(/\.onboard-stage \.drag \{[\s\S]*?-webkit-app-region:\s*no-drag/)

    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/movable: !onboardingLive/)
    expect(create).not.toMatch(/movable: true/)

    const apply = index.slice(
      index.indexOf('function applyExclusiveOnboardingStage'),
      index.indexOf('function exitExclusiveOnboardingStage')
    )
    expect(apply).toMatch(/setMovable\(false\)/)

    const exit = index.slice(index.indexOf('function exitExclusiveOnboardingStage'), index.indexOf('function createWindow'))
    expect(exit).toMatch(/setMovable\(true\)/)

    const move = index.slice(index.indexOf('function moveBy'), index.indexOf('function registerScreenListeners'))
    expect(move).toMatch(/if \(onboardingExclusiveLive\(\)\) return/)
    expect(index).toMatch(
      /ipcMain\.handle\(IPC\.windowMoveBy[\s\S]{0,240}if \(onboardingExclusiveLive\(\)\) return/
    )
  })
})
