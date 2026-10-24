import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_TRANSLATION_TARGET,
  LIVE_TRANSLATION_FEATURE,
  LIVE_TRANSLATION_TARGETS,
  LiveTranslationTargetSchema,
  TRANSLATION_MAX_RETRACT_IDS,
  TRANSLATION_MAX_TEXT,
  TranslationResetSchema,
  TranslationRetractSchema,
  TranslationSegmentSchema,
  TranslationStatusSchema
} from './live-translation'

const segment = {
  meetingStartedAt: 1_700_000_000_000,
  utteranceId: 'utt:1',
  revision: 1,
  target: 'en',
  text: 'Hello',
  lowConfidence: false
}

describe('live translation contracts', () => {
  it('offers off, English, French, Brazilian Portuguese and Spanish, default off', () => {
    expect([...LIVE_TRANSLATION_TARGETS]).toEqual(['off', 'en', 'fr', 'pt-BR', 'es'])
    expect(DEFAULT_LIVE_TRANSLATION_TARGET).toBe('off')
    expect(LiveTranslationTargetSchema.safeParse('de').success).toBe(false)
    expect(LiveTranslationTargetSchema.safeParse('pt').success).toBe(false)
    expect(Object.keys(LIVE_TRANSLATION_FEATURE.shape)).toEqual(['liveTranslationTarget'])
  })

  it('segment schema is strict and bounded', () => {
    expect(TranslationSegmentSchema.safeParse(segment).success).toBe(true)
    expect(TranslationSegmentSchema.safeParse({ ...segment, extra: 1 }).success).toBe(false)
    expect(TranslationSegmentSchema.safeParse({ ...segment, target: 'off' }).success).toBe(false)
    expect(TranslationSegmentSchema.safeParse({ ...segment, revision: 0 }).success).toBe(false)
    expect(TranslationSegmentSchema.safeParse({ ...segment, utteranceId: 'has space' }).success).toBe(false)
    expect(TranslationSegmentSchema.safeParse({ ...segment, text: '' }).success).toBe(false)
    expect(TranslationSegmentSchema.safeParse({ ...segment, text: 'x'.repeat(TRANSLATION_MAX_TEXT + 1) }).success).toBe(
      false
    )
  })

  it('retract, reset and status schemas are strict and bounded', () => {
    const base = { meetingStartedAt: segment.meetingStartedAt }
    expect(TranslationRetractSchema.safeParse({ ...base, utteranceIds: ['a'] }).success).toBe(true)
    expect(TranslationRetractSchema.safeParse({ ...base, utteranceIds: [] }).success).toBe(false)
    expect(
      TranslationRetractSchema.safeParse({
        ...base,
        utteranceIds: Array.from({ length: TRANSLATION_MAX_RETRACT_IDS + 1 }, (_, i) => `u${i}`)
      }).success
    ).toBe(false)
    expect(TranslationResetSchema.safeParse({ ...base, target: 'off' }).success).toBe(true)
    expect(TranslationResetSchema.safeParse({ ...base, target: 'xx' }).success).toBe(false)
    expect(TranslationStatusSchema.safeParse({ ...base, state: 'unavailable', message: 'x' }).success).toBe(true)
    expect(TranslationStatusSchema.safeParse({ ...base, state: 'on', message: 'x'.repeat(301) }).success).toBe(false)
    expect(TranslationStatusSchema.safeParse({ ...base, state: 'broken' }).success).toBe(false)
  })
})
