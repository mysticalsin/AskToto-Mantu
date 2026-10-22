import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'
import { findSetting, SETTINGS_FEATURE_MODULES } from './settings-registry'
import {
  DEFAULT_VOICE_ACTIONS_SETTINGS,
  VOICE_ACTIONS_FEATURE,
  VOICE_ACTIONS_RELEASE_DEFAULT_ON,
  VoiceActionsSettingsSchema,
  resolveVoiceActionsChord,
  resolveVoiceActionsEnabled
} from './voice-actions-settings'

describe('voiceActions settings feature module', () => {
  it('is a registered feature module that owns exactly the voiceActions key', () => {
    expect(SETTINGS_FEATURE_MODULES).toContain(VOICE_ACTIONS_FEATURE)
    expect(Object.keys(VOICE_ACTIONS_FEATURE.shape)).toEqual(['voiceActions'])
    expect(findSetting('voiceActions')).toMatchObject({ kind: 'object', owner: 'voice-actions', mainOnly: false })
  })

  it('is part of BaseSettingsSchema and the defaults layer without a field written into ipc.ts', () => {
    expect('voiceActions' in BaseSettingsSchema.shape).toBe(true)
    expect(DEFAULT_SETTINGS.voiceActions).toEqual(DEFAULT_VOICE_ACTIONS_SETTINGS)
  })

  it('a fresh profile follows the build default and never listens for a wake word', () => {
    const fresh = BaseSettingsSchema.shape.voiceActions.parse(undefined)
    expect(fresh.enabled).toBeNull()
    expect(fresh.wakeWord).toBe(false)
    expect(fresh.firstUseHintsShown).toBe(0)
  })

  it('defaults to holding Right Command on macOS and Right Control on Windows', () => {
    expect(DEFAULT_VOICE_ACTIONS_SETTINGS.holdChord).toEqual({ mac: ['rcommand'], win: ['rcontrol'] })
    expect(resolveVoiceActionsChord(DEFAULT_VOICE_ACTIONS_SETTINGS, 'darwin')).toEqual(['rcommand'])
    expect(resolveVoiceActionsChord(DEFAULT_VOICE_ACTIONS_SETTINGS, 'win32')).toEqual(['rcontrol'])
    expect(resolveVoiceActionsChord(DEFAULT_VOICE_ACTIONS_SETTINGS, 'linux')).toEqual([])
  })

  it('rejects a chord token the watcher does not know and an empty chord', () => {
    expect(VoiceActionsSettingsSchema.safeParse({ holdChord: { mac: ['capslock'], win: ['rcontrol'] } }).success).toBe(
      false
    )
    expect(VoiceActionsSettingsSchema.safeParse({ holdChord: { mac: [], win: ['rcontrol'] } }).success).toBe(false)
    expect(
      VoiceActionsSettingsSchema.safeParse({ holdChord: { mac: ['control', 'option'], win: ['lcontrol'] } }).success
    ).toBe(true)
  })

  it('loads an older partial voiceActions object with today defaults for the missing keys', () => {
    const parsed = VoiceActionsSettingsSchema.parse({ enabled: true })
    expect(parsed).toEqual({ ...DEFAULT_VOICE_ACTIONS_SETTINGS, enabled: true })
  })
})

describe('effective default: ON in QA builds, OFF (Preview) in release builds until the flag is flipped', () => {
  it('ships the release default OFF; this one constant is what flips it after the owner checklist', () => {
    expect(VOICE_ACTIONS_RELEASE_DEFAULT_ON).toBe(false)
  })

  it('QA identity is ON by default', () => {
    expect(resolveVoiceActionsEnabled(DEFAULT_VOICE_ACTIONS_SETTINGS, { qaIdentity: true })).toBe(true)
  })

  it('a release build is OFF by default and ON once the release flag is flipped', () => {
    expect(resolveVoiceActionsEnabled(DEFAULT_VOICE_ACTIONS_SETTINGS, { qaIdentity: false })).toBe(
      VOICE_ACTIONS_RELEASE_DEFAULT_ON
    )
    expect(
      resolveVoiceActionsEnabled(DEFAULT_VOICE_ACTIONS_SETTINGS, { qaIdentity: false, releaseDefaultOn: true })
    ).toBe(true)
    expect(
      resolveVoiceActionsEnabled(DEFAULT_VOICE_ACTIONS_SETTINGS, { qaIdentity: false, releaseDefaultOn: false })
    ).toBe(false)
  })

  it('an explicit choice always beats the build default, in both directions', () => {
    const on = { ...DEFAULT_VOICE_ACTIONS_SETTINGS, enabled: true }
    const off = { ...DEFAULT_VOICE_ACTIONS_SETTINGS, enabled: false }
    expect(resolveVoiceActionsEnabled(on, { qaIdentity: false, releaseDefaultOn: false })).toBe(true)
    expect(resolveVoiceActionsEnabled(off, { qaIdentity: true, releaseDefaultOn: true })).toBe(false)
  })

  it('a missing or malformed stored value resolves like a fresh profile', () => {
    expect(resolveVoiceActionsEnabled(undefined, { qaIdentity: true })).toBe(true)
    expect(resolveVoiceActionsEnabled({} as never, { qaIdentity: false, releaseDefaultOn: false })).toBe(false)
  })
})
