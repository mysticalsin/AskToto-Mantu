import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AskStart } from '@shared/ipc'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, shell: {} }))
vi.mock('./auth', () => ({ authStatus: () => ({ email: null, name: null }) }))
vi.mock('./logger', () => ({ auditLog: vi.fn(), mainLog: { warn: vi.fn(), error: vi.fn() } }))

// Stub the CLI backend so kind='cli' routing can be asserted without spawning a process.
const cliMock = vi.hoisted(() => ({ runCliStream: vi.fn(() => ({ abort: vi.fn() })) }))
vi.mock('./cli', () => cliMock)

const operatorAskMock = vi.hoisted(() => ({
  streamOperatorAsk: vi.fn((_opts: { apiKey: string }) => ({ abort: vi.fn() }))
}))
vi.mock('./llm/operator-ask', () => operatorAskMock)

// Anthropic stub whose stream never emits and whose finalMessage never resolves → forces the idle watchdog.
const anthro = vi.hoisted(() => {
  const stream = {
    on: vi.fn(),
    finalMessage: vi.fn(() => new Promise(() => {})),
    abort: vi.fn()
  }
  // Typed to the shape createStream actually calls it with. Inferred from the stub body it had a
  // ZERO-parameter tuple, so reading calls[0][0] — the params object the assertions are entirely
  // about — was a type error against a call production makes every time.
  const streamFn = vi.fn((_params: { system: { text: string }[]; messages: { content: unknown }[] }) => stream)
  // Regular function (not arrow) so it can be invoked with `new` from createStream.
  const ctor = vi.fn(function () {
    return { messages: { stream: streamFn } }
  })
  return { stream, streamFn, ctor }
})
vi.mock('@anthropic-ai/sdk', () => ({ default: anthro.ctor }))
vi.mock('openai', () => ({
  default: vi.fn(function () {
    return { chat: { completions: { create: vi.fn() } } }
  })
}))

import { createStream } from './llm'
import type { StreamHandlers } from './llm/shared'

const req = (mode: AskStart['mode'] = 'answer'): AskStart =>
  ({ id: 'x', mode, prompt: 'hello', history: [] }) as AskStart
const handlers = (): StreamHandlers => ({
  onDelta: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn()
})

describe('createStream — routing', () => {
  beforeEach(() => {
    cliMock.runCliStream.mockClear()
    anthro.ctor.mockClear()
    anthro.stream.on.mockClear()
    anthro.streamFn.mockClear()
  })

  it('viaOperator never constructs a local Anthropic client or stores a key', () => {
    operatorAskMock.streamOperatorAsk.mockClear()
    createStream({
      providerId: 'anthropic',
      kind: 'anthropic',
      apiKey: '',
      viaOperator: true,
      operatorTransport: { url: 'https://operator.test', secret: 'ingest-secret' },
      model: 'claude',
      temperature: 0.7,
      system: 'sys',
      req: req(),
      handlers: handlers()
    })
    expect(operatorAskMock.streamOperatorAsk).toHaveBeenCalledOnce()
    expect(anthro.ctor).not.toHaveBeenCalled()
    const passed = operatorAskMock.streamOperatorAsk.mock.calls[0][0]
    expect(passed.apiKey).toBe('')
  })

  it('kind=cli delegates to runCliStream and returns its abort handle', () => {
    const r = createStream({
      providerId: 'claude-cli',
      kind: 'cli',
      apiKey: '',
      model: 'opus',
      temperature: 0.7,
      system: 'sys',
      req: req(),
      handlers: handlers()
    })
    expect(cliMock.runCliStream).toHaveBeenCalledOnce()
    expect(typeof r.abort).toBe('function')
  })

  it('kind=anthropic constructs the SDK client and registers a text listener', () => {
    createStream({
      providerId: 'anthropic',
      kind: 'anthropic',
      apiKey: 'k',
      model: 'claude',
      temperature: 0.7,
      system: 'sys',
      req: req(),
      handlers: handlers()
    })
    expect(anthro.ctor).toHaveBeenCalledOnce()
    expect(anthro.stream.on).toHaveBeenCalledWith('text', expect.any(Function))
  })

  it('depth=deeper appends the go-deeper directive to the user turn, NOT the cached system prefix', () => {
    const r = createStream({
      providerId: 'anthropic',
      kind: 'anthropic',
      apiKey: 'k',
      model: 'claude',
      temperature: 0.7,
      system: 'SYSTEM PREFIX',
      req: { id: 'x', mode: 'answer', prompt: 'hello', history: [], depth: 'deeper' } as AskStart,
      handlers: handlers()
    })
    const params = anthro.streamFn.mock.calls[0][0]
    const last = params.messages[params.messages.length - 1]
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    expect(content).toContain('Go deeper') // directive rides in the per-turn user message
    expect(params.system[0].text).not.toContain('Go deeper') // never in the cached system prefix
    r.abort() // clear the watchdog timer
  })
})

describe('createStream — idle watchdog (anthropic)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onError when the stream yields no tokens within the idle window', () => {
    const hs = handlers()
    createStream({
      providerId: 'anthropic',
      kind: 'anthropic',
      apiKey: 'k',
      model: 'claude',
      temperature: 0.7,
      system: 'sys',
      req: req(),
      handlers: hs
    })
    vi.advanceTimersByTime(120_000)
    expect(hs.onError).toHaveBeenCalledWith(expect.stringContaining('timed out'))
    expect(hs.onDone).not.toHaveBeenCalled()
  })
})
