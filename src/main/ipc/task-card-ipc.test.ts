import { describe, expect, it, vi } from 'vitest'
import { TASK_CARD_IPC, type TaskCardView } from '@shared/task-card'
import { registerTaskCardIpc } from './task-card-ipc'

const CARD: TaskCardView = {
  cardId: 'a'.repeat(32),
  actionId: 'desktop.open_notes',
  phase: 'running',
  stoppable: true,
  dismissible: false
}

function setup(opts: { deny?: boolean; destroyed?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (event: unknown, raw?: unknown) => unknown) => handlers.set(channel, fn))
  }
  const assertMainWindow = vi.fn(() => {
    if (opts.deny) throw new Error('IPC denied')
  })
  let listener: () => void = () => {}
  const unsubscribe = vi.fn()
  const runtime = {
    cards: vi.fn(() => [CARD]),
    stopCard: vi.fn(() => true),
    dismissCard: vi.fn(() => true),
    onCardsChanged: vi.fn((fn: () => void) => {
      listener = fn
      return unsubscribe
    })
  }
  const send = vi.fn()
  const win = { isDestroyed: () => !!opts.destroyed, webContents: { id: 7, send } }
  const dispose = registerTaskCardIpc(ipcMain as never, assertMainWindow as never, runtime, () => win as never)
  return { handlers, assertMainWindow, runtime, send, fire: () => listener(), dispose, unsubscribe }
}
const event = { sender: { id: 7 } }

describe('task card IPC (G33)', () => {
  it('lists only the calling window owner and checks the sender first', () => {
    const { handlers, runtime, assertMainWindow } = setup()
    expect(handlers.get(TASK_CARD_IPC.list)?.(event)).toEqual([CARD])
    expect(assertMainWindow).toHaveBeenCalledWith(event)
    expect(runtime.cards).toHaveBeenCalledWith('webContents:7')
  })

  it('stop and dismiss validate the card id and scope to the owner', () => {
    const { handlers, runtime } = setup()
    expect(handlers.get(TASK_CARD_IPC.stop)?.(event, { cardId: CARD.cardId })).toEqual({ ok: true })
    expect(runtime.stopCard).toHaveBeenCalledWith('webContents:7', CARD.cardId)
    expect(handlers.get(TASK_CARD_IPC.dismiss)?.(event, { cardId: CARD.cardId })).toEqual({ ok: true })
    expect(runtime.dismissCard).toHaveBeenCalledWith('webContents:7', CARD.cardId)
  })

  it('rejects malformed input without touching the runtime', () => {
    const { handlers, runtime } = setup()
    for (const bad of [undefined, {}, { cardId: 'nope' }, { cardId: CARD.cardId, extra: 1 }, 'x']) {
      expect(handlers.get(TASK_CARD_IPC.stop)?.(event, bad)).toEqual({ ok: false })
      expect(handlers.get(TASK_CARD_IPC.dismiss)?.(event, bad)).toEqual({ ok: false })
    }
    expect(runtime.stopCard).not.toHaveBeenCalled()
    expect(runtime.dismissCard).not.toHaveBeenCalled()
  })

  it('a sender that fails the main-window check reaches nothing', () => {
    const { handlers, runtime } = setup({ deny: true })
    for (const channel of [TASK_CARD_IPC.list, TASK_CARD_IPC.stop, TASK_CARD_IPC.dismiss]) {
      expect(() => handlers.get(channel)?.(event, { cardId: CARD.cardId })).toThrow('IPC denied')
    }
    expect(runtime.cards).not.toHaveBeenCalled()
    expect(runtime.stopCard).not.toHaveBeenCalled()
    expect(runtime.dismissCard).not.toHaveBeenCalled()
  })

  it('pushes the owner window its own cards on change, and nothing to a destroyed window', () => {
    const live = setup()
    live.fire()
    expect(live.runtime.cards).toHaveBeenCalledWith('webContents:7')
    expect(live.send).toHaveBeenCalledWith(TASK_CARD_IPC.cards, [CARD])

    const gone = setup({ destroyed: true })
    gone.fire()
    expect(gone.send).not.toHaveBeenCalled()
  })

  it('dispose unsubscribes from the bridge', () => {
    const { dispose, unsubscribe } = setup()
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
