import { describe, expect, it } from 'vitest'
import {
  FAT_HOVER_TRIGGER_MIN,
  OVERLAY_REST_BACKGROUND,
  SETTINGS_SURFACE_BACKGROUND,
  SETTINGS_WINDOW_MIN,
  isCrushedSettingsBounds,
  isFatHoverTrigger,
  isForbiddenFlashBackground,
  isHideOrIslandParkSize,
  settingsOpenRejectsPark,
  settingsSurfaceMinSize
} from './settings-bounds'

describe('MQA-286 — Settings open path sets full min bounds', () => {
  it('Apple-grade Settings min is 880×560, never Hide 8×2 or Island peek', () => {
    expect(SETTINGS_WINDOW_MIN.width).toBe(880)
    expect(SETTINGS_WINDOW_MIN.height).toBe(560)
    expect(settingsSurfaceMinSize()).toEqual({ width: 880, height: 560 })
    expect(isHideOrIslandParkSize({ width: 8, height: 2 })).toBe(true)
    expect(isHideOrIslandParkSize({ width: 142, height: 19 })).toBe(true)
    expect(isHideOrIslandParkSize({ width: 880, height: 560 })).toBe(false)
    expect(isCrushedSettingsBounds({ width: 8, height: 800 })).toBe(true)
    expect(isCrushedSettingsBounds({ width: 132, height: 15 })).toBe(true)
    expect(isCrushedSettingsBounds({ width: 880, height: 560 })).toBe(false)
    expect(settingsOpenRejectsPark({ width: 8, height: 2 })).toBe(true)
    expect(settingsOpenRejectsPark({ width: 880, height: 560 })).toBe(false)
  })

  it('Windows and Mac share the same Settings min (no fake notch width)', () => {
    expect(SETTINGS_WINDOW_MIN.width).toBe(880)
    expect(SETTINGS_WINDOW_MIN.width).not.toBe(8)
    expect(SETTINGS_WINDOW_MIN.width).not.toBe(132)
  })
})

describe('MQA-289 — leftover clamp must not park 880×133 at Y=39', () => {
  it('880×133 at workArea.y is a fat hover trigger; 8×2 at bounds.y is not', () => {
    expect(FAT_HOVER_TRIGGER_MIN).toEqual({ width: 800, height: 100 })
    expect(isFatHoverTrigger({ width: 880, height: 133, y: 39 }, 39)).toBe(true)
    expect(isFatHoverTrigger({ width: 880, height: 84, y: 39 }, 39)).toBe(false)
    expect(isFatHoverTrigger({ width: 8, height: 2, y: 0 }, 39)).toBe(false)
    expect(isFatHoverTrigger({ width: 142, height: 19, y: 0 }, 39)).toBe(false)
    expect(isFatHoverTrigger({ width: 880, height: 816, y: 39 }, 39)).toBe(false)
  })
})

describe('MQA-288 — no white or solid-black flash colors', () => {
  it('Settings and rest backgrounds are not flash colors', () => {
    expect(isForbiddenFlashBackground(SETTINGS_SURFACE_BACKGROUND)).toBe(false)
    expect(isForbiddenFlashBackground(OVERLAY_REST_BACKGROUND)).toBe(false)
    expect(isForbiddenFlashBackground('#ffffff')).toBe(true)
    expect(isForbiddenFlashBackground('#000000')).toBe(true)
    expect(isForbiddenFlashBackground('#fff')).toBe(true)
    expect(SETTINGS_SURFACE_BACKGROUND).toBe('#120022')
    expect(OVERLAY_REST_BACKGROUND).toBe('#00000000')
  })
})
