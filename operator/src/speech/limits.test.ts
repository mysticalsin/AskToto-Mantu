import { describe, expect, it } from 'vitest'
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_CLIENT_MESSAGES,
  MAX_INPUT_BYTES_PER_TRACK,
  MAX_OUTPUT_BYTES_PER_TRACK,
  MAX_OUTPUT_FRAME_BYTES,
  MAX_PROVIDER_MESSAGES,
  RESERVED_TERMINAL_BYTES,
  createSpeechStreamBudget,
  enqueueSpeechAudio,
  finishSpeechAudio,
  accountSpeechOutput
} from './limits'

describe('speech stream application bounds', () => {
  it('stops admitting audio before the fixed lease drain window', () => {
    const budget = createSpeechStreamBudget(0, 60_000)
    expect(enqueueSpeechAudio(budget, 1, 54_999)).toMatchObject({ ok: true })
    finishSpeechAudio(budget, 1)
    expect(enqueueSpeechAudio(budget, 1, 55_000)).toMatchObject({ ok: false, code: 'LEASE_DRAINING' })
  })

  it('bounds client frame size, pending bytes, total bytes and message count', () => {
    const frame = createSpeechStreamBudget(0, 60_000)
    expect(enqueueSpeechAudio(frame, MAX_CLIENT_FRAME_BYTES + 1, 1)).toMatchObject({
      ok: false,
      code: 'FRAME_TOO_LARGE'
    })

    const pending = createSpeechStreamBudget(0, 60_000)
    expect(enqueueSpeechAudio(pending, 40_000, 1)).toMatchObject({ ok: true })
    expect(enqueueSpeechAudio(pending, 25_537, 2)).toMatchObject({ ok: false, code: 'PENDING_LIMIT' })

    const bytes = createSpeechStreamBudget(0, 60_000)
    for (let i = 0; i < 29; i++) {
      expect(enqueueSpeechAudio(bytes, MAX_CLIENT_FRAME_BYTES, 1)).toMatchObject({ ok: true })
      finishSpeechAudio(bytes, MAX_CLIENT_FRAME_BYTES)
    }
    expect(enqueueSpeechAudio(bytes, 19_456, 1)).toMatchObject({ ok: true })
    finishSpeechAudio(bytes, 19_456)
    expect(enqueueSpeechAudio(bytes, 1, 1)).toMatchObject({ ok: false, code: 'INPUT_LIMIT' })

    const messages = createSpeechStreamBudget(0, 60_000)
    for (let i = 0; i < MAX_CLIENT_MESSAGES; i++) {
      expect(enqueueSpeechAudio(messages, 1, 1)).toMatchObject({ ok: true })
      finishSpeechAudio(messages, 1)
    }
    expect(enqueueSpeechAudio(messages, 1, 1)).toMatchObject({ ok: false, code: 'MESSAGE_LIMIT' })
  })

  it('bounds normalized provider output size and message count', () => {
    const frame = createSpeechStreamBudget(0, 60_000)
    expect(accountSpeechOutput(frame, MAX_OUTPUT_FRAME_BYTES + 1)).toMatchObject({
      ok: false,
      code: 'OUTPUT_FRAME_LIMIT'
    })

    const bytes = createSpeechStreamBudget(0, 60_000)
    for (let i = 0; i < 15; i++) expect(accountSpeechOutput(bytes, MAX_OUTPUT_FRAME_BYTES)).toMatchObject({ ok: true })
    const remainingOutputBytes = MAX_OUTPUT_BYTES_PER_TRACK - RESERVED_TERMINAL_BYTES - bytes.outputBytes
    expect(accountSpeechOutput(bytes, remainingOutputBytes)).toMatchObject({ ok: true })
    expect(accountSpeechOutput(bytes, 1)).toMatchObject({ ok: false, code: 'OUTPUT_LIMIT' })
    expect(MAX_OUTPUT_BYTES_PER_TRACK).toBe(1_048_576)
    expect(MAX_INPUT_BYTES_PER_TRACK).toBe(1_920_000)

    const messages = createSpeechStreamBudget(0, 60_000)
    for (let i = 0; i < MAX_PROVIDER_MESSAGES; i++) expect(accountSpeechOutput(messages, 1)).toMatchObject({ ok: true })
    expect(accountSpeechOutput(messages, 1)).toMatchObject({ ok: false, code: 'MESSAGE_LIMIT' })
  })
})
