import { describe, expect, it, vi } from 'vitest'
import { DICTATION_STATUS_IPC } from '../shared/dictation-status'
import { createDictationStatusPreloadApi } from './dictation-status'

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
    push: (payload: unknown) => {
      for (const fn of [...(listeners.get(DICTATION_STATUS_IPC.state) ?? [])]) fn({}, payload)
    },
    listeners
  }
}

const status = (revision: number, state = 'listening') => ({ revision, state, message: null, enabled: true })

describe('dictation status preload bridge (G30)', () => {
  it('delivers valid pushes and drops malformed or extra-field ones', () => {
    const { ipc, push } = fakeIpc()
    const cb = vi.fn()
    createDictationStatusPreloadApi(ipc as never).dictationStatus.onState(cb)
    push(status(1))
    push({ ...status(2), text: 'what I said' })
    push({ ...status(3), state: 'recording' })
    push('nope')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(status(1))
  })

  it('keeps the highest revision: a stale push or reply is dropped', async () => {
    const { ipc, push } = fakeIpc({ [DICTATION_STATUS_IPC.getState]: status(2, 'idle') })
    const api = createDictationStatusPreloadApi(ipc as never).dictationStatus
    const cb = vi.fn()
    api.onState(cb)
    push(status(5, 'thinking'))
    push(status(4))
    expect(cb).toHaveBeenCalledTimes(1)
    await expect(api.getState()).resolves.toBeNull()
  })

  it('reads the current status, and returns null for a malformed reply', async () => {
    const good = createDictationStatusPreloadApi(fakeIpc({ [DICTATION_STATUS_IPC.getState]: status(1) }).ipc as never)
    await expect(good.dictationStatus.getState()).resolves.toEqual(status(1))
    const bad = createDictationStatusPreloadApi(fakeIpc({ [DICTATION_STATUS_IPC.getState]: { x: 1 } }).ipc as never)
    await expect(bad.dictationStatus.getState()).resolves.toBeNull()
  })

  it('unsubscribes, and a throwing subscriber does not break the bridge', () => {
    const { ipc, push, listeners } = fakeIpc()
    const api = createDictationStatusPreloadApi(ipc as never).dictationStatus
    const unsub = api.onState(() => {
      throw new Error('boom')
    })
    expect(() => push(status(1))).not.toThrow()
    unsub()
    expect(listeners.get(DICTATION_STATUS_IPC.state)?.size).toBe(0)
  })

  it('exposes only read calls', () => {
    expect(Object.keys(createDictationStatusPreloadApi(fakeIpc().ipc as never).dictationStatus).sort()).toEqual([
      'getState',
      'onState'
    ])
  })
})
