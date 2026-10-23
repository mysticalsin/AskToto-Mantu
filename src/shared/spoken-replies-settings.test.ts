import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'
import {
  DEFAULT_SPOKEN_REPLIES_SETTINGS,
  SPEECH_RATE_DEFAULT,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPOKEN_REPLIES_FEATURE,
  SpokenRepliesSettingsSchema,
  clampSpeechRate
} from './spoken-replies-settings'
import { findSetting } from './settings-registry'

describe('spoken replies settings (G27)', () => {
  it('ships OFF by default with the system voice and the normal rate (a hardware and audio Preview feature)', () => {
    expect(DEFAULT_SPOKEN_REPLIES_SETTINGS).toEqual({ speakReplies: false, voiceId: null, rate: 1 })
    expect(SpokenRepliesSettingsSchema.parse({})).toEqual(DEFAULT_SPOKEN_REPLIES_SETTINGS)
    expect(DEFAULT_SETTINGS.spokenReplies).toEqual(DEFAULT_SPOKEN_REPLIES_SETTINGS)
    expect(BaseSettingsSchema.shape.spokenReplies.parse(undefined).speakReplies).toBe(false)
  })

  it('clamps the rate to 0.5 to 1.5 and falls back to 1 for anything that is not a finite number', () => {
    expect([SPEECH_RATE_MIN, SPEECH_RATE_MAX, SPEECH_RATE_DEFAULT]).toEqual([0.5, 1.5, 1])
    expect(clampSpeechRate(0.1)).toBe(0.5)
    expect(clampSpeechRate(9)).toBe(1.5)
    expect(clampSpeechRate(1.25)).toBe(1.25)
    expect(clampSpeechRate(Number.NaN)).toBe(1)
    expect(clampSpeechRate(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampSpeechRate('2' as unknown as number)).toBe(1)
    expect(SpokenRepliesSettingsSchema.parse({ rate: 0 }).rate).toBe(0.5)
    expect(SpokenRepliesSettingsSchema.parse({ rate: 7 }).rate).toBe(1.5)
    expect(SpokenRepliesSettingsSchema.parse({ rate: 'fast' }).rate).toBe(1)
  })

  it('an older settings file without the key loads with the defaults, and a malformed value never fails the whole file', () => {
    const { spokenReplies: _omitted, ...older } = DEFAULT_SETTINGS
    expect(BaseSettingsSchema.parse(older).spokenReplies).toEqual(DEFAULT_SPOKEN_REPLIES_SETTINGS)
    const parsed = BaseSettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      spokenReplies: { speakReplies: true, rate: 99, voiceId: 'v1' }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.spokenReplies).toEqual({ speakReplies: true, rate: 1.5, voiceId: 'v1' })
  })

  it('is a G09 feature module owned by "spoken-replies", visible in the registry, and writable by the renderer', () => {
    expect(SPOKEN_REPLIES_FEATURE.id).toBe('spoken-replies')
    expect(SPOKEN_REPLIES_FEATURE.mainOnlyKeys).toEqual([])
    const entry = findSetting('spokenReplies')
    expect(entry?.owner).toBe('spoken-replies')
    expect(entry?.mainOnly).toBe(false)
  })
})
