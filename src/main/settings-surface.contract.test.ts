import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsOpenRect } from './island/geometry'
import {
  OVERLAY_REST_BACKGROUND,
  SETTINGS_SURFACE_BACKGROUND,
  SETTINGS_WINDOW_MIN,
  isForbiddenFlashBackground,
  isHideOrIslandParkSize,
  settingsOpenRejectsPark
} from '@shared/settings-bounds'

const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

const TOTOS_MAC = {
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 39, width: 1800, height: 1130 },
  hasNotch: true,
  notchWidth: 200,
  menuBarHeight: 39,
  source: 'helper' as const
}

const WIN_DISPLAY = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  hasNotch: false,
  notchWidth: 0,
  menuBarHeight: 0,
  source: 'heuristic' as const
}

describe('MQA-286 — Settings open path sets min bounds', () => {
  it('tray, hotkey, and IPC Settings call applySettingsSurface before the crushed park can win', () => {
    expect(index).toMatch(/function applySettingsSurface\(\): void/)
    expect(index).toMatch(/function leaveSettingsSurface\(\): void/)
    expect(index).toMatch(/if \(action === 'settings'\) applySettingsSurface\(\)/)
    expect(index).toMatch(/tray\.on\('click', \(\) => sendHotkey\('settings'\)\)/)
    expect(index).toMatch(/if \(mode === 'settings'\) applySettingsSurface\(\)/)
    expect(index).toMatch(/win\.setMinimumSize\(SETTINGS_WINDOW_MIN\.width, SETTINGS_WINDOW_MIN\.height\)/)
    expect(index).toMatch(/settingsOpenRect/)
    expect(index).toMatch(/if \(settingsSurfaceOpen\)/)
    expect(index).toMatch(/settingsContentHeight/)
    expect(index).toMatch(/sendHotkey\('settings'\)/)
    expect(app).toMatch(/windowMode\('settings'\)/)
    expect(app).toMatch(/prevViewRef\.current === 'settings'/)
  })

  it('Settings open cannot keep park height or the live 880×325 Cmd+, slab', () => {
    expect(settingsOpenRejectsPark({ width: 880, height: 325 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 8, height: 2 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 132, height: 15 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 880, height: 560 })).toBe(false)
    const mac = settingsOpenRect(TOTOS_MAC, 8)
    expect(mac.height).toBeGreaterThanOrEqual(560)
    expect(mac.height).not.toBe(325)
    expect(mac.width).toBe(880)
  })

  it('settingsOpenRect is 880×560 at islandSafeTop, never Hide 8×2 or Island peek (Mac + Windows)', () => {
    const mac = settingsOpenRect(TOTOS_MAC, 8)
    expect(mac.width).toBe(SETTINGS_WINDOW_MIN.width)
    expect(mac.height).toBe(SETTINGS_WINDOW_MIN.height)
    expect(mac.y).toBe(39)
    expect(mac.y).not.toBe(0)
    expect(isHideOrIslandParkSize(mac)).toBe(false)
    expect(settingsOpenRejectsPark(mac)).toBe(false)

    const win = settingsOpenRect(WIN_DISPLAY, 8)
    expect(win.width).toBe(880)
    expect(win.height).toBe(560)
    expect(win.y).toBe(0)
    expect(isHideOrIslandParkSize(win)).toBe(false)
  })
})

describe('MQA-288 — no-flash contract on Settings open/close and overlay rest', () => {
  it('Settings uses dark glass; rest and Hide park stay transparent; never white or #000', () => {
    expect(index).toMatch(/setBackgroundColor\(SETTINGS_SURFACE_BACKGROUND\)/)
    expect(index).toMatch(/setBackgroundColor\(OVERLAY_REST_BACKGROUND\)/)
    expect(index).toMatch(/backgroundColor: onboardingLive \? '#3A0B6B' : '#00000000'/)
    expect(isForbiddenFlashBackground(SETTINGS_SURFACE_BACKGROUND)).toBe(false)
    expect(isForbiddenFlashBackground(OVERLAY_REST_BACKGROUND)).toBe(false)
    expect(SETTINGS_SURFACE_BACKGROUND).not.toBe('#ffffff')
    expect(SETTINGS_SURFACE_BACKGROUND).not.toBe('#000000')
  })
})
