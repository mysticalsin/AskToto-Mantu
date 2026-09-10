import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskStart } from '@shared/ipc'
import type { StreamHandlers, StreamOptions } from './shared'

const openaiTransport = vi.hoisted(() => {
  const state = {
    chunks: [] as unknown[],
    create: vi.fn()
  }
  state.create.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of state.chunks) yield chunk
    }
  }))
  const ctor = vi.fn(function () {
    return { chat: { completions: { create: state.create } } }
  })
  return { state, ctor }
})

const anthropicTransport = vi.hoisted(() => {
  const state = {
    finalMessage: vi.fn(),
    listeners: {} as Record<string, (value: unknown) => void>
  }
  const stream = {
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      state.listeners[event] = listener
      return stream
    }),
    finalMessage: state.finalMessage,
    abort: vi.fn()
  }
  const streamFn = vi.fn(() => stream)
  const ctor = vi.fn(function () {
    return { messages: { stream: streamFn } }
  })
  return { state, stream, streamFn, ctor }
})

vi.mock('openai', () => ({ default: openaiTransport.ctor }))
vi.mock('@anthropic-ai/sdk', () => ({ default: anthropicTransport.ctor }))

import { streamAnthropic } from './anthropic'
import { streamOpenAI } from './openai'

const req = { id: 'completion-1', mode: 'recap', prompt: '', transcript: 'hello', history: [] } as AskStart

function handlers(): StreamHandlers {
  return { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

function opts(kind: 'openai' | 'anthropic', h: StreamHandlers): StreamOptions {
  return {
    providerId: kind,
    kind,
    apiKey: 'placeholder-not-a-real-key',
    model: kind === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-6',
    temperature: 0,
    system: 'system',
    req,
    handlers: h
  }
}

describe('provider completion metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openaiTransport.state.chunks = []
    anthropicTransport.state.listeners = {}
  })

  it('marks an OpenAI length finish as incomplete', async () => {
    const h = handlers()
    openaiTransport.state.chunks = [
      { choices: [{ delta: { content: 'partial recap' }, finish_reason: 'length' }], usage: { completion_tokens: 8192 } }
    ]

    streamOpenAI(opts('openai', h))

    await vi.waitFor(() =>
      expect(h.onDone).toHaveBeenCalledWith(expect.any(Object), { status: 'incomplete', reason: 'length' })
    )
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('marks an OpenAI stop finish as complete', async () => {
    const h = handlers()
    openaiTransport.state.chunks = [
      { choices: [{ delta: { content: 'complete recap' }, finish_reason: 'stop' }] }
    ]

    streamOpenAI(opts('openai', h))

    await vi.waitFor(() =>
      expect(h.onDone).toHaveBeenCalledWith(expect.any(Object), { status: 'complete', reason: 'stop' })
    )
  })

  it('marks OpenAI stream EOF without a finish reason as incomplete', async () => {
    const h = handlers()
    openaiTransport.state.chunks = [{ choices: [{ delta: { content: 'partial recap' } }] }]

    streamOpenAI(opts('openai', h))

    await vi.waitFor(() =>
      expect(h.onDone).toHaveBeenCalledWith(expect.any(Object), {
        status: 'incomplete',
        reason: 'unexpected_eof'
      })
    )
  })

  it('marks an Anthropic max_tokens stop as incomplete', async () => {
    const h = handlers()
    anthropicTransport.state.finalMessage.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      usage: { input_tokens: 20, output_tokens: 8192 }
    })

    streamAnthropic(opts('anthropic', h))

    await vi.waitFor(() =>
      expect(h.onDone).toHaveBeenCalledWith(expect.any(Object), {
        status: 'incomplete',
        reason: 'max_tokens'
      })
    )
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('marks an Anthropic end_turn stop as complete', async () => {
    const h = handlers()
    anthropicTransport.state.finalMessage.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 200 }
    })

    streamAnthropic(opts('anthropic', h))

    await vi.waitFor(() =>
      expect(h.onDone).toHaveBeenCalledWith(expect.any(Object), {
        status: 'complete',
        reason: 'end_turn'
      })
    )
  })
})
