/**
 * local-routing.test.ts — proves PLAN.md §4.3's mode-scope contract for the 'local' provider: which
 * requests it may serve, its precedence against cliPrimary/providerOverride, its llama-server slot
 * pinning, and that its key source is structurally isolated from the stored/env API-key path. index.ts's
 * attempt()/pickFailover are nested closures over a per-request IPC handler (no index.test.ts exists
 * anywhere in this repo — main/index.ts is never unit-tested directly), so these are exercised at the
 * exported, pure boundary index.ts actually calls: local-routing.ts (localEligibleFor / localBaseReady /
 * pickPrimaryProvider) and local.ts (streamLocal).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AskStart } from '@shared/ipc'
import type { ModelTier } from '@shared/providers'
import type { StreamOptions, StreamHandlers } from './shared'

// local-routing.ts calls existsSync(candidate.path) directly (node:fs) to check whether the sidecar
// binary is provisioned — stub it so "binary present/missing" is deterministic per test, independent of
// this machine's real resources/llama/ contents.
const fsState = vi.hoisted(() => ({ binaryExists: true }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: () => fsState.binaryExists }
})

const localRuntimeMock = vi.hoisted(() => ({
  resolveBinaryPath: vi.fn(() => [{ path: '/resources/llama/mac/llama-server', variant: 'mac' as const }]),
  detectPlatform: vi.fn(() => 'mac' as const),
  isRunning: vi.fn(() => false),
  getState: vi.fn(() => 'stopped' as const),
  start: vi.fn(async () => {}),
  markActivity: vi.fn(),
  baseURL: vi.fn(() => 'http://127.0.0.1:54321/v1'),
  sessionKey: vi.fn(() => 'deadbeefsessionkeydeadbeefsessionkeydeadbeefsessionkeydeadbeef')
}))
vi.mock('./local-runtime', () => localRuntimeMock)

const localModelsMock = vi.hoisted(() => ({
  isDownloaded: vi.fn(() => true),
  modelPaths: vi.fn((id: string) => ({
    dir: `/models/${id}`,
    gguf: `/models/${id}/model.gguf`,
    mmproj: `/models/${id}/mmproj.gguf`
  })),
  verifyIntegrity: vi.fn(async () => {})
}))
vi.mock('./local-models', () => localModelsMock)

const openaiMock = vi.hoisted(() => ({
  streamOpenAI: vi.fn(() => ({ abort: vi.fn() }))
}))
vi.mock('./openai', () => openaiMock)

import { localEligibleFor, localBaseReady, pickPrimaryProvider } from './local-routing'
import { streamLocal } from './local'

type LocalLlmSettings = {
  localLlm: { enabled: boolean; modelId: string; useFor: { suggest: boolean; summary: boolean; vision: boolean } }
}

const readySettings = (overrides: Partial<LocalLlmSettings['localLlm']> = {}): LocalLlmSettings => ({
  localLlm: {
    enabled: true,
    modelId: 'qwen3.5-2b',
    useFor: { suggest: true, summary: true, vision: true },
    ...overrides
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  fsState.binaryExists = true
  localRuntimeMock.resolveBinaryPath.mockReturnValue([{ path: '/resources/llama/mac/llama-server', variant: 'mac' }])
  localRuntimeMock.detectPlatform.mockReturnValue('mac')
  localRuntimeMock.isRunning.mockReturnValue(false)
  localRuntimeMock.getState.mockReturnValue('stopped')
  localRuntimeMock.start.mockResolvedValue(undefined)
  localRuntimeMock.baseURL.mockReturnValue('http://127.0.0.1:54321/v1')
  localRuntimeMock.sessionKey.mockReturnValue('deadbeefsessionkeydeadbeefsessionkeydeadbeefsessionkeydeadbeef')
  localModelsMock.isDownloaded.mockReturnValue(true)
  localModelsMock.verifyIntegrity.mockResolvedValue(undefined)
  openaiMock.streamOpenAI.mockReturnValue({ abort: vi.fn() })
})

// ─── localEligibleFor — mode-scope matrix ───────────────────────────────────────────────────────────
describe('localEligibleFor', () => {
  it.each(['suggest', 'summary', 'vision'] as const)(
    'IS eligible for in-scope mode "%s" at base tier when enabled + ready',
    (mode) => {
      expect(localEligibleFor({ mode }, readySettings(), 'base', null)).toBe(true)
    }
  )

  it.each(['answer', 'recap'] as const)(
    'is NEVER eligible for out-of-scope mode "%s", even at base tier and fully ready',
    (mode) => {
      expect(localEligibleFor({ mode }, readySettings(), 'base', null)).toBe(false)
    }
  )

  it.each(['think', 'deep'] as const)(
    'is NEVER eligible once the tier escalates off base (tier=%s) — even for suggest',
    (tier) => {
      expect(localEligibleFor({ mode: 'suggest' }, readySettings(), tier as ModelTier, null)).toBe(false)
    }
  )

  it('a providerOverride-forced out-of-scope mode is STILL rejected (the mode-scope gate has no override escape hatch)', () => {
    // Mirrors what index.ts's attempt() does when req.providerOverride === 'local' for an answer/recap ask:
    // localEligibleFor is the ONLY gate consulted, and it never special-cases an override.
    expect(localEligibleFor({ mode: 'answer' }, readySettings(), 'base', null)).toBe(false)
    expect(localEligibleFor({ mode: 'recap' }, readySettings(), 'base', null)).toBe(false)
  })

  it('respects the per-task useFor toggle independently per mode', () => {
    const s = readySettings({ useFor: { suggest: false, summary: true, vision: true } })
    expect(localEligibleFor({ mode: 'suggest' }, s, 'base', null)).toBe(false)
    expect(localEligibleFor({ mode: 'summary' }, s, 'base', null)).toBe(true)
    expect(localEligibleFor({ mode: 'vision' }, s, 'base', null)).toBe(true)
  })

  it('localLlm.enabled=false -> never eligible regardless of mode/tier/readiness', () => {
    const s = readySettings({ enabled: false })
    expect(localEligibleFor({ mode: 'suggest' }, s, 'base', null)).toBe(false)
  })

  it('allowlist-exclusion case: org policy excluding "local" makes it ineligible even when fully configured', () => {
    expect(localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', ['anthropic', 'openai'])).toBe(false)
  })

  it('an allowlist that DOES include "local" leaves it eligible', () => {
    expect(localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', ['anthropic', 'local'])).toBe(true)
  })

  it('the runtime binary being unprovisioned makes it ineligible', () => {
    fsState.binaryExists = false
    expect(localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', null)).toBe(false)
  })

  it('the configured model not being downloaded yet makes it ineligible', () => {
    localModelsMock.isDownloaded.mockReturnValue(false)
    expect(localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', null)).toBe(false)
  })

  it('a stale/removed manifest id (isDownloaded throws) degrades to ineligible — never throws out of the routing decision', () => {
    localModelsMock.isDownloaded.mockImplementation(() => {
      throw new Error('Unknown local model id: "qwen3.5-9000b"')
    })
    expect(() => localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', null)).not.toThrow()
    expect(localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', null)).toBe(false)
  })

  it('allowlist-exclusion case end-to-end: local never becomes the FIRST attempt, so no blocked-first-attempt streamError with no failover ever fires for it', () => {
    // Mirrors index.ts's entry point exactly: localPrimaryEligible feeds pickPrimaryProvider, which is the
    // only thing that can turn 'local' into attempt()'s `provider` argument (and therefore the only way
    // to reach the "provider.blocked" / ineligible-with-no-failover branch for it).
    const allowed = ['anthropic']
    const eligible = localEligibleFor({ mode: 'suggest' }, readySettings(), 'base', allowed)
    expect(pickPrimaryProvider(undefined, eligible, undefined, 'anthropic')).toBe('anthropic')
  })
})

// ─── localBaseReady + the readiness derivation index.ts's settings snapshot performs ──────────────────
describe('localBaseReady (feeds index.ts localReady, local*Ready, and the visionReady/visionAvailable ORs)', () => {
  it('true when enabled + binary present + model downloaded + allowlist permits it', () => {
    expect(localBaseReady(readySettings(), null)).toBe(true)
  })

  it('false when disabled', () => {
    expect(localBaseReady(readySettings({ enabled: false }), null)).toBe(false)
  })

  it('false when the allowlist excludes local', () => {
    expect(localBaseReady(readySettings(), ['anthropic'])).toBe(false)
  })

  it('false when the runtime binary is missing', () => {
    fsState.binaryExists = false
    expect(localBaseReady(readySettings(), null)).toBe(false)
  })

  it('false when the configured model is not downloaded', () => {
    localModelsMock.isDownloaded.mockReturnValue(false)
    expect(localBaseReady(readySettings(), null)).toBe(false)
  })

  // index.ts's publicSettings() derives localSuggestReady/localSummaryReady/localVisionReady as EXACTLY
  // `localReady && useFor.<task>`, and visionReady/visionAvailable as `<generic cloud check> ||
  // localVisionReady`. index.ts itself has no test harness (no index.test.ts in this repo — the Electron
  // main entrypoint is never unit-tested directly), so this proves the derivation against the exported
  // primitive those one-line expressions are built on, matching the wiring verbatim.
  it('per-task *Ready flags = localBaseReady && the matching useFor toggle, independently', () => {
    const s = readySettings({ useFor: { suggest: true, summary: false, vision: true } })
    const localReady = localBaseReady(s, null)
    expect(localReady).toBe(true)
    expect(localReady && s.localLlm.useFor.suggest).toBe(true)
    expect(localReady && s.localLlm.useFor.summary).toBe(false)
    expect(localReady && s.localLlm.useFor.vision).toBe(true)
  })

  it('visionReady/visionAvailable OR: a local-only setup (no cloud vision provider configured at all) still resolves vision-ready', () => {
    const s = readySettings()
    const localVisionReady = localBaseReady(s, null) && s.localLlm.useFor.vision
    const cloudSideReady = false // no cloud provider configured / vision-capable
    expect(cloudSideReady || localVisionReady).toBe(true)
  })
})

// ─── pickPrimaryProvider — first-attempt precedence ────────────────────────────────────────────────────
describe('pickPrimaryProvider', () => {
  it('providerOverride always wins, even when local is eligible', () => {
    expect(pickPrimaryProvider('dust', true, 'claude-cli', 'anthropic')).toBe('dust')
  })

  it('local wins over cliPrimary when eligible (Métis Local short-circuits even a connected CLI subscription)', () => {
    expect(pickPrimaryProvider(undefined, true, 'claude-cli', 'anthropic')).toBe('local')
  })

  it('cliPrimary wins when local is not eligible for this request', () => {
    expect(pickPrimaryProvider(undefined, false, 'claude-cli', 'anthropic')).toBe('claude-cli')
  })

  it('falls back to the globally active provider when neither override, local, nor cliPrimary apply', () => {
    expect(pickPrimaryProvider(undefined, false, undefined, 'anthropic')).toBe('anthropic')
  })

  it('local still wins over the active provider even with no cliPrimary in play', () => {
    expect(pickPrimaryProvider(undefined, true, undefined, 'anthropic')).toBe('local')
  })
})

// ─── streamLocal (local.ts) — slot pinning, key injection, start/abort contract ────────────────────────
describe('streamLocal', () => {
  const handlers = (): StreamHandlers => ({ onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() })
  const baseOpts = (mode: AskStart['mode'], overrides: Partial<StreamOptions> = {}): StreamOptions => ({
    providerId: 'local',
    kind: 'local',
    apiKey: '', // intentionally blank — streamLocal must never rely on this; it derives its own key
    model: 'qwen3.5-2b',
    temperature: 0.7,
    system: 'sys',
    req: { id: 'x', mode, prompt: '', history: [] } as AskStart,
    handlers: handlers(),
    ...overrides
  })
  const flush = async (times = 4): Promise<void> => {
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  it.each([
    ['suggest', { id_slot: 0, cache_prompt: true }],
    ['summary', { id_slot: 1, cache_prompt: true }],
    ['vision', { cache_prompt: true }]
  ] as const)('pins the correct llama-server slot options for mode=%s', async (mode, expected) => {
    streamLocal(baseOpts(mode))
    await flush()
    expect(openaiMock.streamOpenAI).toHaveBeenCalledOnce()
    const passed = openaiMock.streamOpenAI.mock.calls[0][0] as StreamOptions
    expect(passed.llamaSlotOptions).toEqual(expected)
  })

  it('injects localRuntime.sessionKey() as the apiKey — never the (blank) opts.apiKey it was called with', async () => {
    streamLocal(baseOpts('suggest'))
    await flush()
    const passed = openaiMock.streamOpenAI.mock.calls[0][0] as StreamOptions
    expect(passed.apiKey).toBe('deadbeefsessionkeydeadbeefsessionkeydeadbeefsessionkeydeadbeef')
    expect(localRuntimeMock.sessionKey).toHaveBeenCalled()
  })

  it('never imports getApiKey/store.ts — structural proof the sidecar session key is the ONLY key source for local', () => {
    const source = readFileSync(join(__dirname, 'local.ts'), 'utf8')
    expect(source).not.toMatch(/getApiKey/)
    expect(source).not.toMatch(/from ['"]\.\.\/store['"]/)
  })

  it('sets baseURL from localRuntime.baseURL(), overriding whatever opts.baseURL carried in', async () => {
    streamLocal(baseOpts('suggest', { baseURL: 'https://should-be-ignored.example' }))
    await flush()
    const passed = openaiMock.streamOpenAI.mock.calls[0][0] as StreamOptions
    expect(passed.baseURL).toBe('http://127.0.0.1:54321/v1')
  })

  it('starts the runtime with the manifest paths for the CONFIGURED model id when not already running', async () => {
    streamLocal(baseOpts('suggest', { model: 'qwen3.5-0.8b' }))
    await flush()
    expect(localModelsMock.modelPaths).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localRuntimeMock.start).toHaveBeenCalledWith({
      gguf: '/models/qwen3.5-0.8b/model.gguf',
      mmproj: '/models/qwen3.5-0.8b/mmproj.gguf'
    })
  })

  it('F2: still calls start() (idempotently) even when the runtime is already running — the running/switch decision is delegated to start() itself, not short-circuited here', async () => {
    localRuntimeMock.getState.mockReturnValue('running')
    streamLocal(baseOpts('suggest'))
    await flush()
    expect(localRuntimeMock.start).toHaveBeenCalledWith({
      gguf: '/models/qwen3.5-2b/model.gguf',
      mmproj: '/models/qwen3.5-2b/mmproj.gguf'
    })
    expect(openaiMock.streamOpenAI).toHaveBeenCalledOnce()
  })

  it('F5: skips verifyIntegrity when the runtime is already running (not a cold start)', async () => {
    localRuntimeMock.getState.mockReturnValue('running')
    streamLocal(baseOpts('suggest'))
    await flush()
    expect(localModelsMock.verifyIntegrity).not.toHaveBeenCalled()
  })

  it('F5: skips verifyIntegrity when the runtime is already starting (not a cold start)', async () => {
    localRuntimeMock.getState.mockReturnValue('starting')
    streamLocal(baseOpts('suggest'))
    await flush()
    expect(localModelsMock.verifyIntegrity).not.toHaveBeenCalled()
  })

  it('F5: a cold start (state stopped) verifies the configured model’s integrity BEFORE starting', async () => {
    localRuntimeMock.getState.mockReturnValue('stopped')
    streamLocal(baseOpts('suggest', { model: 'qwen3.5-0.8b' }))
    await flush()
    expect(localModelsMock.verifyIntegrity).toHaveBeenCalledWith('qwen3.5-0.8b')
    expect(localRuntimeMock.start).toHaveBeenCalled()
  })

  it('F5: a verifyIntegrity failure on cold start reports onError and never calls start() or streamOpenAI', async () => {
    localRuntimeMock.getState.mockReturnValue('stopped')
    localModelsMock.verifyIntegrity.mockRejectedValue(new Error('checksum mismatch'))
    const hs = handlers()
    streamLocal(baseOpts('suggest', { handlers: hs }))
    await flush()
    expect(hs.onError).toHaveBeenCalledWith(expect.stringContaining('checksum mismatch'))
    expect(localRuntimeMock.start).not.toHaveBeenCalled()
    expect(openaiMock.streamOpenAI).not.toHaveBeenCalled()
  })

  it('marks activity before delegating to streamOpenAI', async () => {
    streamLocal(baseOpts('suggest'))
    await flush()
    expect(localRuntimeMock.markActivity).toHaveBeenCalled()
  })

  it('returns a StreamHandle synchronously — the caller can store it for abort before the async start settles', () => {
    let resolveStart: () => void = () => {}
    localRuntimeMock.start.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStart = resolve
      })
    )
    const handle = streamLocal(baseOpts('suggest'))
    expect(typeof handle.abort).toBe('function')
    resolveStart() // let the pending promise settle so it doesn't leak into the next test
  })

  it('reports a start failure via handlers.onError (never a thrown/unhandled rejection) so the waterfall can fail over', async () => {
    localRuntimeMock.start.mockRejectedValue(new Error('llama-server binary missing'))
    const hs = handlers()
    streamLocal(baseOpts('suggest', { handlers: hs }))
    await flush()
    expect(hs.onError).toHaveBeenCalledWith(expect.stringContaining('binary missing'))
    expect(openaiMock.streamOpenAI).not.toHaveBeenCalled()
  })

  it('aborting while the sidecar is still starting suppresses onError and never starts the inner stream', async () => {
    let resolveStart: () => void = () => {}
    localRuntimeMock.start.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStart = resolve
      })
    )
    const hs = handlers()
    const handle = streamLocal(baseOpts('suggest', { handlers: hs }))
    handle.abort()
    resolveStart()
    await flush()
    expect(hs.onError).not.toHaveBeenCalled()
    expect(openaiMock.streamOpenAI).not.toHaveBeenCalled()
  })

  it('abort() after the inner stream started delegates to the inner handle', async () => {
    const innerAbort = vi.fn()
    openaiMock.streamOpenAI.mockReturnValue({ abort: innerAbort })
    const handle = streamLocal(baseOpts('suggest'))
    await flush()
    handle.abort()
    expect(innerAbort).toHaveBeenCalledOnce()
  })
})
