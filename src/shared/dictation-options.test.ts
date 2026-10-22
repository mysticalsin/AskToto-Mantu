import { describe, expect, it } from 'vitest'
import { MODIFIER_BITS } from './voice/modifier-mask'
import { DEFAULT_VOICE_ACTIONS_SETTINGS, VoiceActionsSettingsSchema, voiceChordMask } from './voice-actions-settings'
import {
  DICTATION_RELEASE_DEFAULT_ON,
  resolveDictationChordMask,
  resolveDictationEnabled,
  resolveDictationLatch
} from './dictation-options'

describe('dictation settings (G22)', () => {
  it('a profile saved before dictation existed loads with the dictation defaults', () => {
    const parsed = VoiceActionsSettingsSchema.parse({
      enabled: true,
      holdChord: DEFAULT_VOICE_ACTIONS_SETTINGS.holdChord
    })
    expect(parsed.dictation).toEqual(DEFAULT_VOICE_ACTIONS_SETTINGS.dictation)
    expect(parsed.dictation.enabled).toBeNull()
  })

  it('is a Preview feature: OFF in release builds, ON in QA builds, an explicit choice always wins', () => {
    expect(DICTATION_RELEASE_DEFAULT_ON).toBe(false)
    const fresh = DEFAULT_VOICE_ACTIONS_SETTINGS.dictation
    expect(resolveDictationEnabled(fresh, { qaIdentity: false })).toBe(false)
    expect(resolveDictationEnabled(fresh, { qaIdentity: true })).toBe(true)
    expect(resolveDictationEnabled({ ...fresh, enabled: true }, { qaIdentity: false })).toBe(true)
    expect(resolveDictationEnabled({ ...fresh, enabled: false }, { qaIdentity: true })).toBe(false)
    expect(resolveDictationEnabled(fresh, { qaIdentity: false, releaseDefaultOn: true })).toBe(true)
    expect(resolveDictationEnabled(undefined, { qaIdentity: false })).toBe(false)
  })

  it('dictation is independent of the voice actions switch', () => {
    const stored = { ...DEFAULT_VOICE_ACTIONS_SETTINGS, enabled: false }
    expect(resolveDictationEnabled(stored.dictation, { qaIdentity: true })).toBe(true)
  })

  it('defaults to Control+Fn on macOS (hold, or double-tap to latch) and a PROPOSED Left Ctrl + Left Alt on Windows', () => {
    const stored = DEFAULT_VOICE_ACTIONS_SETTINGS
    expect(resolveDictationChordMask(stored, 'darwin', 0)).toBe(MODIFIER_BITS.leftControl | MODIFIER_BITS.fn)
    expect(resolveDictationChordMask(stored, 'win32', 0)).toBe(MODIFIER_BITS.leftControl | MODIFIER_BITS.leftAlt)
    expect(resolveDictationChordMask(stored, 'linux', 0)).toBe(0)
  })

  it('the chord is configurable per platform', () => {
    const stored = VoiceActionsSettingsSchema.parse({
      dictation: { chord: { mac: ['rightControl', 'fn'], win: ['leftControl', 'leftShift', 'leftAlt'] } }
    })
    expect(resolveDictationChordMask(stored, 'darwin', 0)).toBe(MODIFIER_BITS.rightControl | MODIFIER_BITS.fn)
    expect(resolveDictationChordMask(stored, 'win32', 0)).toBe(
      MODIFIER_BITS.leftControl | MODIFIER_BITS.leftShift | MODIFIER_BITS.leftAlt
    )
  })

  it('rejects an unknown token or an empty chord', () => {
    expect(
      VoiceActionsSettingsSchema.safeParse({ dictation: { chord: { mac: ['capslock'], win: ['leftControl'] } } })
        .success
    ).toBe(false)
    expect(
      VoiceActionsSettingsSchema.safeParse({ dictation: { chord: { mac: [], win: ['leftControl'] } } }).success
    ).toBe(false)
  })

  it('a chord equal to the voice hold chord resolves to no chord at all (never two features on one hold)', () => {
    const voiceMask = voiceChordMask(['leftControl', 'fn'])
    expect(resolveDictationChordMask(DEFAULT_VOICE_ACTIONS_SETTINGS, 'darwin', voiceMask)).toBe(0)
  })

  it('the double-tap latch is on by default (the hands-free dictation gesture) and can be turned off', () => {
    expect(resolveDictationLatch(DEFAULT_VOICE_ACTIONS_SETTINGS.dictation)).toBe(true)
    expect(
      resolveDictationLatch(VoiceActionsSettingsSchema.parse({ dictation: { handsFreeLatch: false } }).dictation)
    ).toBe(false)
  })
})
