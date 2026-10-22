import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from './ipc'
import { SCREEN_OBSERVATION_FEATURE, ScreenObservationSettingsShape } from './screen-observation-settings'
import { SETTINGS_FEATURE_MODULES, findSetting } from './settings-registry'

describe('screen observation settings (G16, R-11)', () => {
  it('a hover never pre-captures by default: the opt-in is off in the defaults and in a bare profile', () => {
    expect(DEFAULT_SETTINGS.screenHoverPrewarm).toBe(false)
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS, screenHoverPrewarm: undefined }).screenHoverPrewarm).toBe(false)
  })

  it('is owned by a registered feature module, so IT can lock it in managed config', () => {
    expect(SETTINGS_FEATURE_MODULES).toContain(SCREEN_OBSERVATION_FEATURE)
    expect(findSetting('screenHoverPrewarm')).toMatchObject({
      owner: 'screen-observation',
      kind: 'boolean',
      mainOnly: false
    })
    expect(Object.keys(ScreenObservationSettingsShape)).toEqual(['screenHoverPrewarm'])
  })
})
