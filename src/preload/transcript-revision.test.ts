import { describe, expect, it, vi } from 'vitest'
import { createTranscriptRevisionPreloadApi } from './transcript-revision'

const CHANNEL = 'transcript:revision'
const A = 1_700_000_000_000
const B = 1_700_000_000_001

function makeRenderer() {
  const listeners: Array<(event: unknown, payload: unknown) => void> = []
  const on = vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) => {
    listeners.push(listener)
  })
  const removeListener = vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  })
  const emit = (payload: unknown) => {
    for (const l of [...listeners]) l({}, payload)
  }
  return { renderer: { on, removeListener } as never, on, removeListener, listeners, emit }
}

const segment = (i: number) => ({
  segmentId: `s${i}`,
  seq: i,
  channel: 'mic' as const,
  startMs: 0,
  endMs: 1,
  language: 'en',
  text: 'x',
  state: 'final' as const,
  source: 'provider' as const,
  relaySessionId: 'r'
})

const delta = (meetingStartedAt: number, revision: number) => ({
  meetingStartedAt,
  revision,
  changed: [segment(revision)],
  finalized: false
})

describe('transcript revision preload boundary', () => {
  it('delivers valid deltas and drops stale or replayed revisions per meeting', () => {
    const { renderer, emit } = makeRenderer()
    const cb = vi.fn()
    createTranscriptRevisionPreloadApi(renderer).onTranscriptRevision(cb)
    emit(delta(A, 1))
    emit(delta(A, 2))
    emit(delta(A, 2))
    emit(delta(A, 1))
    emit(delta(B, 1))
    expect(cb.mock.calls.map((c) => [c[0].meetingStartedAt, c[0].revision])).toEqual([
      [A, 1],
      [A, 2],
      [B, 1]
    ])
  })

  it('drops malformed payloads', () => {
    const { renderer, emit } = makeRenderer()
    const cb = vi.fn()
    createTranscriptRevisionPreloadApi(renderer).onTranscriptRevision(cb)
    emit(null)
    emit('nope')
    emit({ ...delta(A, 1), revision: -1 })
    emit({ ...delta(A, 1), extra: true })
    emit({ ...delta(A, 1), changed: Array.from({ length: 201 }, (_, i) => segment(i)) })
    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribe removes the listener once', () => {
    const { renderer, on, removeListener, emit } = makeRenderer()
    const cb = vi.fn()
    const unsub = createTranscriptRevisionPreloadApi(renderer).onTranscriptRevision(cb)
    unsub()
    unsub()
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener.mock.calls[0]?.[0]).toBe(CHANNEL)
    expect(removeListener.mock.calls[0]?.[1]).toBe(on.mock.calls[0]?.[1])
    emit(delta(A, 1))
    expect(cb).not.toHaveBeenCalled()
  })

  it('caps concurrent subscriptions', () => {
    const { renderer, on, removeListener } = makeRenderer()
    const api = createTranscriptRevisionPreloadApi(renderer)
    const unsubs = Array.from({ length: 8 }, () => api.onTranscriptRevision(vi.fn()))
    expect(on).toHaveBeenCalledTimes(8)
    const ninth = api.onTranscriptRevision(vi.fn())
    expect(on).toHaveBeenCalledTimes(8)
    ninth()
    expect(removeListener).not.toHaveBeenCalled()
    unsubs[0]?.()
    expect(removeListener).toHaveBeenCalledTimes(1)
    api.onTranscriptRevision(vi.fn())
    expect(on).toHaveBeenCalledTimes(9)
  })
})
