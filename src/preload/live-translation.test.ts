import { describe, expect, it, vi } from 'vitest'
import { TRANSLATION_IPC, TRANSLATION_MAX_SUBSCRIPTIONS } from '../shared/live-translation'
import { createLiveTranslationPreloadApi, type LiveTranslationEvent } from './live-translation'

const M = 1_700_000_000_000

function renderer() {
  const listeners = new Map<string, Array<(event: unknown, payload: unknown) => void>>()
  const on = vi.fn((channel: string, l: (event: unknown, payload: unknown) => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), l])
  })
  const removeListener = vi.fn((channel: string, l: (event: unknown, payload: unknown) => void) => {
    listeners.set(
      channel,
      (listeners.get(channel) ?? []).filter((x) => x !== l)
    )
  })
  const emit = (channel: string, payload: unknown): void => {
    for (const l of [...(listeners.get(channel) ?? [])]) l({}, payload)
  }
  return { ipc: { on, removeListener } as never, emit, listeners }
}

const segment = (revision: number, text = 'Hello') => ({
  meetingStartedAt: M,
  utteranceId: 'u1',
  revision,
  target: 'en',
  text,
  lowConfidence: false
})

describe('live translation preload (G73)', () => {
  it('malformed payloads are dropped', () => {
    const r = renderer()
    const cb = vi.fn()
    createLiveTranslationPreloadApi(r.ipc).onTranslation(cb)
    r.emit(TRANSLATION_IPC.segment, { ...segment(1), extra: true })
    r.emit(TRANSLATION_IPC.segment, 'nope')
    r.emit(TRANSLATION_IPC.retract, { meetingStartedAt: M, utteranceIds: [] })
    r.emit(TRANSLATION_IPC.reset, { meetingStartedAt: M, target: 'xx' })
    r.emit(TRANSLATION_IPC.status, { meetingStartedAt: M, state: 'bad' })
    expect(cb).not.toHaveBeenCalled()
  })

  it('older or equal revisions are ignored; a reset forgets them', () => {
    const r = renderer()
    const events: LiveTranslationEvent[] = []
    createLiveTranslationPreloadApi(r.ipc).onTranslation((e) => events.push(e))
    r.emit(TRANSLATION_IPC.segment, segment(2, 'two'))
    r.emit(TRANSLATION_IPC.segment, segment(1, 'one late'))
    r.emit(TRANSLATION_IPC.segment, segment(2, 'two again'))
    r.emit(TRANSLATION_IPC.segment, segment(3, 'three'))
    expect(events.map((e) => (e.kind === 'segment' ? e.text : e.kind))).toEqual(['two', 'three'])
    r.emit(TRANSLATION_IPC.reset, { meetingStartedAt: M, target: 'fr' })
    r.emit(TRANSLATION_IPC.segment, { ...segment(1, 'un'), target: 'fr' })
    expect(events.map((e) => (e.kind === 'segment' ? e.text : e.kind))).toEqual(['two', 'three', 'reset', 'un'])
  })

  it('forwards retract and status, and a throwing subscriber is contained', () => {
    const r = renderer()
    const cb = vi.fn(() => {
      throw new Error('subscriber bug')
    })
    createLiveTranslationPreloadApi(r.ipc).onTranslation(cb)
    r.emit(TRANSLATION_IPC.retract, { meetingStartedAt: M, utteranceIds: ['u1'] })
    r.emit(TRANSLATION_IPC.status, { meetingStartedAt: M, state: 'unavailable', message: 'x' })
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('caps subscribers and removes every listener on unsubscribe', () => {
    const r = renderer()
    const api = createLiveTranslationPreloadApi(r.ipc)
    const stops = Array.from({ length: TRANSLATION_MAX_SUBSCRIPTIONS }, () => api.onTranslation(() => undefined))
    const extra = vi.fn()
    api.onTranslation(extra)()
    r.emit(TRANSLATION_IPC.reset, { meetingStartedAt: M, target: 'en' })
    expect(extra).not.toHaveBeenCalled()
    for (const stop of stops) stop()
    for (const list of r.listeners.values()) expect(list).toHaveLength(0)
    expect(() => stops[0]()).not.toThrow()
  })
})
