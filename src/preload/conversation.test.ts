import { describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_IPC,
  ConversationAskSchema,
  ConversationCaptureBeginSchema,
  ConversationCaptureFailureSchema,
  ConversationCaptureStartSchema,
  ConversationSnapshotSchema
} from '../shared/conversation/conversation-session'
import { IPC } from '../shared/ipc'
import { createConversationPreloadApi } from './conversation'

function harness() {
  const handlers = new Map<string, (event: unknown, payload: unknown) => void>()
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === CONVERSATION_IPC.startActivationObserved) return true
    if (channel === CONVERSATION_IPC.replyFinished) return true
    if (channel === IPC.inputSessionStart) return { ok: false, reason: 'busy' }
    return { ok: true }
  })
  const ipc = {
    invoke,
    on: vi.fn((channel: string, cb: (e: unknown, p: unknown) => void) => {
      handlers.set(channel, cb)
    }),
    removeListener: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
  const button = {
    tagName: 'BUTTON',
    type: 'button',
    disabled: false,
    isConnected: true,
    hasAttribute: (name: string) => name === 'data-metis-conversation-start',
    getClientRects: () => ({ length: 1 })
  }
  let click: ((event: { isTrusted: boolean; composedPath(): unknown[] }) => void) | undefined
  const doc = {
    addEventListener: (
      _type: 'click',
      cb: (event: { isTrusted: boolean; composedPath(): unknown[] }) => void,
      _capture: boolean
    ) => {
      click = cb
    },
    querySelectorAll: () => ({ length: 1 })
  }
  return {
    api: createConversationPreloadApi(ipc as never, doc),
    invoke,
    handlers,
    ipc,
    click: (isTrusted = true) => click?.({ isTrusted, composedPath: () => [button] })
  }
}

describe('conversation preload bridge', () => {
  it('requires a trusted marked click before starting', async () => {
    const h = harness()
    expect((await h.api.conversation.start()).ok).toBe(false)
    h.click(false)
    expect((await h.api.conversation.start()).ok).toBe(false)
    h.click()
    expect((await h.api.conversation.start()).ok).toBe(true)
    expect(h.invoke).toHaveBeenCalledWith(CONVERSATION_IPC.start)
  })

  it('hardcodes explicit conversation push-to-talk and binds the capture nonce', async () => {
    const h = harness()
    await h.api.conversation.startCapture('1:1', { authSessionGeneration: 2, contextRevision: 3 })
    expect(h.invoke).toHaveBeenCalledWith(IPC.inputSessionStart, {
      input: { source: 'push-to-talk', purpose: 'conversation', activation: 'explicit' },
      context: { authSessionGeneration: 2, contextRevision: 3 },
      conversationCaptureToken: '1:1'
    })
  })

  it('carries the dispatched window and bounds its start by command capture limits', () => {
    expect(
      ConversationCaptureBeginSchema.safeParse({ sessionId: 's1', captureToken: '1:2', maxMs: 10_000 }).success
    ).toBe(true)
    expect(
      ConversationCaptureBeginSchema.safeParse({ sessionId: 's1', captureToken: '1:2', maxMs: 15_001 }).success
    ).toBe(false)
    expect(
      ConversationCaptureStartSchema.safeParse({ sessionId: 's1', captureToken: '1:2', maxSeconds: 10 }).success
    ).toBe(true)
    expect(
      ConversationCaptureStartSchema.safeParse({ sessionId: 's1', captureToken: '1:2', maxSeconds: 16 }).success
    ).toBe(false)
    expect(
      ConversationCaptureFailureSchema.safeParse({ sessionId: 's1', captureToken: '1:2', reason: 'no_speech' }).success
    ).toBe(true)
    expect(
      ConversationCaptureFailureSchema.safeParse({ sessionId: 's1', captureToken: '1:2', reason: 'busy' }).success
    ).toBe(false)
  })

  it('validates snapshots and ask payloads, and removes the exact listener on unsubscribe', () => {
    const h = harness()
    const state = vi.fn()
    const unsub = h.api.conversation.onState(state)
    const snapshot = {
      revision: 1,
      state: 'idle',
      active: false,
      stopAvailable: false,
      sessionId: null,
      startedAt: null,
      idleExpiresAt: null,
      maxExpiresAt: null,
      replyGeneration: 0,
      limits: { idleMs: 300_000, maxMs: 1_800_000, status: 'PROPOSED' },
      reason: null,
      message: null,
      enabled: true
    }
    expect(ConversationSnapshotSchema.safeParse(snapshot).success).toBe(true)
    h.handlers.get(CONVERSATION_IPC.state)?.({}, snapshot)
    h.handlers.get(CONVERSATION_IPC.state)?.({}, { ...snapshot, transcript: 'must not pass' })
    expect(state).toHaveBeenCalledExactlyOnceWith(snapshot)
    const listener = h.handlers.get(CONVERSATION_IPC.state)
    expect(listener).toBeTypeOf('function')
    unsub()
    expect(h.ipc.removeListener).toHaveBeenCalledWith(CONVERSATION_IPC.state, listener)
    expect(h.handlers.has(CONVERSATION_IPC.state)).toBe(false)

    const ask = vi.fn()
    h.api.conversation.onAsk(ask)
    const validAsk = { sessionId: 's1', replyGeneration: 3, text: 'recognized text' }
    h.handlers.get(CONVERSATION_IPC.ask)?.({}, validAsk)
    h.handlers.get(CONVERSATION_IPC.ask)?.({}, { ...validAsk, text: 'x'.repeat(2001) })
    expect(ConversationAskSchema.safeParse(validAsk).success).toBe(true)
    expect(ask).toHaveBeenCalledExactlyOnceWith(validAsk)
  })

  it('validates capture finish payload and returns a typed result without transcript fields', async () => {
    const h = harness()
    const binding = { sessionId: 's1', captureToken: '1:1' }
    await expect(h.api.conversation.captureFinish(binding, 2)).resolves.toEqual({ ok: true })
    expect(h.invoke).toHaveBeenCalledWith(CONVERSATION_IPC.captureFinish, { ...binding, frameCount: 2 })
    h.invoke.mockResolvedValueOnce({ ok: true, transcript: 'private utterance' })
    await expect(h.api.conversation.captureFinish(binding, 2)).resolves.toEqual({
      ok: false,
      reason: 'recognition_unavailable'
    })
    const before = h.invoke.mock.calls.length
    await expect(h.api.conversation.captureFinish(binding, -1)).resolves.toEqual({
      ok: false,
      reason: 'recognition_unavailable'
    })
    expect(h.invoke).toHaveBeenCalledTimes(before)
  })

  it('returns parsed input-session results and rejects malformed input context before IPC', async () => {
    const h = harness()
    await expect(
      h.api.conversation.startCapture('1:1', { authSessionGeneration: 2, contextRevision: 3 })
    ).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(h.invoke).toHaveBeenCalledWith(IPC.inputSessionStart, {
      input: { source: 'push-to-talk', purpose: 'conversation', activation: 'explicit' },
      context: { authSessionGeneration: 2, contextRevision: 3 },
      conversationCaptureToken: '1:1'
    })
    const before = h.invoke.mock.calls.length
    await expect(
      h.api.conversation.startCapture('', { authSessionGeneration: -1, contextRevision: 3 })
    ).resolves.toEqual({ ok: false, reason: 'invalid_request' })
    expect(h.invoke).toHaveBeenCalledTimes(before)
  })
})
