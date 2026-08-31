import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { brainBackfillProgress, enqueueIngest, startBackfill, whenIndexWritesSettle } from './ingest'
import { readIndex, readMeetingExtraction } from './store'

vi.mock('electron')

const localBaseReadyMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('../llm/local-routing', () => ({
  localBaseReady: localBaseReadyMock,
  resolveRoutingMode: (s: { routingMode?: string }) => s.routingMode ?? 'auto'
}))

const createStreamMock = vi.hoisted(() =>
  vi.fn((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  })
)
vi.mock('../llm', () => ({ createStream: createStreamMock }))

describe('automatic brain ingest with Métis Local', () => {
  let userData: string
  let meetingsFolder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-local-brain-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-local-brain-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })

    // Make the test explicitly local-only. getApiKey() short-circuits on a provider's env var BEFORE it
    // reads the temp profile, so a developer's real shell key would make the cloud path win here. Sweep
    // by SUFFIX rather than a hand-copied provider->env-var map: that map drifts silently (this one still
    // said MOONSHOT_API_KEY long after store.ts moved kimi to KIMI_API_KEY, and never listed grok's
    // XAI_API_KEY at all), and the drift only shows up as a confusing failure on a machine that happens
    // to export the missing name. Every name in store.ts's ENV_VAR map ends in `_API_KEY`.
    for (const provider of PROVIDER_IDS) clearApiKey(provider)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }

    setSettings({
      meetingsFolder,
      provider: 'anthropic',
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: true, summary: true, vision: true }
      }
    })
    writeFileSync(
      join(meetingsFolder, 'local-only.md'),
      '---\ndate: 2026-07-14\n---\nCustomer asked for an offline follow-up next Tuesday.',
      'utf8'
    )
    vi.clearAllMocks()
    localBaseReadyMock.mockReturnValue(true)
  })

  afterEach(async () => {
    // running=false only means the queue drained; the last job's index.json record is still on the
    // serialized write lane. Removing the profile under that in-flight tmp+rename both raises an
    // unhandled rejection and lets the stale write land during the NEXT test, where startBackfill()
    // then reports queued:0 because the index it reads is not the one this test just seeded.
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses the bundled local model to process a saved meeting when no cloud provider is configured', async () => {
    const result = startBackfill()

    expect(result).toEqual({ queued: 1 })
    await vi.waitFor(() => {
      expect(brainBackfillProgress()).toEqual({ total: 1, done: 1, running: false })
    }, { timeout: 10_000 })

    expect(readIndex(getSettings()).ingested['local-only.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalled()
    const request = createStreamMock.mock.calls[0][0]
    expect(request.providerId).toBe('local')
    expect(request.kind).toBe('local')
    expect(request.maxOutputTokens).toBe(1536)
    expect(request.req.mode).toBe('summary')
    expect(request.req.transcript).toContain('Customer asked for an offline follow-up')
  })

  it('keeps a meeting when the local model emits a null optional numeric fact', async () => {
    createStreamMock.mockImplementationOnce((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
      queueMicrotask(() => {
        opts.handlers.onDelta(JSON.stringify({
          title24: 'Offline follow-up',
          numeric_facts: [
            { kind: 'date', value: null, unit: null, quote: 'next Tuesday' },
            { kind: 'headcount', value: 1, unit: null, quote: 'one follow-up' }
          ]
        }))
        opts.handlers.onDone({})
      })
      return { abort: () => {} }
    })

    expect(startBackfill()).toEqual({ queued: 1 })
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['local-only.md']?.ok).toBe(true)
    }, { timeout: 10_000 })

    expect(readMeetingExtraction(getSettings(), 'local-only-md')?.numeric_facts).toEqual([
      expect.objectContaining({ kind: 'headcount', value: 1 })
    ])
  })

  it('keeps opted-in summary extraction local even when a cloud provider is connected', async () => {
    // Regression for the packaged-app failure: the profile had Métis Local enabled for summaries, but
    // a connected Dust provider still won brain extraction and returned HTTP 404. Local selection is an
    // explicit privacy choice, so a cloud credential must not silently override it for this workload.
    setSettings({ provider: 'dust', dustWorkspaceId: 'test-workspace' })
    setApiKey('dust', 'test-dust-key')

    expect(startBackfill()).toEqual({ queued: 1 })
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    await whenIndexWritesSettle()

    expect(readIndex(getSettings()).ingested['local-only.md']?.ok).toBe(true)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
  })

  it('does not treat the meetings README as a transcript candidate', async () => {
    writeFileSync(join(meetingsFolder, 'README.md'), '# Métis meeting folder', 'utf8')

    const result = startBackfill()

    expect(result).toEqual({ queued: 1 })
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['local-only.md']?.ok).toBe(true)
    }, { timeout: 10_000 })
    expect(readIndex(getSettings()).ingested['README.md']).toBeUndefined()
  })

  it('processes a newly saved meeting through the normal automatic enqueue path', async () => {
    const file = join(meetingsFolder, 'saved-after-listen.md')
    writeFileSync(file, '---\ndate: 2026-07-14\n---\nA saved meeting decision stays on-device.', 'utf8')

    enqueueIngest(file)

    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['saved-after-listen.md']?.ok).toBe(true)
    }, { timeout: 10_000 })
    expect(createStreamMock.mock.calls.at(-1)?.[0].providerId).toBe('local')
  })
})
