import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_IPC, type ConversationCaptureBegin, type ConversationAsk } from '@shared/conversation/conversation-session'
import { AskStartSchema, IPC } from '@shared/ipc'
import { InputSessionAuthority } from '../../input-session-authority'
import { commandMicOwner, type CommandMicActivationFrame } from '../../command-mic-activation-authority'
import { createConversationRuntime } from './conversation-runtime'
import { COMMAND_SPEECH_FINALIZATION_GRACE_MS, COMMAND_SPEECH_MAX_FRAME_SAMPLES, COMMAND_SPEECH_SAMPLE_RATE } from '../../command-speech-capture'

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => unknown

const ownerFrame: CommandMicActivationFrame = {
  webContentsId: 51,
  frameId: '1:3',
  isTopFrame: true,
  url: 'app://metis'
}
const context = { authSessionGeneration: 2, contextRevision: 3 }
const owner = commandMicOwner(ownerFrame, context)!
const event = {
  sender: { id: ownerFrame.webContentsId },
  senderFrame: { parent: null, url: ownerFrame.url, processId: 1, routingId: 3 }
} as unknown as IpcMainInvokeEvent

function harness() {
  const handlers = new Map<string, Handler>()
  const sent: Array<{ channel: string; payload: unknown }> = []
  const cancelAsk = vi.fn()
  let currentContext = context
  const authority = new InputSessionAuthority({ token: () => 'a'.repeat(48), now: () => 1_000_000 })
  const runtime = createConversationRuntime({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as Handler) } },
    assertMainWindow: () => {},
    frameFromEvent: (rawEvent) => {
      const senderFrame = rawEvent.senderFrame
      return senderFrame ? {
        webContentsId: rawEvent.sender.id,
        frameId: `${senderFrame.processId}:${senderFrame.routingId}`,
        isTopFrame: senderFrame.parent === null,
        url: senderFrame.url
      } : null
    },
    mainFrame: () => ownerFrame,
    currentContext: () => currentContext,
    getSettings: () => ({ voiceActions: { enabled: true, conversation: { enabled: true } } as never }),
    qaIdentity: true,
    requireAuth: () => true,
    isClosing: () => false,
    meetingReserved: () => false,
    onboardingActive: () => false,
    window: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { id: ownerFrame.webContentsId, send: (channel, payload) => sent.push({ channel, payload }) }
    }),
    availability: () => ({ ok: true }),
    authority,
    ensureParakeet: vi.fn(async () => {}),
    transcribe: vi.fn(async () => 'recognized phrase'),
    cancelAsk
  })
  runtime.registerIpc()
  const invoke = async (channel: string, payload?: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing IPC handler: ${channel}`)
    return handler(event, payload)
  }
  return { runtime, authority, sent, cancelAsk, invoke, setContext: (value: typeof context) => { currentContext = value } }
}

async function beginCapture(h: ReturnType<typeof harness>): Promise<{
  begin: ConversationCaptureBegin
  binding: { sessionId: string; captureToken: string }
}> {
  expect(await h.invoke(CONVERSATION_IPC.startActivationObserved)).toBe(true)
  expect(await h.invoke(CONVERSATION_IPC.start)).toMatchObject({ ok: true })
  const beginMessage = h.sent.find((message) => message.channel === CONVERSATION_IPC.captureBegin)
  expect(beginMessage).toBeDefined()
  const begin = beginMessage!.payload as ConversationCaptureBegin
  expect(h.runtime.authorizeInputStart(event, owner, begin.captureToken)).toBe(true)
  const admission = h.authority.start(owner, { source: 'push-to-talk', purpose: 'conversation', activation: 'explicit' })
  expect(admission.ok).toBe(true)
  if (!admission.ok) throw new Error('conversation input lease was refused')
  expect(h.runtime.bindInputLease(owner, begin.captureToken, admission.lease)).toBe(true)
  expect(h.authority.claimPermissionRequest(owner)).toBe(true)
  expect(h.authority.confirmCapture(owner, admission.lease.sessionId)).toBe(true)
  return { begin, binding: { sessionId: begin.sessionId, captureToken: begin.captureToken } }
}

async function sendFullSampleBudget(
  h: ReturnType<typeof harness>,
  binding: { sessionId: string; captureToken: string },
  seconds: number
): Promise<number> {
  const maxSamples = seconds * COMMAND_SPEECH_SAMPLE_RATE
  let sequence = 0
  let sent = 0
  while (sent < maxSamples) {
    const size = Math.min(COMMAND_SPEECH_MAX_FRAME_SAMPLES, maxSamples - sent)
    expect(await h.invoke(CONVERSATION_IPC.captureFrame, {
      ...binding, sequence, samples: new Float32Array(size)
    })).toMatchObject({ ok: true })
    sequence++
    sent += size
  }
  return sequence
}

async function captureOneUtterance(h: ReturnType<typeof harness>): Promise<ConversationAsk> {
  const { binding } = await beginCapture(h)
  expect(await h.invoke(CONVERSATION_IPC.captureStart, { ...binding, maxSeconds: 10 })).toMatchObject({ ok: true })
  expect(await h.invoke(CONVERSATION_IPC.captureFrame, { ...binding, sequence: 0, samples: new Float32Array([0.25]) }))
    .toMatchObject({ ok: true })
  expect(await h.invoke(CONVERSATION_IPC.captureFinish, { ...binding, frameCount: 1 })).toMatchObject({ ok: true })
  const ask = h.sent.find((message) => message.channel === CONVERSATION_IPC.ask)?.payload
  if (!ask) throw new Error('recognized capture did not produce a main-issued Ask')
  return ask as ConversationAsk
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

describe('G28 main capture and Ask binding', () => {
  it('rejects a renderer capture duration longer than the main-issued window and revokes its lease', async () => {
    const h = harness()
    const { begin, binding } = await beginCapture(h)
    expect(begin.maxMs).toBe(10_000)

    expect(await h.invoke(CONVERSATION_IPC.captureStart, { ...binding, maxSeconds: 15 })).toMatchObject({ ok: false })
    expect(h.authority.activeLease).toBeNull()
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureCancel)).toHaveLength(1)
    expect(h.runtime.session.snapshot().active).toBe(true)
  })

  it('allows the full audio sample budget to finish during grace without extending the audio cap', async () => {
    const h = harness()
    const { binding } = await beginCapture(h)
    expect(await h.invoke(CONVERSATION_IPC.captureStart, { ...binding, maxSeconds: 10 })).toMatchObject({ ok: true })
    const frameCount = await sendFullSampleBudget(h, binding, 10)

    vi.advanceTimersByTime(10_000)
    expect(h.authority.activeLease).not.toBeNull()
    vi.advanceTimersByTime(750)
    expect(await h.invoke(CONVERSATION_IPC.captureFinish, { ...binding, frameCount })).toMatchObject({ ok: true })
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureCancel)).toHaveLength(0)
  })

  it('rejects PCM beyond the strict sample cap even while sealing grace remains', async () => {
    const h = harness()
    const { binding } = await beginCapture(h)
    expect(await h.invoke(CONVERSATION_IPC.captureStart, { ...binding, maxSeconds: 10 })).toMatchObject({ ok: true })
    const frameCount = await sendFullSampleBudget(h, binding, 10)

    vi.advanceTimersByTime(10_750)

    expect(await h.invoke(CONVERSATION_IPC.captureFrame, {
      ...binding, sequence: frameCount, samples: new Float32Array([0.25])
    })).toMatchObject({ ok: false })
    expect(h.authority.activeLease).toBeNull()
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureCancel)).toHaveLength(1)
  })

  it('revokes capture and stops the renderer when the main-issued sealing grace expires', async () => {
    const h = harness()
    const { binding } = await beginCapture(h)
    expect(await h.invoke(CONVERSATION_IPC.captureStart, { ...binding, maxSeconds: 10 })).toMatchObject({ ok: true })

    vi.advanceTimersByTime(10_000)
    expect(h.authority.activeLease).not.toBeNull()
    vi.advanceTimersByTime(COMMAND_SPEECH_FINALIZATION_GRACE_MS)

    expect(h.authority.activeLease).toBeNull()
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureCancel)).toHaveLength(1)
    expect(h.runtime.session.snapshot().active).toBe(true)
  })

  it('rejects PCM beyond the main-issued sample budget even when it arrives before the wall-clock deadline', async () => {
    const h = harness()
    const { binding } = await beginCapture(h)
    expect(await h.invoke(CONVERSATION_IPC.captureStart, { ...binding, maxSeconds: 10 })).toMatchObject({ ok: true })
    const samples = new Float32Array(2_048)
    for (let sequence = 0; sequence < 78; sequence++) {
      expect(await h.invoke(CONVERSATION_IPC.captureFrame, { ...binding, sequence, samples })).toMatchObject({ ok: true })
    }

    expect(await h.invoke(CONVERSATION_IPC.captureFrame, { ...binding, sequence: 78, samples })).toMatchObject({ ok: false })
    expect(h.authority.activeLease).toBeNull()
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureCancel)).toHaveLength(1)
  })

  it('reopens capture when the main-issued spoken Ask event is not accepted by the renderer', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    expect(h.runtime.session.snapshot().state).toBe('thinking')

    vi.advanceTimersByTime(5_000)
    vi.advanceTimersByTime(400)

    expect(h.runtime.session.snapshot().state).toBe('listening')
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureBegin)).toHaveLength(2)
    const late = AskStartSchema.parse({
      id: 'late-spoken-ask', mode: 'answer', prompt: ask.text, inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })
    expect(h.runtime.authorizeAsk(event, late)).toBe(false)
  })
  it('accepts only the exact main-recognized text once for the active owner and reply generation', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    const forged = AskStartSchema.parse({
      id: 'spoken-ask-1', mode: 'answer', prompt: 'renderer substituted text', inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })
    expect(h.runtime.authorizeAsk(event, forged)).toBe(false)

    const exact = AskStartSchema.parse({
      ...forged, prompt: ask.text
    })
    expect(h.runtime.authorizeAsk(event, exact)).toBe(true)
    expect(h.runtime.authorizeAsk(event, exact)).toBe(false)
    expect(h.runtime.authorizeAsk({ ...event, sender: { id: 52 } } as IpcMainInvokeEvent, exact)).toBe(false)
  })

  it('does not expire an accepted Ask while its first reply is still being prepared', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    const request = AskStartSchema.parse({
      id: 'spoken-ask-delayed-reply', mode: 'answer', prompt: ask.text, inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })
    expect(h.runtime.authorizeAsk(event, request)).toBe(true)

    vi.advanceTimersByTime(5_000)

    expect(h.cancelAsk).not.toHaveBeenCalled()
    expect(h.runtime.session.snapshot()).toMatchObject({ active: true, state: 'thinking' })
    h.runtime.onReplyLifecycle({ phase: 'started', askId: request.id, generation: ask.replyGeneration })
    expect(h.runtime.session.snapshot().state).toBe('replying')
  })

  it('returns to listening after an accepted spoken Ask fails before the handoff deadline without later cancellation', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    const request = AskStartSchema.parse({
      id: 'spoken-ask-fails-before-handoff-deadline', mode: 'answer', prompt: ask.text,
      inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })
    expect(h.runtime.authorizeAsk(event, request)).toBe(true)

    h.runtime.observeAsk({
      type: 'event', id: request.id, channel: IPC.streamError,
      payload: { id: request.id, message: 'The answer could not be generated.' }
    })
    vi.advanceTimersByTime(5_000)

    expect(h.cancelAsk).not.toHaveBeenCalled()
    expect(h.runtime.session.snapshot()).toMatchObject({ active: true, state: 'listening' })
  })

  it('rejects a captured Ask after its owner context changes and never requests its cancellation', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    const staleRequest = AskStartSchema.parse({
      id: 'spoken-ask-from-stale-owner', mode: 'answer', prompt: ask.text,
      inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })

    h.setContext({ ...context, contextRevision: context.contextRevision + 1 })
    h.runtime.refresh()
    expect(h.runtime.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'renderer_reset' })
    expect(h.runtime.authorizeAsk(event, staleRequest)).toBe(false)
    expect(h.runtime.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'renderer_reset' })
    h.runtime.onReplyLifecycle({
      phase: 'started', askId: staleRequest.id, generation: ask.replyGeneration
    })
    expect(h.runtime.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'renderer_reset' })
    h.runtime.onReplyLifecycle({
      phase: 'settled', askId: staleRequest.id, generation: ask.replyGeneration, outcome: 'finished'
    })
    expect(h.runtime.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'renderer_reset' })
    vi.advanceTimersByTime(5_000)

    expect(h.cancelAsk).not.toHaveBeenCalled()
    expect(h.runtime.session.snapshot()).toMatchObject({ active: false, state: 'idle' })
  })

  it('keeps the microphone closed until the bound G27 reply settles', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    const request = AskStartSchema.parse({
      id: 'spoken-ask-2', mode: 'answer', prompt: ask.text, inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })
    expect(h.runtime.authorizeAsk(event, request)).toBe(true)
    h.runtime.onReplyLifecycle({ phase: 'started', askId: request.id, generation: ask.replyGeneration })
    expect(h.runtime.session.snapshot().state).toBe('replying')
    vi.advanceTimersByTime(2_000)
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureBegin)).toHaveLength(1)

    h.runtime.onReplyLifecycle({ phase: 'settled', askId: request.id, generation: ask.replyGeneration, outcome: 'finished' })
    vi.advanceTimersByTime(400)
    expect(h.sent.filter((message) => message.channel === CONVERSATION_IPC.captureBegin)).toHaveLength(2)
    expect(h.runtime.session.snapshot().state).toBe('listening')
  })

  it('Stop cancels only the Ask owned by the current conversation reply', async () => {
    const h = harness()
    const ask = await captureOneUtterance(h)
    const request = AskStartSchema.parse({
      id: 'spoken-ask-3', mode: 'answer', prompt: ask.text, inputOrigin: 'user-spoken-by-owner',
      conversationReply: { sessionId: ask.sessionId, replyGeneration: ask.replyGeneration }
    })
    expect(h.runtime.authorizeAsk(event, request)).toBe(true)
    expect(await h.invoke(CONVERSATION_IPC.stop)).toMatchObject({ ok: true })
    expect(h.cancelAsk).toHaveBeenCalledOnce()
    expect(h.cancelAsk).toHaveBeenCalledWith(request.id)
    expect(h.runtime.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'user_stop' })
  })
})
