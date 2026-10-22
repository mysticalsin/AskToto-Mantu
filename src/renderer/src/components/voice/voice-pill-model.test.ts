import { describe, expect, it } from 'vitest'
import type { VoiceStateSnapshot } from '@shared/voice/voice-turn'
import {
  VOICE_DONE_HOLD_MS,
  VOICE_HINT_USES,
  VOICE_UNCERTAIN_HOLD_MS,
  voiceCueFor,
  voicePillView,
  voicePillVisible
} from './voice-pill-model'

const snap = (patch: Partial<VoiceStateSnapshot>): VoiceStateSnapshot => ({
  revision: 1,
  state: 'idle',
  turnId: 't1',
  reason: null,
  message: null,
  enabled: true,
  shortcut: 'running',
  ...patch
})

describe('voice pill view (V05, design §1.4)', () => {
  it('shows nothing when off, idle, disabled or before main has said anything', () => {
    expect(voicePillView(null, 0)).toBeNull()
    expect(voicePillView(snap({ state: 'idle' }), 0)).toBeNull()
    expect(voicePillView(snap({ state: 'off' }), 0)).toBeNull()
    expect(voicePillVisible(snap({ state: 'listening', enabled: false }))).toBe(false)
  })

  it('listening shows the let-go hint for the first three uses only', () => {
    const first = voicePillView(snap({ state: 'listening' }), 0)
    expect(first).toMatchObject({ glyph: 'listening', title: 'Listening…', detail: "Let go when you're done" })
    expect(voicePillView(snap({ state: 'listening' }), VOICE_HINT_USES)?.detail).toBeNull()
  })

  it('thinking and executing use the working contour; main owns the action wording', () => {
    expect(voicePillView(snap({ state: 'thinking' }), 9)).toMatchObject({ glyph: 'working', title: 'Working on it…' })
    expect(voicePillView(snap({ state: 'executing', message: 'Opening Notes…' }), 9)?.title).toBe('Opening Notes…')
  })

  it('done holds 1.2 s, uncertain stays up to 8 s and never offers a retry', () => {
    const done = voicePillView(snap({ state: 'done', message: 'Opened Notes' }), 9)
    expect(done).toMatchObject({ glyph: 'done', title: 'Opened Notes', holdMs: VOICE_DONE_HOLD_MS })
    const uncertain = voicePillView(snap({ state: 'uncertain' }), 9)
    expect(uncertain).toMatchObject({ glyph: 'info', holdMs: VOICE_UNCERTAIN_HOLD_MS })
    expect(`${uncertain?.title} ${uncertain?.detail}`).not.toMatch(/retry|try again/i)
  })

  it('failed shows main fixed reason copy, never an "Error"', () => {
    const view = voicePillView(
      snap({
        state: 'failed',
        reason: 'meeting_recording',
        message: 'Voice actions are paused while Métis records a meeting. Type your request instead.'
      }),
      9
    )
    expect(view?.title).toMatch(/paused while Métis records a meeting/)
    expect(view?.title).not.toMatch(/\berror\b/i)
  })

  it('copy is sentence case with no em dash', () => {
    for (const state of ['listening', 'thinking', 'done', 'failed', 'uncertain'] as const) {
      const view = voicePillView(snap({ state }), 0)
      expect(`${view?.title} ${view?.detail ?? ''}`).not.toMatch(/—/)
    }
  })
})

describe('voice cues (design §1.7)', () => {
  it('listen at the hold, send on release, ready on done, error on failure, nothing else', () => {
    expect(voiceCueFor(null, 'listening')).toBe('listen')
    expect(voiceCueFor('listening', 'thinking')).toBe('send')
    expect(voiceCueFor('executing', 'done')).toBe('ready')
    expect(voiceCueFor('thinking', 'failed')).toBe('error')
    expect(voiceCueFor('thinking', 'executing')).toBeNull()
    expect(voiceCueFor('done', 'done')).toBeNull()
  })
})
