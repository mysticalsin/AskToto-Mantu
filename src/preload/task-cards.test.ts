import { describe, expect, it, vi } from 'vitest'
import { TASK_CARD_IPC, type TaskCardView } from '../shared/task-card'
import { createTaskCardsPreloadApi } from './task-cards'

const CARD: TaskCardView = {
  cardId: 'b'.repeat(32),
  actionId: 'desktop.open_notes',
  phase: 'queued',
  stoppable: true,
  dismissible: false
}

function fakeIpc(invokeResult: unknown = undefined) {
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
      invoke: vi.fn(async () => invokeResult)
    },
    push: (payload: unknown) => {
      for (const fn of [...(listeners.get(TASK_CARD_IPC.cards) ?? [])]) fn({}, payload)
    }
  }
}

describe('task cards preload bridge (G33)', () => {
  it('lists validated cards and returns [] for a malformed reply', async () => {
    expect(await createTaskCardsPreloadApi(fakeIpc([CARD]).ipc as never).taskCards.list()).toEqual([CARD])
    expect(
      await createTaskCardsPreloadApi(fakeIpc([{ ...CARD, taskId: 'leak' }]).ipc as never).taskCards.list()
    ).toEqual([])
    expect(await createTaskCardsPreloadApi(fakeIpc('nope').ipc as never).taskCards.list()).toEqual([])
  })

  it('stop and dismiss send the card id and normalise the reply to {ok}', async () => {
    const { ipc } = fakeIpc({ ok: true })
    const api = createTaskCardsPreloadApi(ipc as never).taskCards
    expect(await api.stop(CARD.cardId)).toEqual({ ok: true })
    expect(ipc.invoke).toHaveBeenLastCalledWith(TASK_CARD_IPC.stop, { cardId: CARD.cardId })
    expect(await api.dismiss(CARD.cardId)).toEqual({ ok: true })
    expect(ipc.invoke).toHaveBeenLastCalledWith(TASK_CARD_IPC.dismiss, { cardId: CARD.cardId })
    expect(await createTaskCardsPreloadApi(fakeIpc('weird').ipc as never).taskCards.stop(CARD.cardId)).toEqual({
      ok: false
    })
  })

  it('delivers valid pushed lists, drops invalid ones, and unsubscribes', () => {
    const { ipc, push } = fakeIpc()
    const seen: unknown[] = []
    const off = createTaskCardsPreloadApi(ipc as never).taskCards.onCards((cards) => seen.push(cards))
    push([CARD])
    push([{ ...CARD, cardId: 'short' }])
    push('x')
    expect(seen).toEqual([[CARD]])
    off()
    push([CARD])
    expect(seen).toHaveLength(1)
  })

  it('a throwing subscriber does not break the bridge', () => {
    const { ipc, push } = fakeIpc()
    createTaskCardsPreloadApi(ipc as never).taskCards.onCards(() => {
      throw new Error('boom')
    })
    expect(() => push([CARD])).not.toThrow()
  })
})
