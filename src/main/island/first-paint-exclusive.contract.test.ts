import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exclusiveMayUseSimpleFullScreen,
  exclusiveOsFullscreenAllowed,
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

  it('exclusive onboarding window is opaque hero hold, never purple wash', () => {
    const live = overlayWindowChrome(true)
    expect(live.transparent).toBe(false)
    expect(live.backgroundColor).toBe(EXCLUSIVE_ONBOARDING_BACKGROUND)
    expect(live.backgroundColor).toBe('#05010A')
    expect(live.backgroundColor).not.toBe('#3A0B6B')
    expect(live.backgroundColor).not.toBe(OVERLAY_TRANSPARENT_BACKGROUND)
    expect(live.backgroundColor).not.toBe('#00000000')
    expect(live.fullscreenable).toBe(true)
    expect(live.roundedCorners).toBe(false)
    expect(exclusiveMayUseSimpleFullScreen(live.transparent)).toBe(true)
    // FITO-185-S: Electron 43+ never OS SFS even with ASKTOTO_ALLOW_SFS
    expect(
      exclusiveOsFullscreenAllowed({ electronVersion: '43.6.0', allowSfsEnv: '1' })
    ).toBe(false)
    expect(
      exclusiveOsFullscreenAllowed({ electronVersion: '39.8.10', allowSfsEnv: '1' })
    ).toBe(true)
    expect(
      exclusiveOsFullscreenAllowed({ electronVersion: '39.8.10', allowSfsEnv: undefined })
    ).toBe(false)
    expect(
      exclusiveOsFullscreenAllowed({ electronVersion: '39.8.10', allowSfsEnv: '1', shotEnv: '1' })
    ).toBe(false)
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
    // FITO-185-Z: exclusive shows immediately (never show:!onboardingLive hide-for-seconds)
    expect(create).toMatch(/show:\s*true/)
    expect(create).not.toMatch(/show:\s*!onboardingLive/)
    expect(create).toMatch(/FITO-185-Z/)
    expect(create).toMatch(/pollAct1Paint/)
    expect(create).toMatch(/overlay\.once\('ready-to-show'/)
    expect(create).toMatch(/revealExclusiveWhenPainted/)
    expect(create).toContain('}, 2000)') // FITO-185-G-SHOW hard reassert
    // FITO-185-T: without SFS, activating show is required (showInactive left Act 1 behind Finder)
    expect(create).toMatch(/showForExclusiveOnboarding\(win\)/)
    expect(create).toMatch(/showForExclusiveOnboarding\(overlay\)/)
    expect(create).toMatch(/setHiddenInMissionControl\?\.\(!onboardingLive\)/)
    expect(create).not.toMatch(/win\.setHiddenInMissionControl\?\.\(true\)/)
    expect(create).not.toMatch(/transparent:\s*true/)
    expect(create).not.toMatch(/backgroundColor: onboardingLive \? '#3A0B6B'/)

    const apply = index.slice(
      index.indexOf('function applyExclusiveOnboardingStage'),
      index.indexOf('function exitExclusiveOnboardingStage')
    )
    expect(apply).toMatch(/if \(overlayWindowTransparent\) \{\s*recreateOverlayWindow\(\)/)
    expect(apply).toMatch(/exclusiveMayUseSimpleFullScreen\(overlayWindowTransparent\)/)
    expect(apply).toMatch(/exclusiveOsFullscreenAllowed\(/)
    expect(apply).toMatch(/process\.versions\.electron/)
    expect(apply).toMatch(/setSimpleFullScreen\(true\)/)
    expect(apply.indexOf('exclusiveOsFullscreenAllowed(')).toBeLessThan(apply.indexOf('setSimpleFullScreen(true)'))
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
      app.indexOf('Onboarding gate FIRST'),
      app.indexOf('Post-onboarding only:')
    )
    expect(gate).toMatch(/className="onboard-stage(?:\s+onboard-stage--portal-open)?\s+onboard-exclusive-lock"/)
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

describe('FITO-185-T exclusive Act 1 visible without forever Loading', () => {
  it('createWindow activates exclusive via showForExclusiveOnboarding immediately (FITO-185-Z)', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/showForExclusiveOnboarding\(win\)/)
    expect(create).toMatch(/showForExclusiveOnboarding\(overlay\)/)
    // FITO-185-Z: ctor-time exclusive show — no hide-until-paint.
    expect(create).toMatch(/FITO-185-Z: show exclusive NOW/)
    expect(create).not.toMatch(/do NOT show exclusive here/)
    const reveal = create.slice(
      create.indexOf('const revealExclusiveWhenPainted'),
      create.indexOf('overlay.webContents.on(')
    )
    expect(reveal).toMatch(/showForExclusiveOnboarding\(overlay\)/)
    expect(reveal).not.toMatch(/showInactive\(\)/)
    expect(create).toMatch(/pollAct1Paint/)
    expect(create).toMatch(/ACT1_SHELL_READY/)
  })

  it('FITO-185-S still hard-disables SFS on Electron 43+', () => {
    expect(
      exclusiveOsFullscreenAllowed({ electronVersion: '43.6.0', allowSfsEnv: '1' })
    ).toBe(false)
    const apply = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const body = apply.slice(
      apply.indexOf('function applyExclusiveOnboardingStage'),
      apply.indexOf('function exitExclusiveOnboardingStage')
    )
    expect(body).toMatch(/exclusiveOsFullscreenAllowed\(/)
  })
})



describe('FITO-185-U exclusive Act 1 capturable + DOM probe', () => {
  it('contentProtectionOn forces false while exclusive', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const body = index.slice(
      index.indexOf('function contentProtectionOn(): boolean {'),
      index.indexOf('function privateViewOn(): boolean {')
    )
    expect(body).toMatch(/onboardingExclusiveLive\(\)/)
    expect(body).toMatch(/FITO-185-U/)
    expect(body).toMatch(/return false/)
  })

  it('createWindow binds act1 DOM probe and keeps exclusiveOnboarding=1', () => {
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    const create = index.slice(index.indexOf('function createWindow'), index.indexOf('function resizeTo'))
    expect(create).toMatch(/bindAct1DomProbe\(/)
    expect(create).toMatch(/act1-dom\.json/)
    expect(create).toMatch(/params\.set\('exclusiveOnboarding', '1'\)/)
  })

  it('portal-open CSS unlock includes onboard-cta / Next (FITO-185-V)', () => {
    const css = readFileSync(join(__dirname, '../../renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/\.onboard-stage\.onboard-stage--portal-open[\s\S]*\.onboard-cta/)
    expect(css).toMatch(/FITO-185-V/)
  })
})
