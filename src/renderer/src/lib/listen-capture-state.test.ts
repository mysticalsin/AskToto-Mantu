import { describe, expect, it } from 'vitest'
import { createListenCaptureState, listenSpeechEngine } from './listen-capture-state'

describe('Listen capture contract state', () => {
  it.each([
    ['mic', ['microphone']],
    ['system', ['system']],
    ['both', ['microphone', 'system']]
  ] as const)('maps the %s source to its requested tracks without optimistic capture', (source, requestedTracks) => {
    const capture = createListenCaptureState()
    const result = capture.begin({ generation: 1, source, engine: 'whisper' })

    expect(result).toMatchObject({
      ok: true,
      state: { generation: 1, engine: 'whisper', requestedTracks, capturedTracks: [] }
    })
    expect(capture.current(1)?.capturedTracks).toEqual([])
  })

  it('records each channel only after a successful open and supports a degraded single-track capture', () => {
    const capture = createListenCaptureState()
    capture.begin({ generation: 4, source: 'both', engine: 'parakeet' })

    expect(capture.setCaptured(4, 'microphone', true)).toMatchObject({
      ok: true,
      state: { capturedTracks: ['microphone'] }
    })
    expect(capture.setCaptured(4, 'system', false)).toMatchObject({
      ok: true,
      state: { capturedTracks: ['microphone'] }
    })
    expect(capture.setCaptured(4, 'system', true)).toMatchObject({
      ok: true,
      state: { capturedTracks: ['microphone', 'system'] }
    })
    expect(capture.setCaptured(4, 'microphone', false)).toMatchObject({
      ok: true,
      state: { capturedTracks: ['system'] }
    })
  })

  it('ignores stale-generation updates without changing the current generation', () => {
    const capture = createListenCaptureState()
    capture.begin({ generation: 1, source: 'both', engine: 'whisper' })
    capture.begin({ generation: 2, source: 'mic', engine: 'apple' })

    expect(capture.setCaptured(1, 'system', true)).toEqual({ ok: false, reason: 'stale-generation' })
    expect(capture.current(2)).toMatchObject({ generation: 2, engine: 'apple', capturedTracks: [] })
  })

  it('maps actual cloud providers distinctly and refuses unknown or unconfigured engines', () => {
    expect(listenSpeechEngine('cloud', 'cloudflare-nova3')).toBe('cloudflare-nova3')
    expect(listenSpeechEngine('cloud', 'soniox')).toBe('soniox')
    expect(listenSpeechEngine('cloud', 'unconfigured')).toBeNull()
    expect(listenSpeechEngine('cloud', 'future-provider')).toBeNull()
    expect(listenSpeechEngine('parakeet')).toBe('parakeet')
    expect(listenSpeechEngine('future-local-engine')).toBeNull()
  })

  it('rejects invalid generation, source, engine, and current-generation track updates', () => {
    const invalid = createListenCaptureState()
    expect(invalid.begin({ generation: 0, source: 'mic', engine: 'whisper' })).toEqual({
      ok: false,
      reason: 'invalid-state'
    })
    expect(invalid.begin({ generation: 1, source: 'camera' as never, engine: 'whisper' })).toEqual({
      ok: false,
      reason: 'invalid-state'
    })
    expect(invalid.begin({ generation: 1, source: 'mic', engine: 'not-an-engine' })).toEqual({
      ok: false,
      reason: 'invalid-state'
    })

    const capture = createListenCaptureState()
    capture.begin({ generation: 1, source: 'mic', engine: 'whisper' })
    expect(capture.setCaptured(1, 'system', true)).toEqual({ ok: false, reason: 'invalid-state' })
    expect(capture.current(1)?.capturedTracks).toEqual([])
  })

  it('updates the engine to the actual supported fallback without inventing a fallback for unknown ids', () => {
    const capture = createListenCaptureState()
    capture.begin({ generation: 1, source: 'mic', engine: 'parakeet' })

    expect(capture.setEngine(1, 'whisper')).toMatchObject({
      ok: true,
      state: { engine: 'whisper' }
    })
    expect(capture.setEngine(1, 'future-engine')).toEqual({ ok: false, reason: 'invalid-state' })
    expect(capture.current(1)?.engine).toBe('whisper')
  })
})
