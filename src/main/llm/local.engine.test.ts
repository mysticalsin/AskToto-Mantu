/**
 * Engine-dispatch contract for the 'local' provider (local.ts): the Apple fm-serve engine takes text
 * modes when live, llama-server keeps vision and every fallback path, and the two engines' stream
 * accounting (beginStream/endStream/markActivity) never cross-wires. All engine modules are mocked —
 * fm-runtime's own suite covers the real lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AskStart } from '@shared/ipc'
import type { StreamOptions } from './shared'

vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('./local-models', () => ({
  modelPaths: vi.fn(() => ({ dir: '/m', gguf: '/m/model.gguf', mmproj: '/m/mmproj.gguf' })),
  verifyIntegrity: vi.fn(async () => {})
}))
vi.mock('./local-runtime', () => ({
  getState: vi.fn(() => 'stopped'),
  getActiveModelKey: vi.fn(() => null),
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
  disabledByEnv: vi.fn(() => false),
  supported: vi.fn(() => true),
  getState: vi.fn(() => 'stopped'),
  probeAvailability: vi.fn(async () => ({ available: true, reason: null })),
  start: vi.fn(async () => {}),
  baseURL: vi.fn(() => 'http://127.0.0.1:9999/v1'),
  markActivity: vi.fn(),
  beginStream: vi.fn(),
  endStream: vi.fn(),
  activeStreams: vi.fn(() => 0),
  prewarm: vi.fn(),
  stop: vi.fn()
}))
vi.mock('./openai', () => ({ streamOpenAI: vi.fn(() => ({ abort: vi.fn() })) }))

import * as localRuntime from './local-runtime'
import * as fmRuntime from './fm-runtime'
import { streamOpenAI } from './openai'
import { streamLocal, pickLocalEngine, prewarmLocal, LOCAL_OUTPUT_TOKEN_BUDGETS } from './local'

const streamOpenAIMock = vi.mocked(streamOpenAI)
const fm = vi.mocked(fmRuntime)
const llama = vi.mocked(localRuntime)

function makeOpts(mode: AskStart['mode']): StreamOptions {
  return {
    providerId: 'local',
    kind: 'local',
    apiKey: '',
    model: 'qwen3.5-0.8b',
    temperature: 0.2,
    system: 'sys',
    req: { mode, history: [], prompt: 'p' } as unknown as AskStart,
    handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
  } as StreamOptions
}

async function waitForStream(): Promise<StreamOptions> {
  await vi.waitFor(() => expect(streamOpenAIMock).toHaveBeenCalled())
  return streamOpenAIMock.mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
  fm.disabledByEnv.mockReturnValue(false)
  fm.supported.mockReturnValue(true)
  fm.getState.mockReturnValue('stopped')
  fm.probeAvailability.mockResolvedValue({ available: true, reason: null })
  fm.start.mockResolvedValue(undefined)
  llama.getState.mockReturnValue('stopped')
  llama.start.mockResolvedValue(undefined)
})

describe('pickLocalEngine', () => {
  it('vision NEVER picks apple — even with fm live (image path unproven on fm serve)', async () => {
    expect(await pickLocalEngine('vision')).toBe('llama')
    expect(fm.probeAvailability).not.toHaveBeenCalled()
  })

  it('suggest/summary pick apple when supported + available', async () => {
    expect(await pickLocalEngine('suggest')).toBe('apple')
    expect(await pickLocalEngine('summary')).toBe('apple')
  })

  it('falls to llama when the probe says unavailable', async () => {
    fm.probeAvailability.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' })
    expect(await pickLocalEngine('suggest')).toBe('llama')
  })

  it('falls to llama on wrong platform/binary without probing', async () => {
    fm.supported.mockReturnValue(false)
    expect(await pickLocalEngine('suggest')).toBe('llama')
    expect(fm.probeAvailability).not.toHaveBeenCalled()
  })

  it('METIS_DISABLE_APPLE_FM kill switch wins without probing', async () => {
    fm.disabledByEnv.mockReturnValue(true)
    expect(await pickLocalEngine('suggest')).toBe('llama')
    expect(fm.probeAvailability).not.toHaveBeenCalled()
  })

  it('a crash-budget-exhausted fm session falls to llama without probing', async () => {
    fm.getState.mockReturnValue('unavailable')
    expect(await pickLocalEngine('suggest')).toBe('llama')
    expect(fm.probeAvailability).not.toHaveBeenCalled()
  })
})

describe('streamLocal — apple engine (text)', () => {
  it('routes suggest through fm serve with the system model, no llama slot options, same budget', async () => {
    const opts = makeOpts('suggest')
    streamLocal(opts)
    const sent = await waitForStream()
    expect(sent.baseURL).toBe('http://127.0.0.1:9999/v1')
    expect(sent.model).toBe('system')
    expect(sent.apiKey).toBe('fm-loopback')
    expect(sent.llamaSlotOptions).toBeUndefined()
    expect(sent.maxOutputTokens).toBe(LOCAL_OUTPUT_TOKEN_BUDGETS.suggest)
    expect(fm.beginStream).toHaveBeenCalledTimes(1)
    // The llama sidecar is never touched on the apple path.
    expect(llama.start).not.toHaveBeenCalled()
    expect(llama.beginStream).not.toHaveBeenCalled()
  })

  it('onDone releases the FM stream exactly once and re-arms the FM idle timer', async () => {
    const opts = makeOpts('summary')
    streamLocal(opts)
    const sent = await waitForStream()
    sent.handlers.onDone({})
    expect(fm.endStream).toHaveBeenCalledTimes(1)
    expect(fm.markActivity.mock.calls.length).toBeGreaterThanOrEqual(2) // start + done
    expect(opts.handlers.onDone).toHaveBeenCalled()
    // A late abort after done must not double-release.
    expect(llama.endStream).not.toHaveBeenCalled()
  })

  it('preserves incomplete completion metadata through the local usage wrapper', async () => {
    const opts = makeOpts('summary')
    streamLocal(opts)
    const sent = await waitForStream()

    sent.handlers.onDone({}, { status: 'incomplete', reason: 'length' })

    expect(opts.handlers.onDone).toHaveBeenCalledWith(
      expect.objectContaining({ cacheStatus: 'n/a' }),
      { status: 'incomplete', reason: 'length' }
    )
  })

  it('falls back to llama-server when fm start() rejects — losslessly, no user-facing error', async () => {
    fm.start.mockRejectedValue(new Error('spawn failed'))
    const opts = makeOpts('suggest')
    streamLocal(opts)
    const sent = await waitForStream()
    expect(sent.baseURL).toBe('http://127.0.0.1:1111/v1')
    expect(sent.apiKey).toBe('llama-session-key')
    expect(sent.model).toBe('qwen3.5-0.8b')
    expect(opts.handlers.onError).not.toHaveBeenCalled()
  })

  it('abort during fm start never opens a stream', async () => {
    let releaseStart!: () => void
    fm.start.mockImplementation(() => new Promise<void>((resolve) => (releaseStart = resolve)))
    const opts = makeOpts('suggest')
    const handle = streamLocal(opts)
    await vi.waitFor(() => expect(fm.start).toHaveBeenCalled())
    handle.abort()
    releaseStart()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(streamOpenAIMock).not.toHaveBeenCalled()
    expect(opts.handlers.onError).not.toHaveBeenCalled()
  })
})

describe('streamLocal — llama engine keeps vision and fallbacks byte-identical', () => {
  it('vision routes to llama-server with unpinned cache_prompt even while fm is live', async () => {
    const opts = makeOpts('vision')
    streamLocal(opts)
    const sent = await waitForStream()
    expect(sent.baseURL).toBe('http://127.0.0.1:1111/v1')
    expect(sent.llamaSlotOptions).toEqual({ cache_prompt: true })
    expect(sent.maxOutputTokens).toBe(LOCAL_OUTPUT_TOKEN_BUDGETS.vision)
    expect(fm.start).not.toHaveBeenCalled()
  })

  it('suggest pins slot 0 on the llama path when fm is unavailable', async () => {
    fm.probeAvailability.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' })
    streamLocal(makeOpts('suggest'))
    const sent = await waitForStream()
    expect(sent.llamaSlotOptions).toEqual({ id_slot: 0, cache_prompt: true })
    expect(sent.baseURL).toBe('http://127.0.0.1:1111/v1')
  })
})

describe('prewarmLocal — engine-aware', () => {
  it('warms fm serve (start + prewarm) when the apple engine would take the next suggest', async () => {
    await prewarmLocal('qwen3.5-0.8b', [{ role: 'user', content: 'hi' }])
    expect(fm.start).toHaveBeenCalledTimes(1)
    expect(fm.prewarm).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }])
    expect(llama.prewarm).not.toHaveBeenCalled()
    expect(llama.start).not.toHaveBeenCalled()
  })

  it('keeps the original llama prewarm order (markActivity → ensure → prewarm) when fm is off', async () => {
    fm.probeAvailability.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' })
    await prewarmLocal('qwen3.5-0.8b', [{ role: 'user', content: 'hi' }])
    expect(llama.markActivity).toHaveBeenCalled()
    expect(llama.start).toHaveBeenCalled()
    expect(llama.prewarm).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }])
    expect(fm.start).not.toHaveBeenCalled()
    expect(fm.prewarm).not.toHaveBeenCalled()
  })
})

describe('streamLocal — failure-path completeness (Sonnet audit locks)', () => {
  it('double failure (apple start rejects, llama fallback also fails) surfaces exactly ONE onError', async () => {
    fm.start.mockRejectedValue(new Error('fm spawn failed'))
    llama.start.mockRejectedValue(new Error('llama binary missing'))
    const opts = makeOpts('suggest')
    streamLocal(opts)
    await vi.waitFor(() => expect(opts.handlers.onError).toHaveBeenCalledTimes(1))
    expect(String(vi.mocked(opts.handlers.onError).mock.calls[0][0])).toContain('llama binary missing')
    expect(streamOpenAIMock).not.toHaveBeenCalled()
    // Both engines' stream accounting stays balanced — nothing was ever attached.
    expect(fm.endStream).not.toHaveBeenCalled()
    expect(llama.endStream).not.toHaveBeenCalled()
  })

  it('a mid-generation error on the APPLE stream releases the FM accounting exactly once (no llama retry)', async () => {
    const opts = makeOpts('summary')
    streamLocal(opts)
    const sent = await waitForStream()
    expect(sent.baseURL).toBe('http://127.0.0.1:9999/v1')
    sent.handlers.onError('model overloaded mid-stream')
    expect(fm.endStream).toHaveBeenCalledTimes(1)
    expect(opts.handlers.onError).toHaveBeenCalledWith('model overloaded mid-stream')
    // Post-start stream errors report via handlers — never a second silent engine hop that would
    // desync the renderer's stream state.
    expect(llama.start).not.toHaveBeenCalled()
    // A late abort after the error must not double-release.
    expect(fm.endStream).toHaveBeenCalledTimes(1)
  })
})
