import { describe, expect, it, vi } from 'vitest'
import { createSessionContextPreloadApi } from './session-context'

describe('session context preload API', () => {
  it('sends a ledger line on its one channel and returns the content-free reply', async () => {
    const invoke = vi.fn(async () => ({ status: 'accepted' }))
    const api = createSessionContextPreloadApi({ invoke } as never)
    const line = {
      op: 'final',
      startedAt: 1_700_000_000_000,
      t: 1_700_000_000_005,
      speaker: 'you',
      text: 'hi'
    } as const
    await expect(api.appendSessionLedgerLine(line)).resolves.toEqual({ status: 'accepted' })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('session-context:appendLine', line)
  })

  it('exposes nothing that reads transcript text back', () => {
    const api = createSessionContextPreloadApi({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never)
    expect(Object.keys(api)).toEqual(['appendSessionLedgerLine', 'onSessionOutputsStale'])
  })

  describe('onSessionOutputsStale (G15)', () => {
    const setup = () => {
      const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
      const ipc = {
        invoke: vi.fn(),
        on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
          listeners.set(channel, listener)
        }),
        removeListener: vi.fn((channel: string) => void listeners.delete(channel))
      }
      return { ipc, listeners, api: createSessionContextPreloadApi(ipc as never) }
    }

    it('delivers only well-formed id lists from its channel and stops after unsubscribe', () => {
      const { ipc, listeners, api } = setup()
      const cb = vi.fn()
      const off = api.onSessionOutputsStale(cb)
      const emit = listeners.get('session-context:outputsStale')!
      emit({}, { ids: ['ask-1'] })
      emit({}, { ids: [] })
      emit({}, { ids: ['ask-2'], text: 'a transcript line' })
      emit({}, 'nonsense')
      expect(cb.mock.calls).toEqual([[{ ids: ['ask-1'] }]])
      off()
      expect(ipc.removeListener).toHaveBeenCalledWith('session-context:outputsStale', expect.any(Function))
    })

    it('a throwing subscriber never breaks the bridge', () => {
      const { listeners, api } = setup()
      api.onSessionOutputsStale(() => {
        throw new Error('subscriber bug')
      })
      expect(() => listeners.get('session-context:outputsStale')!({}, { ids: ['a'] })).not.toThrow()
    })
  })
})
