import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_CHOICE_IPC } from '@shared/connector-account-choice'
import { registerAccountChoiceIpc } from './connector-account-choice-ipc'

type Handler = (event: unknown, payload?: unknown) => unknown
const REF = `acct_${'A'.repeat(43)}`
const DECISION = { choiceId: 'a'.repeat(32), nonce: 'b'.repeat(64), argsHash: 'c'.repeat(64), accountRef: REF }

function setup(over: { auth?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: vi.fn((channel: string, h: Handler) => handlers.set(channel, h)) }
  const assertMainWindow = vi.fn()
  const broker = {
    current: vi.fn(() => ({ choiceId: null })),
    decide: vi.fn(async () => ({ ok: true, result: { ok: true } })),
    cancel: vi.fn(() => true)
  }
  registerAccountChoiceIpc(ipcMain as never, {
    assertMainWindow,
    requireAuth: () => over.auth ?? true,
    broker: broker as never
  })
  const invoke = (channel: string, payload?: unknown, senderId = 7) =>
    handlers.get(channel)?.({ sender: { id: senderId } }, payload)
  return { invoke, assertMainWindow, broker }
}

describe('account choice IPC', () => {
  it('checks the main window on every channel and takes the owner from the sender', async () => {
    const s = setup()
    await s.invoke(ACCOUNT_CHOICE_IPC.current, undefined, 11)
    await s.invoke(ACCOUNT_CHOICE_IPC.decide, DECISION, 12)
    await s.invoke(ACCOUNT_CHOICE_IPC.cancel, { choiceId: DECISION.choiceId, nonce: DECISION.nonce }, 13)
    expect(s.assertMainWindow).toHaveBeenCalledTimes(3)
    expect(s.broker.current).toHaveBeenCalledWith(11)
    expect(s.broker.decide).toHaveBeenCalledWith({ ...DECISION, webContentsId: 12 })
    expect(s.broker.cancel).toHaveBeenCalledWith({
      choiceId: DECISION.choiceId,
      nonce: DECISION.nonce,
      webContentsId: 13
    })
  })

  it('ignores an owner smuggled into the payload', async () => {
    const s = setup()
    expect(await s.invoke(ACCOUNT_CHOICE_IPC.decide, { ...DECISION, webContentsId: 99 })).toEqual({
      ok: false,
      reason: 'invalid_input'
    })
    expect(s.broker.decide).not.toHaveBeenCalled()
  })

  it('refuses without sign-in and on malformed input before reaching the broker', async () => {
    const s = setup({ auth: false })
    expect(await s.invoke(ACCOUNT_CHOICE_IPC.decide, DECISION)).toEqual({ ok: false, reason: 'auth_required' })
    expect(await s.invoke(ACCOUNT_CHOICE_IPC.current)).toEqual({ choiceId: null })
    expect(s.broker.decide).not.toHaveBeenCalled()
    expect(s.broker.current).not.toHaveBeenCalled()
    const t = setup()
    expect(await t.invoke(ACCOUNT_CHOICE_IPC.cancel, { choiceId: 'x' })).toEqual({ ok: false })
    expect(t.broker.cancel).not.toHaveBeenCalled()
  })
})
