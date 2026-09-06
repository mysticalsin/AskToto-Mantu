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
  TONY_LIVE_SETTINGS_CRUSH,
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
    expect(app).toMatch(/onBarSettings/)
    expect(app).toMatch(/openSettingsDefault/)
    expect(app).toMatch(/overlayShowsSettingsSheet\(view, minimized\) \? 'h-full min-h-0'/)
    expect(app).toMatch(/overlayShowsSettingsSheet\(view, minimized\) \? 'p-1\.5'/)
    expect(app).toMatch(/flex min-h-0 flex-1 flex-col/)
    expect(index).toMatch(/if \(!win\.isVisible\(\)\) win\.showInactive\(\)/)
    expect(index).toMatch(/function restoreBarWidth\(\): void/)
  })

  it('CLI Connect IPC is zero-token connectCliSession, never billed testCli', () => {
    const start = index.indexOf('ipcMain.handle(IPC.cliTest')
    const end = index.indexOf('ipcMain.handle(IPC.cliVerifySessions')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handler = index.slice(start, end)
    expect(handler).toMatch(/connectCliSession/)
    expect(handler).not.toMatch(/\btestCli\(/)
  })

  it('Settings open cannot keep park height or the live 880×325 Cmd+, slab', () => {
    expect(TONY_LIVE_SETTINGS_CRUSH).toEqual({ x: 460, y: 39, width: 880, height: 325 })
    expect(settingsOpenRejectsPark(TONY_LIVE_SETTINGS_CRUSH)).toBe(true)
    expect(settingsOpenRejectsPark({ width: 880, height: 325 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 8, height: 2 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 132, height: 15 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 880, height: 560 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 880, height: 800 })).toBe(false)
    const mac = settingsOpenRect(TOTOS_MAC, 8)
    expect(mac.height).toBeGreaterThanOrEqual(800)
    expect(mac.height).not.toBe(325)
    expect(mac.height).not.toBe(560)
    expect(mac.width).toBe(880)
  })

  it('settingsOpenRect is 880×800 at islandSafeTop, never Hide 8×2 or Island peek (Mac + Windows)', () => {
    const mac = settingsOpenRect(TOTOS_MAC, 8)
    expect(mac.width).toBe(SETTINGS_WINDOW_MIN.width)
    expect(mac.height).toBe(SETTINGS_WINDOW_MIN.height)
    expect(mac.height).toBe(800)
    expect(mac.y).toBe(39)
    expect(mac.y).not.toBe(0)
    expect(isHideOrIslandParkSize(mac)).toBe(false)
    expect(settingsOpenRejectsPark(mac)).toBe(false)

    const win = settingsOpenRect(WIN_DISPLAY, 8)
    expect(win.width).toBe(880)
    expect(win.height).toBe(800)
    expect(win.y).toBe(0)
    expect(isHideOrIslandParkSize(win)).toBe(false)
  })
})

describe('Ultron Mac show runbook stays the R01–R03 gate', () => {
  const show = readFileSync(join(__dirname, '../../docs/qa/MAC-SHOW-R01-R03.md'), 'utf8')

  it('names the live crush, the 880×800 open, and forbids packing Latest', () => {
    expect(show).toMatch(/x=460 y=39 width=880 height=325/)
    expect(show).toMatch(/880×800/)
    expect(show).toMatch(/#120022/)
    expect(show).toMatch(/isFatHoverTrigger/)
    expect(show).toMatch(/This agent does not pack/)
    expect(show).toMatch(/Do not publish Latest/)
    expect(show).toMatch(/READY TO MERGE no/)
    expect(show).toMatch(/Do not wait on GitHub Actions/)
    expect(show).toMatch(/11:30pm ET/)
    expect(show).toMatch(/Draft only/)
    expect(show).toMatch(/Settings from M/)
    expect(show).toMatch(/flex-1 min-h-0 overflow-y-auto/)
    expect(show).toMatch(/max-h-\[480px\]/)
  })
})

describe('DESIGN.md Settings surface matches the north star', () => {
  const design = readFileSync(join(__dirname, '../../docs/design/DESIGN.md'), 'utf8')
  const north = readFileSync(join(__dirname, '../../docs/design/METIS-PLATFORM-NORTH-STAR.md'), 'utf8')

  it('Settings is 880×800 dark glass, never a 320–360 leftover card', () => {
    expect(design).toMatch(/880×800/)
    expect(design).toMatch(/#120022/)
    expect(design).not.toMatch(/compact 320–360px/)
    expect(design).toMatch(/METIS-PLATFORM-NORTH-STAR/)
    expect(design).toMatch(/READY TO MERGE stays no/)
  })

  it('north star keeps R01–R07 on the desktop agent and R17 on Operator', () => {
    expect(north).toMatch(/READY TO MERGE: no/)
    expect(north).toMatch(/\*\*R01\*\*.*Desktop/)
    expect(north).toMatch(/\*\*R07\*\*.*Desktop/)
    expect(north).toMatch(/\*\*R17\*\*.*Operator/)
    expect(north).toMatch(/Do not ship product code in the PR that lands this file/)
  })
})

describe('MQA-288 — no-flash contract on Settings open/close and overlay rest', () => {
  it('Settings uses dark glass; rest and Hide park stay transparent; never white or #000', () => {
    expect(index).toMatch(/setBackgroundColor\(SETTINGS_SURFACE_BACKGROUND\)/)
    expect(index).toMatch(/setBackgroundColor\(OVERLAY_REST_BACKGROUND\)/)
    expect(index).toMatch(/rememberBarContentHeight/)
    expect(index).toMatch(/backgroundColor: onboardingLive \? '#3A0B6B' : '#00000000'/)
    expect(isForbiddenFlashBackground(SETTINGS_SURFACE_BACKGROUND)).toBe(false)
    expect(isForbiddenFlashBackground(OVERLAY_REST_BACKGROUND)).toBe(false)
    expect(SETTINGS_SURFACE_BACKGROUND).not.toBe('#ffffff')
    expect(SETTINGS_SURFACE_BACKGROUND).not.toBe('#000000')
  })
})
