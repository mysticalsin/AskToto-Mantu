import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { TtsPlaybackHandlers, TtsAdapter } from './features/spoken-replies/tts-adapter'
import {
  createSpokenReplies,
  type ReplyLifecycleEvent,
  type SpokenRepliesDeps
} from './features/spoken-replies/spoken-replies-service'
import {
  createSpokenRepliesRuntime,
  type SpokenRepliesRuntimeDeps
} from './features/spoken-replies/spoken-replies-runtime'
import { createAskTurns } from './features/session-context/ask-turn'

vi.mock('./logger', () => ({ auditLog: vi.fn() }))

const VOICE = { id: 'com.apple.ttsbundle.Samantha-compact', name: 'Samantha', language: 'en-US' }
const settleTurnWork = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('ask stream to spoken-reply composition (G27)', () => {
  it('cancelling by ask id after streamDone stops a reply still waiting for voice enumeration', async () => {
    let resolveVoices!: (voices: (typeof VOICE)[]) => void
    const voices = new Promise<(typeof VOICE)[]>((resolve) => {
      resolveVoices = resolve
    })
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(() => voices),
      speak: vi.fn(() => ({ cancel: vi.fn() }))
    }
    const lifecycle: ReplyLifecycleEvent[] = []
    const deps = {
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false,
      onReplyLifecycle: (event: ReplyLifecycleEvent) => lifecycle.push(event)
    } satisfies SpokenRepliesDeps
    const replies = createSpokenReplies(deps)
    const turns = createAskTurns({ send: () => undefined, streams: new Map(), observe: replies.observeAsk })
    const turn = await turns.begin({ id: 'cancel-before-enumeration', mode: 'answer', handle: null })
    const generation = replies.snapshot().generation
    expect(lifecycle).toEqual([{ phase: 'pending', askId: 'cancel-before-enumeration', generation }])

    turn?.send(IPC.streamDelta, { id: 'cancel-before-enumeration', text: 'Synthetic answer.' })
    turn?.send(IPC.streamDone, { id: 'cancel-before-enumeration' })
    expect(lifecycle).toContainEqual({ phase: 'pending', askId: 'cancel-before-enumeration', generation })
    turns.cancel('cancel-before-enumeration')
    expect(lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'cancel-before-enumeration', generation, outcome: 'cancelled' }
    ])
    resolveVoices([VOICE])
    await replies.listVoices()
    await settleTurnWork()

    expect(adapter.speak).not.toHaveBeenCalled()
    expect(replies.snapshot().playback).toBe('idle')
    replies.dispose()
  })

  it('cancelling by ask id after the answer is actively playing stops that playback once', async () => {
    const cancel = vi.fn()
    const playbackHandlers: TtsPlaybackHandlers[] = []
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(async () => [VOICE]),
      speak: vi.fn((_request, handlers) => {
        playbackHandlers.push(handlers)
        return { cancel }
      })
    }
    const lifecycle: ReplyLifecycleEvent[] = []
    const deps = {
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false,
      onReplyLifecycle: (event: ReplyLifecycleEvent) => lifecycle.push(event)
    } satisfies SpokenRepliesDeps
    const replies = createSpokenReplies(deps)
    const turns = createAskTurns({ send: () => undefined, streams: new Map(), observe: replies.observeAsk })
    const turn = await turns.begin({ id: 'active-answer', mode: 'answer', handle: null })
    const generation = replies.snapshot().generation
    turn?.send(IPC.streamDelta, { id: 'active-answer', text: 'Synthetic active answer.' })
    turn?.send(IPC.streamDone, { id: 'active-answer' })
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledOnce())

    turns.cancel('active-answer')
    playbackHandlers[0]?.onEnded('finished')

    expect(replies.snapshot().playback).toBe('idle')
    expect(cancel).toHaveBeenCalledOnce()
    expect(lifecycle.filter((event) => event.phase === 'settled')).toEqual([
      { phase: 'settled', askId: 'active-answer', generation, outcome: 'cancelled' }
    ])
    replies.dispose()
  })

  it('cancelling an older still-pending ask cannot interrupt the current reply', async () => {
    const cancel = vi.fn()
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(async () => [VOICE]),
      speak: vi.fn(() => ({ cancel }))
    }
    const replies = createSpokenReplies({
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false
    })
    const turns = createAskTurns({ send: () => undefined, streams: new Map(), observe: replies.observeAsk })
    const old = await turns.begin({ id: 'old-pending-answer', mode: 'answer', handle: null })
    old?.send(IPC.streamDelta, { id: 'old-pending-answer', text: 'Older partial answer.' })
    const current = await turns.begin({ id: 'current-answer', mode: 'answer', handle: null })
    current?.send(IPC.streamDelta, { id: 'current-answer', text: 'Current answer.' })
    current?.send(IPC.streamDone, { id: 'current-answer' })
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledOnce())

    turns.cancel('old-pending-answer')

    expect(replies.snapshot().playback).toBe('reply')
    expect(cancel).not.toHaveBeenCalled()
    replies.dispose()
  })

  it('an old answer cancellation cannot interrupt the newer answer or an explicit preview', async () => {
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(async () => [VOICE]),
      speak: vi.fn(() => ({ cancel: vi.fn() }))
    }
    const replies = createSpokenReplies({
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false
    })
    const turns = createAskTurns({ send: () => undefined, streams: new Map(), observe: replies.observeAsk })
    const old = await turns.begin({ id: 'old-answer', mode: 'answer', handle: null })
    old?.send(IPC.streamDelta, { id: 'old-answer', text: 'Old synthetic answer.' })
    old?.send(IPC.streamDone, { id: 'old-answer' })
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledOnce())

    const newer = await turns.begin({ id: 'new-answer', mode: 'answer', handle: null })
    newer?.send(IPC.streamDelta, { id: 'new-answer', text: 'New synthetic answer.' })
    newer?.send(IPC.streamDone, { id: 'new-answer' })
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledTimes(2))
    turns.cancel('old-answer')
    expect(replies.snapshot().playback).toBe('reply')
    expect(vi.mocked(adapter.speak).mock.results[1]?.value.cancel).not.toHaveBeenCalled()

    await replies.preview({})
    turns.cancel('new-answer')
    expect(replies.snapshot().playback).toBe('preview')
    expect(vi.mocked(adapter.speak).mock.results[2]?.value.cancel).not.toHaveBeenCalled()
    replies.dispose()
  })

  it('speaks only after the main ask registry publishes a completed answer', async () => {
    const delivered: string[] = []
    const playbackHandlers: TtsPlaybackHandlers[] = []
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(async () => [VOICE]),
      speak: vi.fn((_request, handlers) => {
        expect(delivered).toContain(IPC.streamDone)
        playbackHandlers.push(handlers)
        return { cancel: vi.fn() }
      })
    }
    const lifecycle: ReplyLifecycleEvent[] = []
    const deps = {
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false,
      onReplyLifecycle: (event: ReplyLifecycleEvent) => lifecycle.push(event)
    } satisfies SpokenRepliesDeps
    const replies = createSpokenReplies(deps)
    const turns = createAskTurns({
      send: (channel) => void delivered.push(channel),
      streams: new Map(),
      observe: replies.observeAsk
    })

    const turn = await turns.begin({ id: 'synthetic-answer', mode: 'answer', handle: null })
    const generation = replies.snapshot().generation
    expect(turn).not.toBeNull()
    expect(lifecycle).toEqual([{ phase: 'pending', askId: 'synthetic-answer', generation }])
    expect(turn?.send(IPC.streamDelta, { id: 'synthetic-answer', text: 'A synthetic answer.' })).toBe(true)
    expect(lifecycle).toEqual([{ phase: 'pending', askId: 'synthetic-answer', generation }])
    expect(turn?.send(IPC.streamDone, { id: 'synthetic-answer' })).toBe(true)
    await vi.waitFor(() =>
      expect(lifecycle).toContainEqual({ phase: 'pending', askId: 'synthetic-answer', generation })
    )
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledOnce())

    expect(adapter.speak).toHaveBeenCalledWith(
      { text: 'A synthetic answer.', voiceId: VOICE.id, rate: 1 },
      expect.any(Object)
    )
    expect(replies.snapshot()).toMatchObject({ playback: 'reply', available: true })
    expect(playbackHandlers).toHaveLength(1)
    playbackHandlers[0].onStarted()
    playbackHandlers[0].onEnded('finished')
    playbackHandlers[0].onEnded('finished')
    expect(lifecycle).toEqual([
      { phase: 'pending', askId: 'synthetic-answer', generation },
      { phase: 'started', askId: 'synthetic-answer', generation },
      { phase: 'settled', askId: 'synthetic-answer', generation, outcome: 'finished' }
    ])
    replies.dispose()
  })

  it('the main runtime forwards Ask-bound lifecycle events without launching a real voice helper', async () => {
    const lifecycle: ReplyLifecycleEvent[] = []
    const playbackHandlers: TtsPlaybackHandlers[] = []
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(async () => [VOICE]),
      speak: vi.fn((_request, handlers) => {
        playbackHandlers.push(handlers)
        return { cancel: vi.fn() }
      })
    }
    const runtimeDeps = {
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false,
      window: () => null,
      onReplyLifecycle: (event: ReplyLifecycleEvent) => lifecycle.push(event)
    } satisfies SpokenRepliesRuntimeDeps
    const replies = createSpokenRepliesRuntime(runtimeDeps)
    const turns = createAskTurns({ send: () => undefined, streams: new Map(), observe: replies.observeAsk })
    const turn = await turns.begin({ id: 'runtime-bound-ask', mode: 'answer', handle: null })
    const generation = replies.snapshot().generation

    turn?.send(IPC.streamDelta, { id: 'runtime-bound-ask', text: 'Runtime synthetic answer.' })
    expect(lifecycle).toEqual([{ phase: 'pending', askId: 'runtime-bound-ask', generation }])
    turn?.send(IPC.streamDone, { id: 'runtime-bound-ask' })
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledOnce())
    playbackHandlers[0].onStarted()
    playbackHandlers[0].onEnded('interrupted')

    expect(lifecycle).toEqual([
      { phase: 'pending', askId: 'runtime-bound-ask', generation },
      { phase: 'started', askId: 'runtime-bound-ask', generation },
      { phase: 'settled', askId: 'runtime-bound-ask', generation, outcome: 'cancelled' }
    ])
    replies.dispose()
  })

  it('never speaks a suggestion stream even when it contains answer-like text', async () => {
    const adapter: TtsAdapter = {
      platform: 'darwin',
      listVoices: vi.fn(async () => [VOICE]),
      speak: vi.fn(() => ({ cancel: vi.fn() }))
    }
    const replies = createSpokenReplies({
      adapter,
      platform: 'darwin',
      getSettings: () => ({ spokenReplies: { speakReplies: true, voiceId: null, rate: 1 } }),
      meetingLive: () => false
    })
    const turns = createAskTurns({ send: () => undefined, streams: new Map(), observe: replies.observeAsk })

    const turn = await turns.begin({ id: 'synthetic-suggestion', mode: 'suggest', handle: null })
    turn?.send(IPC.streamDelta, { id: 'synthetic-suggestion', text: 'A synthetic suggestion.' })
    turn?.send(IPC.streamDone, { id: 'synthetic-suggestion' })
    await Promise.resolve()

    expect(adapter.speak).not.toHaveBeenCalled()
    replies.dispose()
  })
})
