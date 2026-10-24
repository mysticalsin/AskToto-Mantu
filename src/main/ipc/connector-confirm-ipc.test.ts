import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_CONFIRM_IPC } from '@shared/connector-confirm'
import { registerConnectorConfirmIpc } from './connector-confirm-ipc'

type Handler = (event: unknown, payload?: unknown) => unknown
const DECISION = { proposalId: 'a'.repeat(32), nonce: 'b'.repeat(64), argsHash: 'c'.repeat(64), confirm: true }

function setup(over: { auth?: boolean; reject?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: vi.fn((channel: string, h: Handler) => handlers.set(channel, h)) }
  const assertMainWindow = vi.fn(() => {
    if (over.reject) throw new Error('not the main window')
  })
  const broker = {
    current: vi.fn(() => ({ proposalId: null })),
    decide: vi.fn(() => ({ ok: true })),
    cancel: vi.fn(() => true)
  }
  registerConnectorConfirmIpc(ipcMain as never, {
    assertMainWindow,
    requireAuth: () => over.auth ?? true,
    broker: broker as never
  })
  const invoke = (channel: string, payload?: unknown, senderId = 7) =>
    handlers.get(channel)?.({ sender: { id: senderId } }, payload)
  return { invoke, assertMainWindow, broker }
}

describe('connector confirm IPC', () => {
  it('rejects a non-main window on every channel', () => {
    const s = setup({ reject: true })
    for (const channel of Object.values(CONNECTOR_CONFIRM_IPC).filter((c) => !c.endsWith(':state'))) {
      expect(() => s.invoke(channel, DECISION)).toThrow()
    }
    expect(s.broker.decide).not.toHaveBeenCalled()
  })

  it('takes the owner from the sender, not the payload', async () => {
    const s = setup()
    await s.invoke(CONNECTOR_CONFIRM_IPC.decide, { ...DECISION, webContentsId: 99 }, 7)
    // The strict schema rejects a payload-supplied owner outright.
    expect(s.broker.decide).not.toHaveBeenCalled()
    await s.invoke(CONNECTOR_CONFIRM_IPC.decide, DECISION, 7)
    expect(s.broker.decide).toHaveBeenCalledWith({ ...DECISION, webContentsId: 7 })
    s.invoke(CONNECTOR_CONFIRM_IPC.cancel, { proposalId: DECISION.proposalId, nonce: DECISION.nonce }, 7)
    expect(s.broker.cancel).toHaveBeenCalledWith({
      proposalId: DECISION.proposalId,
      nonce: DECISION.nonce,
      webContentsId: 7
    })
  })

  it('returns no card and accepts no decision when signed out', async () => {
    const s = setup({ auth: false })
    expect(s.invoke(CONNECTOR_CONFIRM_IPC.current)).toEqual({ proposalId: null })
    expect(await s.invoke(CONNECTOR_CONFIRM_IPC.decide, DECISION)).toEqual({ ok: false, reason: 'auth_required' })
    expect(s.broker.current).not.toHaveBeenCalled()
    expect(s.broker.decide).not.toHaveBeenCalled()
  })
})
