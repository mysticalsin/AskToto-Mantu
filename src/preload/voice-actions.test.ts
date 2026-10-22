import { describe, expect, it, vi } from 'vitest'
import { VOICE_ACTIONS_IPC } from '../shared/voice/voice-turn'
import { createVoiceActionsPreloadApi } from './voice-actions'

function fakeIpc() {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()
  return {
    listeners,
    ipc: {
      on: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        set.add(fn)
        listeners.set(channel, set)
      }),
      removeListener: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) => {
        listeners.get(channel)?.delete(fn)
      }),
      invoke: vi.fn(async () => undefined)
    },
    push: (channel: string, payload: unknown) => {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, payload)
    }
  }
}

describe('voice actions preload bridge', () => {
  it('delivers a valid begin and end and drops anything malformed', () => {
    const { ipc, push } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    const begins: unknown[] = []
    const ends: unknown[] = []
    api.onBegin((v) => begins.push(v))
    api.onEnd((v) => ends.push(v))
    push(VOICE_ACTIONS_IPC.begin, { turnId: 't1', maxMs: 15_000 })
    push(VOICE_ACTIONS_IPC.begin, { turnId: 't1', maxMs: 15_000, extra: true })
    push(VOICE_ACTIONS_IPC.begin, { turnId: '', maxMs: 15_000 })
    push(VOICE_ACTIONS_IPC.begin, 'nope')
    push(VOICE_ACTIONS_IPC.end, { turnId: 't1', cancelled: false })
    push(VOICE_ACTIONS_IPC.end, { turnId: 't1' })
    expect(begins).toEqual([{ turnId: 't1', maxMs: 15_000 }])
    expect(ends).toEqual([{ turnId: 't1', cancelled: false }])
  })

  it('delivers a begin that names the dictation or command purpose and drops any other purpose (G22)', () => {
    const { ipc, push } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    const begins: unknown[] = []
    api.onBegin((v) => begins.push(v))
    push(VOICE_ACTIONS_IPC.begin, { turnId: 'd1', maxMs: 15_000, purpose: 'dictation' })
    push(VOICE_ACTIONS_IPC.begin, { turnId: 'c1', maxMs: 15_000, purpose: 'command' })
    push(VOICE_ACTIONS_IPC.begin, { turnId: 'x1', maxMs: 15_000, purpose: 'conversation' })
    push(VOICE_ACTIONS_IPC.begin, { turnId: 'x2', maxMs: 15_000, purpose: 'meeting' })
    expect(begins).toEqual([
      { turnId: 'd1', maxMs: 15_000, purpose: 'dictation' },
      { turnId: 'c1', maxMs: 15_000, purpose: 'command' }
    ])
  })

  it('delivers a valid recognized question and drops anything malformed or oversized (V03)', () => {
    const { ipc, push } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    const asks: unknown[] = []
    api.onAsk((v) => asks.push(v))
    push(VOICE_ACTIONS_IPC.ask, { turnId: 't1', text: 'what is the capital of Portugal' })
    push(VOICE_ACTIONS_IPC.ask, { turnId: 't1', text: 'x', action: 'desktop.open_notes' })
    push(VOICE_ACTIONS_IPC.ask, { turnId: 't1', text: '' })
    push(VOICE_ACTIONS_IPC.ask, { turnId: 't1', text: 'x'.repeat(2_001) })
    push(VOICE_ACTIONS_IPC.ask, 'nope')
    expect(asks).toEqual([{ turnId: 't1', text: 'what is the capital of Portugal' }])
  })

  it('unsubscribes, and a throwing subscriber does not break delivery', () => {
    const { ipc, push, listeners } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    const seen: unknown[] = []
    api.onEnd(() => {
      throw new Error('subscriber failed')
    })
    const off = api.onEnd((v) => seen.push(v))
    push(VOICE_ACTIONS_IPC.end, { turnId: 't1', cancelled: true })
    expect(seen).toHaveLength(1)
    off()
    push(VOICE_ACTIONS_IPC.end, { turnId: 't1', cancelled: true })
    expect(seen).toHaveLength(1)
    expect(listeners.get(VOICE_ACTIONS_IPC.end)?.size).toBe(1)
  })

  it('getState returns a valid snapshot and null for anything else', async () => {
    const { ipc } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    const snapshot = {
      revision: 1,
      state: 'idle',
      turnId: null,
      reason: null,
      message: null,
      enabled: true,
      shortcut: 'running'
    }
    ipc.invoke.mockResolvedValueOnce(snapshot as never)
    await expect(api.getState()).resolves.toEqual(snapshot)
    ipc.invoke.mockResolvedValueOnce({ ...snapshot, state: 'bogus' } as never)
    await expect(api.getState()).resolves.toBeNull()
  })

  it('exposes report and the chord recorder flag as the only renderer-to-main calls, and nothing that starts a turn or mints an activation', () => {
    const { ipc } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    expect(Object.keys(api).sort()).toEqual([
      'getState',
      'onAsk',
      'onBegin',
      'onEnd',
      'onState',
      'report',
      'setChordRecorderActive'
    ])
    void api.report({ turnId: 't1', phase: 'capturing' })
    expect(ipc.invoke).toHaveBeenCalledWith(VOICE_ACTIONS_IPC.report, { turnId: 't1', phase: 'capturing' })
  })

  it('the chord recorder flag sends exactly { active } and nothing else', () => {
    const { ipc } = fakeIpc()
    const api = createVoiceActionsPreloadApi(ipc as never).voiceActions
    void api.setChordRecorderActive(true)
    expect(ipc.invoke).toHaveBeenCalledWith(VOICE_ACTIONS_IPC.recorder, { active: true })
    void api.setChordRecorderActive(false)
    expect(ipc.invoke).toHaveBeenLastCalledWith(VOICE_ACTIONS_IPC.recorder, { active: false })
  })
})
