import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import { brainBackfillProgress, startBackfill, whenIndexWritesSettle } from './ingest'
import { startIntelligencePass } from './intelligence-pass'
import { INTELLIGENCE_PASS_NO_PROVIDER } from './intelligence-pass-route'
import { readIndex } from './store'

vi.mock('electron')

const localBaseReadyMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('../llm/local-routing', () => ({
  localBaseReady: localBaseReadyMock,
  resolveRoutingMode: (s: { routingMode?: string }) => s.routingMode ?? 'auto'
}))

const localRuntimeStateMock = vi.hoisted(() => vi.fn<() => string>(() => 'stopped'))
vi.mock('../llm/local-runtime', () => ({
  getState: localRuntimeStateMock,
  activeStreams: () => 0
}))

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

describe('Update Intelligence pass — local first, API once', () => {
  let userData: string
  let meetingsFolder: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    await whenIndexWritesSettle()
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
    userData = mkdtempSync(join(tmpdir(), 'asktoto-intel-pass-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-intel-pass-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    for (const p of PROVIDER_IDS) clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({
      meetingsFolder,
      provider: 'anthropic',
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: false, summary: false, vision: false },
        fallback: false
      }
    })
    createStreamMock.mockReset()
    createStreamMock.mockImplementation(respondJson())
    localBaseReadyMock.mockReset()
    localBaseReadyMock.mockReturnValue(true)
    localRuntimeStateMock.mockReturnValue('stopped')
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses Local first when Local is ready, even if an API is configured', async () => {
    writeFileSync(join(meetingsFolder, 'local-first.md'), '---\ndate: 2026-08-01\n---\nAcme renewal.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondJson())

    expect(startIntelligencePass()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['local-first.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
  })

  it('falls over to the configured API once when Local errors', async () => {
    writeFileSync(join(meetingsFolder, 'local-error.md'), '---\ndate: 2026-08-02\n---\nAcme wants a date.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock
      .mockImplementationOnce(respondError('llama-server refused the load'))
      .mockImplementationOnce(respondJson())

    expect(startIntelligencePass()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['local-error.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(2)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
    expect(createStreamMock.mock.calls[1][0].providerId).toBe('anthropic')
  })

  it('uses the API when Local is refused (disk/RAM) and does not call Local', async () => {
    writeFileSync(join(meetingsFolder, 'ram-refused.md'), '---\ndate: 2026-08-03\n---\nAcme went quiet.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    localBaseReadyMock.mockReturnValue(false)
    createStreamMock.mockImplementation(respondJson())

    expect(startIntelligencePass()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['ram-refused.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('anthropic')
  })

  it('fails loud when Local is missing and no API is configured', () => {
    localBaseReadyMock.mockReturnValue(false)
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: ['anthropic'] }), 'utf8')
    writeFileSync(join(meetingsFolder, 'none.md'), '---\ndate: 2026-08-04\n---\nNo provider.', 'utf8')
    expect(startIntelligencePass()).toEqual({ queued: 0, error: INTELLIGENCE_PASS_NO_PROVIDER })
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('records a loud failure when Local and the API both error', async () => {
    writeFileSync(join(meetingsFolder, 'both-fail.md'), '---\ndate: 2026-08-06\n---\nBoth routes down.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondError('provider down'))

    expect(startIntelligencePass()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['both-fail.md']?.ok).toBe(false)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
    expect(createStreamMock.mock.calls.some((call) => call[0].providerId === 'anthropic')).toBe(true)
  })

  it('does not silently stay on the API when Local is ready (default backfill still can)', async () => {
    writeFileSync(join(meetingsFolder, 'default-cloud.md'), '---\ndate: 2026-08-05\n---\nCloud first default.', 'utf8')
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(createStreamMock.mock.calls[0][0].providerId).toBe('anthropic')
  })
})

describe('Update Intelligence pass — never auto, never auto-send', () => {
  it('is not started from auto-backfill, consolidation, or reconcile', () => {
    const ingest = readFileSync(join(__dirname, 'ingest.ts'), 'utf8')
    const consolidate = readFileSync(join(__dirname, 'consolidate.ts'), 'utf8')
    const index = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(ingest).not.toMatch(/startIntelligencePass/)
    expect(consolidate).not.toMatch(/startIntelligencePass|intelligence-pass/)
    expect(index).toMatch(/IPC\.brainIntelligencePass/)
    expect([...index.matchAll(/startIntelligencePass\(/g)]).toHaveLength(1)
    expect(index).toMatch(/return startIntelligencePass\(\)/)
  })

  it('never auto-sends mail or MCP from this pass', () => {
    const pass = readFileSync(join(__dirname, 'intelligence-pass.ts'), 'utf8')
    const route = readFileSync(join(__dirname, 'intelligence-pass-route.ts'), 'utf8')
    for (const src of [pass, route]) {
      expect(src).not.toMatch(/mcpPush|sendMail|autoSend|outlook.*send/i)
    }
  })
})
