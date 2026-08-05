import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { BrainIndexSchema } from '@shared/brain'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { brainBackfillProgress, ingestFailureCounts, startBackfill, MAX_INGEST_ATTEMPTS } from './ingest'
import { readIndex } from './store'

vi.mock('electron')

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

/**
 * T6 6a (cross-provider extraction failover) + 6b (MAX_INGEST_ATTEMPTS / exhausted terminal state).
 * See ingest.ts's pickProviderCandidates/runCompletion (6a) and the startBackfill requeue-loop
 * exhausted gate + finishJob's `exhausted` write (6b).
 */
describe('brain ingest resilience (T6 6a/6b)', () => {
  let userData: string
  let meetingsFolder: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    })
  }

  const respondError = (message: string) => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => opts.handlers.onError(message))
    return { abort: () => {} }
  }
  const respondJson = (json = '{}') => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-resilience-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-resilience-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    // A real provider env var in the test runner's own shell must never leak an extra eligible
    // candidate into these tests — clear every provider's key so only the ones a test explicitly
    // setApiKey()s are "connected" (mirrors ingest-backfill.test.ts / ingest-local.test.ts).
    for (const p of PROVIDER_IDS) clearApiKey(p)
    const envVars: Partial<Record<(typeof PROVIDER_IDS)[number], string>> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      grok: 'XAI_API_KEY',
      nvidia: 'NVIDIA_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      kimi: 'MOONSHOT_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      groq: 'GROQ_API_KEY',
      together: 'TOGETHER_API_KEY',
      fireworks: 'FIREWORKS_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      dust: 'DUST_API_KEY',
      gemini: 'GEMINI_API_KEY',
      custom: 'ASKTOTO_CUSTOM_API_KEY'
    }
    for (const provider of PROVIDER_IDS) {
      const envVar = envVars[provider]
      if (envVar) vi.stubEnv(envVar, '')
    }
    setSettings({ meetingsFolder })
    createStreamMock.mockReset()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(meetingsFolder, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('fails over to the next eligible provider on a transport failure without needing the same-provider reminder retry', async () => {
    writeFileSync(join(meetingsFolder, 'failover.md'), '---\ndate: 2026-01-01\n---\nAcme wants a renewal.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    setApiKey('openai', 'fake-openai-key')

    createStreamMock.mockImplementationOnce(respondError('503 Service Unavailable')).mockImplementationOnce(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['failover.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(2)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('anthropic')
    expect(createStreamMock.mock.calls[1][0].providerId).toBe('openai')
  })

  it('also fails over on a permanent-looking non-429 4xx from the active provider (the audited HTTP 404 case)', async () => {
    writeFileSync(join(meetingsFolder, 'dead-model.md'), '---\ndate: 2026-01-02\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    setApiKey('openai', 'fake-openai-key')

    createStreamMock.mockImplementationOnce(respondError('404 page not found')).mockImplementationOnce(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['dead-model.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(2)
    expect(createStreamMock.mock.calls[1][0].providerId).toBe('openai')
  })

  it('keeps the JSON-reminder retry pinned to the SAME provider even when a second provider is eligible', async () => {
    writeFileSync(join(meetingsFolder, 'parse-fail.md'), '---\ndate: 2026-01-03\n---\nAcme discussed pricing.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    setApiKey('openai', 'fake-openai-key')

    // Not valid JSON — a parse failure, not a transport one, so failover must NOT engage here.
    createStreamMock.mockImplementationOnce(respondJson('not json at all')).mockImplementationOnce(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['parse-fail.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(2)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('anthropic')
    expect(createStreamMock.mock.calls[1][0].providerId).toBe('anthropic') // reminder retry, NOT openai
  })

  it('propagates the last error after exhausting every eligible provider, then the reminder retry re-walks them all', async () => {
    writeFileSync(join(meetingsFolder, 'all-down.md'), '---\ndate: 2026-01-05\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    setApiKey('openai', 'fake-openai-key')
    createStreamMock.mockImplementation(respondError('503 Service Unavailable'))

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['all-down.md']?.ok).toBe(false)
    // 2 eligible providers x (first attempt + reminder retry) = 4 calls total.
    expect(createStreamMock).toHaveBeenCalledTimes(4)
    expect(createStreamMock.mock.calls.map((c) => c[0].providerId)).toEqual([
      'anthropic',
      'openai',
      'anthropic',
      'openai'
    ])
    expect(readIndex(getSettings()).ingested['all-down.md']?.error).toContain('503')
  })

  it('marks a source exhausted after MAX_INGEST_ATTEMPTS consecutive failures and stops the automatic reconcile tick from retrying it', async () => {
    writeFileSync(join(meetingsFolder, 'always-fails.md'), '---\ndate: 2026-01-06\n---\nAcme renewal call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondError('404 page not found'))

    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i++) {
      expect(startBackfill().queued).toBe(1)
      await waitForIdle()
    }

    const record = readIndex(getSettings()).ingested['always-fails.md']
    expect(record?.ok).toBe(false)
    expect(record?.attempts).toBe(MAX_INGEST_ATTEMPTS)
    expect(record?.exhausted).toBe(true)

    // The automatic reconcile tick (respectRetryBackoff) must never touch an exhausted record, even
    // once its own backoff window has already elapsed.
    createStreamMock.mockClear()
    expect(startBackfill(undefined, { respectRetryBackoff: true }).queued).toBe(0)
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('gives an exhausted record a fresh attempts budget on a manual retry instead of re-exhausting after one more failure', async () => {
    writeFileSync(join(meetingsFolder, 'always-fails-2.md'), '---\ndate: 2026-01-07\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondError('404 page not found'))

    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i++) {
      startBackfill()
      await waitForIdle()
    }
    expect(readIndex(getSettings()).ingested['always-fails-2.md']?.exhausted).toBe(true)

    // Manual retry (bare startBackfill — the exact call the Retry-index button's IPC handler makes)
    // requeues it despite `exhausted`, and clears the flag + resets attempts before this next failure
    // — one more failure afterward must land at attempts:1, never attempts:7 / re-exhausted.
    expect(startBackfill().queued).toBe(1)
    await waitForIdle()

    const record = readIndex(getSettings()).ingested['always-fails-2.md']
    expect(record?.attempts).toBe(1)
    expect(record?.exhausted).toBeFalsy()
  })

  it('lets a manual retry succeed and clear the exhausted flag entirely', async () => {
    writeFileSync(join(meetingsFolder, 'always-fails-3.md'), '---\ndate: 2026-01-08\n---\nAcme call.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondError('404 page not found'))

    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i++) {
      startBackfill()
      await waitForIdle()
    }
    expect(readIndex(getSettings()).ingested['always-fails-3.md']?.exhausted).toBe(true)

    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill().queued).toBe(1)
    await waitForIdle()

    const record = readIndex(getSettings()).ingested['always-fails-3.md']
    expect(record?.ok).toBe(true)
    expect(record?.exhausted).toBeFalsy()
  })
})

describe('ingestFailureCounts (T6 6c)', () => {
  it('splits failing sources into failed vs exhausted (disjoint) and names a topError only once 3+ share it', () => {
    const idx = BrainIndexSchema.parse({
      ingested: {
        'a.md': { at: 1, ok: true },
        'b.md': { at: 2, ok: false, error: '404 page not found' },
        'c.md': { at: 3, ok: false, error: '404 page not found' },
        'd.md': { at: 4, ok: false, error: '404 page not found', exhausted: true },
        'e.md': { at: 5, ok: false, error: 'network error' }
      }
    })
    expect(ingestFailureCounts(idx)).toEqual({ failed: 3, exhausted: 1, topError: '404 page not found' })
  })

  it('omits topError when no single error is shared by at least the threshold count', () => {
    const idx = BrainIndexSchema.parse({
      ingested: {
        'a.md': { at: 1, ok: false, error: 'one-off error A' },
        'b.md': { at: 2, ok: false, error: 'one-off error B' }
      }
    })
    const result = ingestFailureCounts(idx)
    expect(result.failed).toBe(2)
    expect(result.exhausted).toBe(0)
    expect(result.topError).toBeUndefined()
  })
})
