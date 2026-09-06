import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY_LAYOUT,
  OVERLAY_LAYOUT_COPY,
  OVERLAY_LAYOUTS,
  autoHideOverlayForLayout,
  migrateOverlayLayout,
  overlayAllowsMinimize,
  overlayShowsBarOrb,
  overlayDocksBarCircle,
  shouldForceParkOnBecameIdle,
  overlayRestsHidden,
  overlayUsesHover,
  overlayUsesSafeTop,
  overlayHoverIdle,
  overlayHoverForced,
  overlayAllowsHugWidth,
  isShowMetisHugStub,
  isIncompleteAskReveal,
  overlayRevealedContentHeight,
  ASK_REVEAL_MIN_HEIGHT_PX,
  BAR_IDLE_HEIGHT_PX,
  isSettingsTallHeight,
  rememberBarContentHeight,
  isBarIdleGhostPanel,
  overlayShowsSettingsSheet,
  isShowMetisOnlyStub,
  isFullAskReveal,
  parseOverlayLayout
} from './overlay-chrome'
import { SETTINGS_SURFACE_BACKGROUND } from './settings-bounds'

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
    expect(overlayAllowsMinimize('bar')).toBe(true)
    expect(overlayAllowsMinimize('hide')).toBe(false)
    expect(overlayAllowsMinimize('island')).toBe(false)
    expect(overlayShowsBarOrb('hide', false)).toBe(false)
    expect(overlayShowsBarOrb('hide', true)).toBe(false)
    expect(overlayShowsBarOrb('island', false)).toBe(false)
    expect(overlayShowsBarOrb('island', true)).toBe(false)
    expect(overlayShowsBarOrb('bar', false)).toBe(false)
    expect(overlayShowsBarOrb('bar', true)).toBe(true)
    expect(overlayDocksBarCircle('bar')).toBe(true)
    expect(overlayDocksBarCircle('hide')).toBe(false)
    expect(overlayDocksBarCircle('island')).toBe(false)
  })

  it('closing Settings onto Hide/Island force-parks; Bar does not', () => {
    expect(shouldForceParkOnBecameIdle({ becameIdle: true, usesHover: true })).toBe(true)
    expect(shouldForceParkOnBecameIdle({ becameIdle: true, usesHover: false })).toBe(false)
    expect(shouldForceParkOnBecameIdle({ becameIdle: false, usesHover: true })).toBe(false)
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

  it('Hide stays hover-idle with a standing answer or listening chrome', () => {
    const base = {
      usesHover: true,
      minimized: false,
      onboardingDone: true,
      view: 'answer',
      capturing: false
    }
    expect(overlayHoverIdle(base)).toBe(true)
    expect(overlayHoverIdle({ ...base, view: 'settings' })).toBe(false)
    expect(overlayHoverIdle({ ...base, capturing: true })).toBe(false)
    expect(overlayHoverIdle({ ...base, usesHover: false })).toBe(false)
    expect(overlayHoverForced({ updateReady: false, toast: false, typedInput: false })).toBe(false)
    expect(overlayHoverForced({ updateReady: false, toast: false, typedInput: true })).toBe(true)
    expect(overlayHoverForced({ updateReady: true, toast: false, typedInput: false })).toBe(true)
    expect(isShowMetisHugStub({ width: 120, height: 44 })).toBe(true)
    expect(isShowMetisHugStub({ width: 880, height: 84 })).toBe(false)
    expect(isIncompleteAskReveal({ width: 120, height: 44 })).toBe(true)
    expect(isIncompleteAskReveal({ width: 880, height: 44 })).toBe(true)
    expect(isIncompleteAskReveal({ width: 880, height: 2 })).toBe(true)
    expect(isIncompleteAskReveal({ width: 880, height: 84 })).toBe(false)
    expect(isIncompleteAskReveal({ width: 8, height: 2 })).toBe(false)
    expect(ASK_REVEAL_MIN_HEIGHT_PX).toBe(120)
    expect(
      overlayRevealedContentHeight({
        islandResting: false,
        minimized: false,
        settingsOpen: false,
        reportedHeight: 20
      })
    ).toBe(120)
    expect(
      overlayRevealedContentHeight({
        islandResting: true,
        minimized: false,
        settingsOpen: false,
        reportedHeight: 2
      })
    ).toBe(2)
    expect(
      overlayRevealedContentHeight({
        islandResting: false,
        minimized: false,
        settingsOpen: false,
        reportedHeight: 84,
        usesHover: false
      })
    ).toBe(84)
    expect(BAR_IDLE_HEIGHT_PX).toBe(84)
    expect(isSettingsTallHeight(800)).toBe(true)
    expect(isSettingsTallHeight(84)).toBe(false)
    expect(rememberBarContentHeight(800)).toBe(84)
    expect(rememberBarContentHeight(400)).toBe(400)
    expect(rememberBarContentHeight(84)).toBe(84)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 880,
        height: 800
      })
    ).toBe(true)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 880,
        height: 84,
        background: SETTINGS_SURFACE_BACKGROUND
      })
    ).toBe(true)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: true,
        width: 880,
        height: 800
      })
    ).toBe(false)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 880,
        height: 84
      })
    ).toBe(false)
    expect(
      isBarIdleGhostPanel({
        layout: 'hide',
        settingsSurfaceOpen: false,
        width: 880,
        height: 800
      })
    ).toBe(false)
    expect(
      isBarIdleGhostPanel({
        layout: 'bar',
        settingsSurfaceOpen: false,
        width: 41,
        height: 800,
        minimized: true
      })
    ).toBe(true)
    expect(overlayShowsSettingsSheet('settings', false)).toBe(true)
    expect(overlayShowsSettingsSheet('settings', true)).toBe(false)
    expect(overlayShowsSettingsSheet('answer', false)).toBe(false)
    expect(
      overlayAllowsHugWidth({ minimized: false, islandResting: false, restWidth: 8, nextWidth: 120 })
    ).toBe(false)
    expect(
      overlayAllowsHugWidth({ minimized: true, islandResting: false, restWidth: 8, nextWidth: 120 })
    ).toBe(true)
    expect(
      overlayAllowsHugWidth({ minimized: false, islandResting: true, restWidth: 142, nextWidth: 142 })
    ).toBe(true)
  })

  it('top-edge reveal is Ask chrome, not a Show-Métis-only 44px strip', () => {
    const ultronA40 = {
      width: 880,
      height: 44,
      hasAsk: false,
      buttons: ['Show Métis']
    }
    expect(isShowMetisOnlyStub(ultronA40)).toBe(true)
    expect(isFullAskReveal(ultronA40)).toBe(false)
    expect(
      isShowMetisOnlyStub({ width: 120, height: 44, hasAsk: false, buttons: ['Show Métis'] })
    ).toBe(true)
    expect(
      isFullAskReveal({ width: 880, height: 120, hasAsk: true })
    ).toBe(true)
    expect(
      isShowMetisOnlyStub({
        width: 880,
        height: 120,
        hasAsk: true,
        buttons: ['Ask', 'Settings']
      })
    ).toBe(false)
    const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')
    const bar = readFileSync(join(__dirname, '../renderer/src/components/Bar.tsx'), 'utf8')
    expect(app).toMatch(/reveal-now/)
    expect(app).toMatch(/overlayRestsHidden\(overlayLayout\)/)
    expect(bar).toMatch(/aria-label="Ask Métis anything"/)
  })

  it('mouse-away parks Hide without clearing the live Ask answer', () => {
    const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')
    const index = readFileSync(join(__dirname, '../main/index.ts'), 'utf8')
    expect(app).toMatch(/overlayHoverIdle/)
    expect(app).toMatch(/parkAfterHide/)
    for (const chunk of app.split('parkAfterHide()')) {
      expect(chunk.slice(-160)).not.toMatch(/ask\.clear\(/)
    }
    const parkFn = index.slice(
      index.indexOf('function parkOverlayAfterHideSpring'),
      index.indexOf('function applyHideClickThrough')
    )
    expect(parkFn).toMatch(/parkAfterExclusiveOnboarding/)
    expect(parkFn).not.toMatch(/ask\.clear/)
    expect(index).toMatch(/scheduleOverlayLeavePark/)
    expect(index).toMatch(/OVERLAY_LEAVE_PARK_MS/)
    expect(overlayHoverIdle({
      usesHover: true,
      minimized: false,
      onboardingDone: true,
      view: 'answer',
      capturing: false
    })).toBe(true)
  })

  it('Settings captions say what each chrome does (no em dash, no Vibe Island)', () => {
    expect(OVERLAY_LAYOUT_COPY.hide.title).toBe('Hide')
    expect(OVERLAY_LAYOUT_COPY.hide.desc).toMatch(/Hidden until you move to the top/)
    expect(OVERLAY_LAYOUT_COPY.island.title).toBe('Island')
    expect(OVERLAY_LAYOUT_COPY.island.desc).toMatch(/small island stays visible/)
    expect(OVERLAY_LAYOUT_COPY.bar.title).toBe('Bar')
    expect(OVERLAY_LAYOUT_COPY.bar.desc).toMatch(/bar stays on screen/)
    const all = Object.values(OVERLAY_LAYOUT_COPY)
      .map((c) => `${c.title} ${c.desc}`)
      .join(' ')
    expect(all).not.toMatch(/\u2014/)
    expect(all).not.toMatch(/Vibe Island/)
  })
})
