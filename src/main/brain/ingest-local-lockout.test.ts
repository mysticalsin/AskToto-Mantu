import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setSettings } from '../store'
import {
  brainBackfillProgress,
  startBackfill,
  startRebuild,
  whenIndexWritesSettle
} from './ingest'
import { readIndex } from './store'

vi.mock('electron')

const localBaseReadyMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('../llm/local-routing', () => ({ localBaseReady: localBaseReadyMock }))

// The runtime's session-long lockout ('unavailable', set after the restart budget is exhausted) is the
// exact condition under test. Mock getState so a test can put the runtime into that state deterministically
// without spawning a real llama-server; activeStreams is only read by the yield heuristic (0 is inert here).
const localRuntimeStateMock = vi.hoisted(() => vi.fn<() => string>(() => 'stopped'))
vi.mock('../llm/local-runtime', () => ({
  getState: localRuntimeStateMock,
  activeStreams: () => 0
}))

// verifyIntegrity is the model re-hash localOnlyRebuildBlocked runs to authorize a purge when local is
// the sole recourse. The fix makes the 'unavailable' branch return [] BEFORE startRebuild ever reaches
// that guard, so asserting this mock is never called proves the early refusal fired ahead of the purge
// path. Resolved (integrity OK) on purpose: without the fix the rebuild would sail past this check and
// purge, so a passing integrity mock is exactly what would let the old bug wipe the brain.
const verifyIntegrityMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../llm/local-models', () => ({ verifyIntegrity: verifyIntegrityMock }))

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

describe('brain ingest — exclusive local summary vs runtime lockout (MQA-271, MQA-018 parity)', () => {
  let userData: string
  let meetingsFolder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-local-lockout-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-local-lockout-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })

    // Local-only profile: getApiKey() short-circuits on a provider's env var before it reads the temp
    // profile, so sweep every real *_API_KEY the dev shell might export, or a cloud path could win.
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
        useFor: { suggest: true, summary: true, vision: true },
        fallback: false
      }
    })
    writeFileSync(
      join(meetingsFolder, 'local-only.md'),
      '---\ndate: 2026-07-14\n---\nCustomer asked for an offline follow-up next Tuesday.',
      'utf8'
    )
    vi.clearAllMocks()
    localBaseReadyMock.mockReturnValue(true)
    localRuntimeStateMock.mockReturnValue('stopped')
    verifyIntegrityMock.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('refuses to rebuild (never purges) when the exclusive local runtime is in the unavailable lockout', async () => {
    // Restart budget exhausted for the session: the model files are still on disk (localBaseReady true),
    // but llama-server cannot run until relaunch. Before the fix this branch still returned a `local`
    // candidate, so hasUsableProvider() authorized startRebuild's purge and every re-extraction then
    // failed against the dead runtime — a wiped brain that could not rebuild.
    localRuntimeStateMock.mockReturnValue('unavailable')

    const result = await startRebuild(getSettings())

    expect(result.queued).toBe(0)
    expect(result.error).toMatch(/Métis Local|Connect an AI provider/)
    // The fix returns [] so hasUsableProvider() is false and startRebuild refuses BEFORE the purge
    // path: verifyIntegrity (the purge-authorization re-hash) is never reached, and no extraction runs.
    // Without the fix, hasUsableProvider() would be true, verifyIntegrity would be called, and — since
    // the model files are intact here — the rebuild would purge and re-queue against the dead runtime.
    expect(verifyIntegrityMock).not.toHaveBeenCalled()
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('never falls through to a cloud provider when the local runtime is locked out (privacy invariant)', async () => {
    // A configured cloud key must NOT rescue an exclusive-local-summary user whose runtime is down —
    // that would silently upload a transcript the user chose to keep on-device.
    localRuntimeStateMock.mockReturnValue('unavailable')

    const result = await startRebuild(getSettings())

    expect(result.queued).toBe(0)
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('still processes exclusively on-device when the runtime is healthy (guard is narrow)', async () => {
    // Contrast: a non-'unavailable' state (the default cold 'stopped') leaves the exclusive local path
    // fully intact, so the guard only bites the genuine lockout and nothing else.
    localRuntimeStateMock.mockReturnValue('stopped')

    expect(startBackfill()).toEqual({ queued: 1 })
    await vi.waitFor(
      () => {
        expect(brainBackfillProgress().running).toBe(false)
      },
      { timeout: 10_000 }
    )
    await whenIndexWritesSettle()

    expect(readIndex(getSettings()).ingested['local-only.md']?.ok).toBe(true)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('local')
  })
})
