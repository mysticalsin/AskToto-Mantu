import { describe, expect, it, vi } from 'vitest'
import { SPOKEN_REPLIES_IPC } from '../shared/spoken-replies'
import { createSpokenRepliesPreloadApi } from './spoken-replies'

function fakeIpc(responses: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()
  return {
    ipc: {
      on: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        set.add(fn)
        listeners.set(channel, set)
      }),
      removeListener: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) => {
        listeners.get(channel)?.delete(fn)
      }),
      invoke: vi.fn(async (channel: string) => responses[channel])
    },
    push: (channel: string, payload: unknown) => {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, payload)
    },
    listeners
  }
}

const STATE = { revision: 2, available: true, playback: 'idle', muted: null, generation: 5 }

describe('spoken replies preload bridge (G27)', () => {
  it('delivers a valid state and drops anything malformed', () => {
    const { ipc, push } = fakeIpc()
    const api = createSpokenRepliesPreloadApi(ipc as never).spokenReplies
    const seen: unknown[] = []
    api.onState((state) => seen.push(state))
    push(SPOKEN_REPLIES_IPC.state, STATE)
    push(SPOKEN_REPLIES_IPC.state, { ...STATE, playback: 'looping' })
    push(SPOKEN_REPLIES_IPC.state, { ...STATE, text: 'extra' })
    push(SPOKEN_REPLIES_IPC.state, 'nope')
    expect(seen).toEqual([STATE])
  })

  it('unsubscribes, and a throwing subscriber does not break the bridge', () => {
    const { ipc, push, listeners } = fakeIpc()
    const api = createSpokenRepliesPreloadApi(ipc as never).spokenReplies
    const seen: unknown[] = []
    api.onState(() => {
      throw new Error('bug')
    })
    const off = api.onState((state) => seen.push(state))
    push(SPOKEN_REPLIES_IPC.state, STATE)
    expect(seen).toHaveLength(1)
    off()
    expect(listeners.get(SPOKEN_REPLIES_IPC.state)?.size).toBe(1)
  })

  it('validates what main returns: state, voices and the preview result', async () => {
    const { ipc } = fakeIpc({
      [SPOKEN_REPLIES_IPC.getState]: STATE,
      [SPOKEN_REPLIES_IPC.voices]: [
        { id: 'v1', name: 'One', language: 'en-US' },
        { id: '', name: 'bad', language: 'x' }
      ],
      [SPOKEN_REPLIES_IPC.preview]: { ok: true }
    })
    const api = createSpokenRepliesPreloadApi(ipc as never).spokenReplies
    await expect(api.getState()).resolves.toEqual(STATE)
    await expect(api.voices()).resolves.toEqual([])
    await expect(api.preview({ voiceId: 'v1', rate: 1 })).resolves.toEqual({ ok: true })
    expect(ipc.invoke).toHaveBeenCalledWith(SPOKEN_REPLIES_IPC.preview, { voiceId: 'v1', rate: 1 })
  })

  it('a missing or malformed answer is null, an empty list and not ok', async () => {
    const { ipc } = fakeIpc({ [SPOKEN_REPLIES_IPC.getState]: { nope: 1 }, [SPOKEN_REPLIES_IPC.preview]: 'x' })
    const api = createSpokenRepliesPreloadApi(ipc as never).spokenReplies
    await expect(api.getState()).resolves.toBeNull()
    await expect(api.voices()).resolves.toEqual([])
    await expect(api.preview({})).resolves.toEqual({ ok: false })
  })

  it('exposes no way to hand main text to speak', () => {
    const { ipc } = fakeIpc()
    const api = createSpokenRepliesPreloadApi(ipc as never).spokenReplies
    expect(Object.keys(api).sort()).toEqual(['getState', 'onState', 'preview', 'stop', 'voices'])
    expect(api.preview.length).toBeLessThanOrEqual(1)
  })
})
