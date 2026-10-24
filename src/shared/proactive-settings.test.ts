import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'
import { DEFAULT_INTERRUPTION_MODE, INTERRUPTION_MODES, InterruptionModeSchema } from './proactive-settings'
import { PROACTIVE_CONTROLS_FEATURE } from './proactive-settings'
import { SETTINGS_FEATURE_MODULES, findSetting } from './settings-registry'

describe('proactive controls settings (G77)', () => {
  it('defaults interruptionMode to questions', () => {
    expect(DEFAULT_INTERRUPTION_MODE).toBe('questions')
    expect(BaseSettingsSchema.shape.interruptionMode.parse(undefined)).toBe('questions')
    expect(INTERRUPTION_MODES).toEqual(['manual', 'questions'])
    expect((DEFAULT_SETTINGS as Record<string, unknown>).interruptionMode).toBe('questions')
    expect(findSetting('interruptionMode')).toMatchObject({ kind: 'enum', default: 'questions' })
  })

  it('rejects unknown modes', () => {
    expect(InterruptionModeSchema.safeParse('always').success).toBe(false)
    expect(InterruptionModeSchema.safeParse('key-moments').success).toBe(false)
    expect(BaseSettingsSchema.shape.interruptionMode.safeParse('loud').success).toBe(false)
  })

  it('is registered in the settings registry and composed into the base schema', () => {
    expect(SETTINGS_FEATURE_MODULES).toContain(PROACTIVE_CONTROLS_FEATURE)
    expect(Object.keys(BaseSettingsSchema.shape)).toContain('interruptionMode')
    expect(findSetting('interruptionMode')?.owner).toBe('proactive-controls')
  })
})
