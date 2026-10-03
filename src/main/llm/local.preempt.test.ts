/**
 * M2-0430: the user-facing recap pre-empts background brain extraction on the local model. Engine modules
 * are stubbed: streamOpenAI stands in for the model, so "in flight" means a stream attached and not
 * finished. Proves ordering and admission, not latency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskStart } from '@shared/ipc'
import type { StreamHandle, StreamOptions } from './shared'

vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('./local-models', () => ({
  modelPaths: vi.fn(() => ({ dir: '/m', gguf: '/m/model.gguf', mmproj: '/m/mmproj.gguf', ctxSize: 8192, parallel: 2, gpuLayers: 0 })),
  verifyIntegrity: vi.fn(async () => {})
}))
vi.mock('./local-runtime', () => ({
  getState: vi.fn(() => 'running'),
  getActiveModelKey: vi.fn(() => '/m/model.gguf'),
  activeSlotTokens: vi.fn(() => 24_576),
  start: vi.fn(async () => {}),
  baseURL: vi.fn(() => 'http://127.0.0.1:1111/v1'),
  sessionKey: vi.fn(() => 'llama-session-key'),
  markActivity: vi.fn(),
  beginStream: vi.fn(),
  endStream: vi.fn(),
  activeStreams: vi.fn(() => 0),
  prewarm: vi.fn()
}))
vi.mock('./fm-runtime', () => ({
  FM_SYSTEM_MODEL: 'system',
  FM_UNLICENSED_REASON: 'cli-license-not-accepted',
  disabledByEnv: vi.fn(() => false),
  supported: vi.fn(() => false),
  getState: vi.fn(() => 'stopped'),
  probeAvailability: vi.fn(async () => ({ available: false, reason: 'binary-missing' })),
  start: vi.fn(async () => {}),
  baseURL: vi.fn(() => 'http://127.0.0.1:9999/v1'),
  markActivity: vi.fn(),
  beginStream: vi.fn(),
  endStream: vi.fn(),
  activeStreams: vi.fn(() => 0),
  prewarm: vi.fn(),
  stop: vi.fn()
}))

type ModelCall = { opts: StreamOptions; abort: ReturnType<typeof vi.fn> }
const modelCalls: ModelCall[] = []
vi.mock('./openai', () => ({
  streamOpenAI: vi.fn((opts: StreamOptions): StreamHandle => {
    const abort = vi.fn()
    modelCalls.push({ opts, abort })
    return { abort }
  })
}))

import * as localRuntime from './local-runtime'
import * as fmRuntime from './fm-runtime'
import {
  LOCAL_PREEMPTED_MESSAGE,
  appleEngineStatus,
  isLocalPreemption,
  localSlotTokens,
  pickLocalEngine,
  prewarmLocal,
  streamLocal,
  whenLocalInteractiveIdle
} from './local'

const llama = vi.mocked(localRuntime)
const fm = vi.mocked(fmRuntime)

function summary(background: boolean) {
  const handlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
  const opts = {
    providerId: 'local',
    kind: 'local',
    apiKey: '',
    model: 'qwen3.5-4b',
    temperature: 0,
    system: 'sys',
    req: { id: background ? 'brain-1' : 'recap-1', mode: 'summary', prompt: '', transcript: 'THEM: synthetic', history: [] } as AskStart,
    handlers,
    ...(background ? { background: true } : {})
  } as StreamOptions
  return { opts, handlers }
}

const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  modelCalls.length = 0
  vi.clearAllMocks()
})

describe('M2-0430: a recap pre-empts in-flight background extraction', () => {
  it('admits the recap immediately while an extraction is in flight, and pauses extraction until it is done', async () => {
    const extraction = summary(true)
    streamLocal(extraction.opts)
    await vi.waitFor(() => expect(modelCalls).toHaveLength(1))
    const inFlight = modelCalls[0]
    expect(inFlight.opts.llamaSlotOptions).toEqual({ id_slot: 1, cache_prompt: true })

    // The recap starts: the extraction's model stream is cancelled and its slot released at once.
    const recap = summary(false)
    const recapHandle = streamLocal(recap.opts)
    expect(inFlight.abort).toHaveBeenCalledTimes(1)
    expect(extraction.handlers.onError).toHaveBeenCalledExactlyOnceWith(LOCAL_PREEMPTED_MESSAGE)
    expect(isLocalPreemption(new Error(LOCAL_PREEMPTED_MESSAGE))).toBe(true)
    expect(llama.endStream).toHaveBeenCalledTimes(1)

    // ...and the recap reaches the model without waiting for the extraction to finish.
    await vi.waitFor(() => expect(modelCalls).toHaveLength(2))
    expect(modelCalls[1].opts.req.id).toBe('recap-1')
    expect(modelCalls[1].opts.llamaSlotOptions).toEqual({ id_slot: 1, cache_prompt: true })

    // While the recap runs, new background work is refused before it touches the engine.
    const late = summary(true)
    streamLocal(late.opts)
    await settled()
    expect(late.handlers.onError).toHaveBeenCalledExactlyOnceWith(LOCAL_PREEMPTED_MESSAGE)
    expect(modelCalls).toHaveLength(2)

    let resumed = false
    const idle = whenLocalInteractiveIdle().then(() => { resumed = true })
    await settled()
    expect(resumed).toBe(false)

    // The recap finishes: background work may resume, and a resent extraction reaches the model.
    modelCalls[1].opts.handlers.onDone({})
    await idle
    expect(recap.handlers.onDone).toHaveBeenCalledTimes(1)
    const resent = summary(true)
    streamLocal(resent.opts)
    await vi.waitFor(() => expect(modelCalls).toHaveLength(3))
    expect(resent.handlers.onError).not.toHaveBeenCalled()
    recapHandle.abort()
  })

  it('a cancelled recap also releases the pause', async () => {
    const recapHandle = streamLocal(summary(false).opts)
    await vi.waitFor(() => expect(modelCalls).toHaveLength(1))
    const idle = whenLocalInteractiveIdle()
    recapHandle.abort()
    await expect(idle).resolves.toBeUndefined()
  })

  it('suggest traffic never pre-empts extraction', async () => {
    const extraction = summary(true)
    streamLocal(extraction.opts)
    await vi.waitFor(() => expect(modelCalls).toHaveLength(1))
    const suggest = summary(false)
    streamLocal({ ...suggest.opts, req: { ...suggest.opts.req, mode: 'suggest' } })
    await vi.waitFor(() => expect(modelCalls).toHaveLength(2))
    expect(modelCalls[0].abort).not.toHaveBeenCalled()
    expect(extraction.handlers.onError).not.toHaveBeenCalled()
    modelCalls[0].opts.handlers.onDone({})
    modelCalls[1].opts.handlers.onDone({})
  })
})

describe('M2-0430: local slot size, summary warm and Apple engine qualification', () => {
  it('uses the running sidecar\'s slot, and the profile when none is up', () => {
    expect(localSlotTokens('qwen3.5-4b')).toBe(24_576)
    llama.activeSlotTokens.mockReturnValueOnce(null)
    expect(localSlotTokens('qwen3.5-4b')).toBe(4096)
  })

  it('the Stop-time summary warm prefills the summary slot (1); the suggest warm keeps slot 0', async () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'THEM: hi' }]
    await prewarmLocal('qwen3.5-4b', messages, undefined, 'summary')
    expect(llama.prewarm).toHaveBeenLastCalledWith(messages, 1)
    await prewarmLocal('qwen3.5-4b', messages)
    expect(llama.prewarm).toHaveBeenLastCalledWith(messages)
  })

  it('a summary Apple\'s 4,096-token window cannot hold goes to llama-server without probing', async () => {
    fm.supported.mockReturnValue(true)
    fm.probeAvailability.mockResolvedValue({ available: true, reason: null })
    expect(await pickLocalEngine('summary', 3_000, 512)).toBe('apple')
    fm.probeAvailability.mockClear()
    expect(await pickLocalEngine('summary', 40_000, 512)).toBe('llama')
    expect(fm.probeAvailability).not.toHaveBeenCalled()
    fm.supported.mockReturnValue(false)
  })

  it('reports an unaccepted Foundation Models CLI licence as unlicensed for Settings', async () => {
    fm.supported.mockReturnValue(true)
    fm.probeAvailability.mockResolvedValue({ available: false, reason: 'cli-license-not-accepted' })
    expect(await appleEngineStatus()).toBe('unlicensed')
    fm.probeAvailability.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' })
    expect(await appleEngineStatus()).toBe('unavailable')
    fm.probeAvailability.mockResolvedValue({ available: true, reason: null })
    expect(await appleEngineStatus()).toBe('available')
    fm.supported.mockReturnValue(false)
    expect(await appleEngineStatus()).toBe('unsupported')
  })
})
