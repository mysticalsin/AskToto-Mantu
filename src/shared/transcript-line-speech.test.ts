import { describe, expect, it } from 'vitest'
import { TranscriptLineSchema, SaveMeetingSchema } from './ipc'

const speech = {
  type: 'segment' as const,
  captureId: '11111111-1111-4111-8111-111111111111',
  captureGeneration: 1,
  sequence: 1,
  segment: {
    stream: { generation: 1, track: 'system' as const, epoch: 1 },
    engine: 'deepgram-nova3' as const,
    index: 1,
    revision: 1,
    final: true,
    text: 'Hello bonjour',
    startMs: 0,
    endMs: 900
  },
  languages: ['en', 'fr'],
  words: [
    { text: 'Hello', startMs: 0, endMs: 400, language: 'en' },
    { text: 'bonjour', startMs: 500, endMs: 900, language: 'fr', speaker: 0 }
  ]
}

describe('persisted transcript speech provenance', () => {
  it('preserves actual multilingual words and stream identity through meeting validation', () => {
    const line = { speaker: 'them', text: speech.segment.text, t: 1000, speech }
    const parsed = SaveMeetingSchema.parse({ mode: 'meeting', startedAt: 1000, lines: [line, line] })
    expect(parsed.lines.map((item) => item.speech)).toEqual([speech, speech])
    expect(parsed.lines).toHaveLength(2)
    expect(parsed.lines[0].lang).toBeUndefined()
  })

  it('preserves legacy lines without adding guessed speech metadata', () => {
    const line = { speaker: 'unknown', text: 'fixture', t: 1000 }
    expect(TranscriptLineSchema.parse(line)).toEqual(line)
  })

  it('rejects interim, inconsistent text and outside-segment words in saved metadata', () => {
    const line = { speaker: 'them', text: speech.segment.text, t: 1000, speech }
    expect(TranscriptLineSchema.safeParse({ ...line, text: 'different' }).success).toBe(false)
    expect(
      TranscriptLineSchema.safeParse({ ...line, speech: { ...speech, segment: { ...speech.segment, final: false } } })
        .success
    ).toBe(false)
    expect(
      TranscriptLineSchema.safeParse({
        ...line,
        speech: { ...speech, words: [{ text: 'invalid', startMs: 0, endMs: 1000 }] }
      }).success
    ).toBe(false)
  })
})
