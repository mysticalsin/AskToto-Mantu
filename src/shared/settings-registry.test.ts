/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'
import { OPERATOR_REPORTING_MAIN_KEYS } from './operator-reporting-settings'
import { defineSettingsFeature, type SettingsFeatureModule } from './settings-feature-module'
import {
  SETTINGS_FEATURE_MODULES,
  SETTINGS_REGISTRY,
  buildSettingsRegistry,
  findSetting,
  isRegisteredSettingKey,
  resolveSettingByName
} from './settings-registry'

describe('settings registry generated from BaseSettingsSchema', () => {
  it('has exactly one entry per schema key, in schema order', () => {
    expect(SETTINGS_REGISTRY.map((e) => e.key)).toEqual(Object.keys(BaseSettingsSchema.shape))
  })

  it('records the existing default of every key without changing it', () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(entry.default, entry.key).toEqual((DEFAULT_SETTINGS as Record<string, unknown>)[entry.key])
    }
  })

  it('describes kind, enum options and numeric ranges from the schema', () => {
    expect(findSetting('providerPriority')).toMatchObject({ kind: 'enum', options: ['cli', 'api'], default: 'api' })
    expect(findSetting('overlayOrbStyle')).toMatchObject({ kind: 'enum', default: 'jakub' })
    expect(findSetting('showFullTranscriptInReview')).toMatchObject({ kind: 'boolean', default: false })
    expect(findSetting('providerFallbackOrder')).toMatchObject({ kind: 'array', default: [] })
    expect(findSetting('providerModelsThinking')).toMatchObject({ kind: 'record', default: {} })
    expect(findSetting('cfAiGatewayId')).toMatchObject({ kind: 'string', max: 128, default: '' })
    expect(findSetting('operatorReportingExpiresAt')).toMatchObject({ kind: 'number', nullable: true })
  })

  it('reads a numeric range off a bounded number field', () => {
    const registry = buildSettingsRegistry({ gain: z.number().min(0).max(2).default(1) }, [])
    expect(registry[0]).toMatchObject({ key: 'gain', kind: 'number', min: 0, max: 2, default: 1 })
  })

  it('gives every key a readable label with acronyms kept upper case', () => {
    expect(findSetting('asrEngine')?.label).toBe('ASR engine')
    expect(findSetting('cfAiGatewayId')?.label).toBe('CF AI gateway ID')
    for (const entry of SETTINGS_REGISTRY) expect(entry.label.trim().length, entry.key).toBeGreaterThan(0)
  })

  it('names the owning feature module, and marks main-only keys from the module declaration', () => {
    expect(findSetting('brokerSpeech')?.owner).toBe('cloud-speech')
    expect(findSetting('operatorReportingToken')).toMatchObject({ owner: 'operator-reporting', mainOnly: true })
    expect(findSetting('provider')).toMatchObject({ owner: 'core', mainOnly: false })
    for (const key of OPERATOR_REPORTING_MAIN_KEYS) expect(findSetting(key)?.mainOnly, key).toBe(true)
  })

  it('only knows real settings: unknown names resolve to nothing', () => {
    expect(isRegisteredSettingKey('provider')).toBe(true)
    expect(isRegisteredSettingKey('settingsSchemaVersion')).toBe(false)
    expect(isRegisteredSettingKey('toString')).toBe(false)
    expect(isRegisteredSettingKey('__proto__')).toBe(false)
    expect(findSetting('doesNotExist')).toBeUndefined()
    expect(resolveSettingByName('make the moon bigger')).toBeNull()
  })

  it('resolves a spoken or typed name to the real key deterministically', () => {
    expect(resolveSettingByName('ASR engine')?.key).toBe('asrEngine')
    expect(resolveSettingByName('  asr   ENGINE ')?.key).toBe('asrEngine')
    expect(resolveSettingByName('asrEngine')?.key).toBe('asrEngine')
    expect(resolveSettingByName('')).toBeNull()
  })

  it('refuses a registry whose modules claim keys the schema does not have, or claim a key twice', () => {
    const shape = { a: z.string().default(''), b: z.string().default('') }
    const ghost = defineSettingsFeature({ id: 'ghost', shape: { zzz: z.string().default('') } })
    expect(() => buildSettingsRegistry(shape, [ghost])).toThrow(/zzz/)
    const one = defineSettingsFeature({ id: 'one', shape: { a: z.string().default('') } })
    const two = defineSettingsFeature({ id: 'two', shape: { a: z.string().default('') } })
    expect(() => buildSettingsRegistry(shape, [one, two])).toThrow(/a/)
  })
})

describe('feature schema module convention', () => {
  it('rejects a main-only key the module does not declare, and a non-kebab id', () => {
    expect(() =>
      defineSettingsFeature({ id: 'x', shape: { a: z.string().default('') }, mainOnlyKeys: ['b' as 'a'] })
    ).toThrow(/b/)
    expect(() => defineSettingsFeature({ id: 'Not Kebab', shape: {} })).toThrow(/id/)
  })

  it('registers every src/shared/*-settings module so a new feature cannot skip the registry', () => {
    const found = import.meta.glob('./*-settings.ts', { eager: true }) as Record<string, Record<string, unknown>>
    const descriptors = Object.values(found).flatMap((mod) =>
      Object.values(mod).filter(
        (v): v is SettingsFeatureModule =>
          typeof v === 'object' && v !== null && 'mainOnlyKeys' in v && 'shape' in v && 'id' in v
      )
    )
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(found).length).toBe(descriptors.length)
    expect(SETTINGS_FEATURE_MODULES.map((m) => m.id).sort()).toEqual(descriptors.map((m) => m.id).sort())
  })

  it('every module key is a real BaseSettingsSchema key', () => {
    for (const module of SETTINGS_FEATURE_MODULES)
      for (const key of Object.keys(module.shape))
        expect(key in BaseSettingsSchema.shape, `${module.id}.${key}`).toBe(true)
  })
})
