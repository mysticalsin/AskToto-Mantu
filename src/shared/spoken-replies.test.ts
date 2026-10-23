import { describe, expect, it } from 'vitest'
import {
  PreviewRequestSchema,
  SPOKEN_REPLIES_IPC,
  SpokenRepliesStateSchema,
  TtsVoiceListSchema,
  TtsVoiceSchema
} from './spoken-replies'

describe('spoken replies contract (G27)', () => {
  it('names namespaced channels', () => {
    for (const channel of Object.values(SPOKEN_REPLIES_IPC)) expect(channel).toMatch(/^spokenReplies:/)
    expect(new Set(Object.values(SPOKEN_REPLIES_IPC)).size).toBe(Object.keys(SPOKEN_REPLIES_IPC).length)
  })

  it('a voice is an id, a display name and a language, and nothing else', () => {
    expect(TtsVoiceSchema.safeParse({ id: 'v1', name: 'Samantha', language: 'en-US' }).success).toBe(true)
    expect(TtsVoiceSchema.safeParse({ id: 'v1', name: 'Samantha', language: 'en-US', extra: 1 }).success).toBe(false)
    expect(TtsVoiceSchema.safeParse({ id: '', name: 'x', language: 'en' }).success).toBe(false)
    expect(
      TtsVoiceListSchema.safeParse(Array.from({ length: 101 }, (_, i) => ({ id: `v${i}`, name: 'x', language: 'en' })))
        .success
    ).toBe(false)
  })

  it('the preview request carries an optional voice and rate only', () => {
    expect(PreviewRequestSchema.safeParse({}).success).toBe(true)
    expect(PreviewRequestSchema.safeParse({ voiceId: null, rate: 1.2 }).success).toBe(true)
    expect(PreviewRequestSchema.safeParse({ text: 'read my transcript' }).success).toBe(false)
  })

  it('the state snapshot names availability, playback, the muted reason and a generation', () => {
    const state = { revision: 3, available: true, playback: 'idle', muted: null, generation: 4 }
    expect(SpokenRepliesStateSchema.safeParse(state).success).toBe(true)
    expect(SpokenRepliesStateSchema.safeParse({ ...state, playback: 'looping' }).success).toBe(false)
    expect(SpokenRepliesStateSchema.safeParse({ ...state, muted: 'off' }).success).toBe(true)
    expect(SpokenRepliesStateSchema.safeParse({ ...state, muted: 'whatever' }).success).toBe(false)
  })
})
