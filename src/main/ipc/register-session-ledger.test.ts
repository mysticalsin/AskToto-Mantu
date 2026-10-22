import { describe, expect, it, vi } from 'vitest'
import { SESSION_CONTEXT_IPC } from '@shared/session-context-request'
import { registerSessionLedgerIpc } from './register-session-ledger'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'

const STARTED = 1_700_000_000_000

type Handler = (event: unknown, raw: unknown) => { status: string }

function harness(options: { signedIn?: boolean; accept?: boolean } = {}) {
  let handler: Handler | undefined
  const channels: string[] = []
  const ipcMain = {
    handle: vi.fn((channel: string, fn: Handler) => {
      channels.push(channel)
      handler = fn
    })
  }
  const authorizeSender = vi.fn(() => null) as unknown as AuthorizeSender & ReturnType<typeof vi.fn>
  const registry = {
    ingestLocalLine: vi.fn(() => options.accept !== false),
    retractLocalLine: vi.fn(() => options.accept !== false)
  }
  registerSessionLedgerIpc({
    ipcMain,
    authorizeSender,
    requireAuth: () => options.signedIn !== false,
    registry
  })
  const event = (processId = 7, routingId = 3) => ({
    sender: { id: 1 },
    senderFrame: { parent: null, url: 'app://main', processId, routingId }
  })
  const invoke = (raw: unknown, ev: unknown = event()) => {
    if (!handler) throw new Error('handler not registered')
    return handler(ev, raw)
  }
  return { channels, authorizeSender, registry, invoke, event }
}

const final = { op: 'final', startedAt: STARTED, t: STARTED + 5, speaker: 'them', text: 'a local sentence' }

describe('session-context:appendLine IPC', () => {
  it('registers exactly one channel and gates the sender as an audited main-window top frame', () => {
    const h = harness()
    expect(h.channels).toEqual([SESSION_CONTEXT_IPC.appendLine])
    expect(SESSION_CONTEXT_IPC.appendLine).toBe('session-context:appendLine')
    h.invoke(final)
    expect(h.authorizeSender).toHaveBeenCalledWith(expect.objectContaining({ senderFrame: expect.anything() }), {
      surface: 'sessionContext.appendLine',
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
  })

  it('refuses a sender the authorizer rejects before it reads the payload', () => {
    const h = harness()
    h.authorizeSender.mockImplementation(() => {
      throw new SenderRefusal('wrong-window', 'sessionContext.appendLine')
    })
    expect(() => h.invoke(final)).toThrow('IPC refused: wrong-window')
    expect(h.registry.ingestLocalLine).not.toHaveBeenCalled()
  })

  it('refuses when signed out', () => {
    const h = harness({ signedIn: false })
    expect(h.invoke(final)).toEqual({ status: 'refused' })
    expect(h.registry.ingestLocalLine).not.toHaveBeenCalled()
  })

  it('takes the frame from the IPC sender, never from the payload, and replies content-free', () => {
    const h = harness()
    const reply = h.invoke({ ...final, processId: 1, routingId: 1 }, h.event(7, 3))
    // An unknown key is refused outright: the payload cannot name a frame.
    expect(reply).toEqual({ status: 'refused' })
    expect(h.registry.ingestLocalLine).not.toHaveBeenCalled()
    expect(h.invoke(final, h.event(12, 5))).toEqual({ status: 'accepted' })
    expect(h.registry.ingestLocalLine).toHaveBeenCalledWith(
      expect.objectContaining({ processId: 12, routingId: 5 }),
      expect.objectContaining({ startedAt: STARTED, text: 'a local sentence' })
    )
  })

  it('routes a retraction to the registry and reports a refusal without saying why', () => {
    const h = harness({ accept: false })
    expect(h.invoke({ op: 'retract', startedAt: STARTED, t: STARTED + 5 })).toEqual({ status: 'refused' })
    expect(h.registry.retractLocalLine).toHaveBeenCalledWith(expect.anything(), {
      op: 'retract',
      startedAt: STARTED,
      t: STARTED + 5
    })
  })

  it.each([
    ['empty text', { ...final, text: '' }],
    ['oversized text', { ...final, text: 'x'.repeat(16_385) }],
    ['bad speaker', { ...final, speaker: 'admin' }],
    ['non-integer start', { ...final, startedAt: 1.5 }],
    ['unknown op', { ...final, op: 'rewrite' }],
    ['not an object', 'text']
  ])('refuses a malformed payload: %s', (_name, raw) => {
    const h = harness()
    expect(h.invoke(raw)).toEqual({ status: 'refused' })
    expect(h.registry.ingestLocalLine).not.toHaveBeenCalled()
  })

  it('refuses when the event carries no frame', () => {
    const h = harness()
    expect(h.invoke(final, { sender: { id: 1 }, senderFrame: null })).toEqual({ status: 'refused' })
  })
})
