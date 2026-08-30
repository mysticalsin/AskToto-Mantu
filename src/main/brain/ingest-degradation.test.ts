import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getSettings, setApiKey, setSettings } from '../store'
import {
  brainBackfillProgress,
  reconcileMeetingsInBackground,
  requestBackfill,
  startBackfill,
  startRebuild,
  whenIndexWritesSettle
} from './ingest'
import { listMeetingExtractions, readIndex } from './store'

vi.mock('electron')

// Same disk-free stand-in ingest-index-fallback.test.ts uses: mirrors the real localBaseReady's two
// settings-driven checks (localLlm.enabled, the org allowlist) and skips its binary-on-disk /
// model-downloaded checks, which no test environment here can satisfy. local-routing.test.ts owns the
// real function's logic; this suite is only responsible for what ingest.ts does with the answer.
const localBaseReadyMock = vi.hoisted(() =>
  vi.fn((s: { localLlm: { enabled: boolean } }, allowed: string[] | null) => {
    if (!s.localLlm.enabled) return false
    if (allowed && !allowed.includes('local')) return false
    return true
  })
)
vi.mock('../llm/local-routing', () => ({
  localBaseReady: localBaseReadyMock,
  resolveRoutingMode: (s: { routingMode?: string }) => s.routingMode ?? 'auto'
}))

// The sidecar's live lifecycle state. Real llama-server latches 'unavailable' for the rest of the session
// once its restart budget is exhausted (local-runtime.ts) — the condition MQA-018 is about. Only getState
// is replaced; everything else stays real so nothing else in the graph changes shape.
const localRuntimeStateMock = vi.hoisted(() => vi.fn<() => 'stopped' | 'starting' | 'running' | 'unavailable'>(() => 'stopped'))
vi.mock('../llm/local-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/local-runtime')>()),
  getState: localRuntimeStateMock
}))

// The model-load precheck the destructive rebuild path runs when local is the ONLY candidate (MQA-018).
// The real one re-hashes both GGUFs against the manifest and checks the RAM floor; no test environment
// here ships those files, so it stands in for "the model would load" the same way localBaseReadyMock
// stands in for the on-disk provisioning checks. local-models.ts owns the real implementation.
const verifyIntegrityMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}))
vi.mock('../llm/local-models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/local-models')>()),
  verifyIntegrity: verifyIntegrityMock
}))

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

/**
 * What meeting indexing does when the AI provider underneath it dies. Four audited defects share that
 * one story (docs/qa/BUG-LEDGER.md): the failover walk stopping short of the on-device last resort
 * (MQA-022), a rebuild wiping a brain no live runtime can recreate (MQA-018), a queue that never restarts
 * after a mid-batch provider loss (MQA-023), and a connected Codex CLI never entering the waterfall at all
 * (MQA-029).
 */
describe('brain ingest — provider-degradation paths', () => {
  let userData: string
  let meetingsFolder: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    // MQA-007: `running` going false is NOT "every write has landed" — the last job's own index record
    // is still queued on the serialized lane at that moment (see whenIndexWritesSettle's own note). Every
    // assertion after this reads index.json, so settling here is what makes them deterministic.
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

  // Streams that stay open until the test decides — the only way to hold jobs in flight while the
  // provider is taken away underneath them (the MQA-023 stall).
  const held: StreamHandlers[] = []
  const holdStream = (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    held.push(opts.handlers)
    return { abort: () => {} }
  }
  const releaseHeld = (json = '{}'): void => {
    for (const handlers of held.splice(0, held.length)) {
      handlers.onDelta(json)
      handlers.onDone({} as never)
    }
  }
  const allowProviders = (providers: string[]): void => {
    writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: providers }), 'utf8')
  }
  const okCount = (): number => Object.values(readIndex(getSettings()).ingested).filter((r) => r.ok).length

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-degradation-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-degradation-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    // Same env-var sweep as ingest-resilience.test.ts / ingest-index-fallback.test.ts: a real provider key
    // exported in this shell must never leak an extra eligible cloud candidate into these tests.
    for (const p of PROVIDER_IDS) clearApiKey(p)
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({
      meetingsFolder,
      cliConnected: {},
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: true, summary: false, vision: true }, // summary OFF: the cloud-waterfall branch
        fallback: true
      }
    })
    held.length = 0
    createStreamMock.mockReset()
    localRuntimeStateMock.mockReturnValue('stopped')
    verifyIntegrityMock.mockReset()
    verifyIntegrityMock.mockResolvedValue(undefined)
    localBaseReadyMock.mockClear()
    localBaseReadyMock.mockImplementation((s: { localLlm: { enabled: boolean } }, allowed: string[] | null) => {
      if (!s.localLlm.enabled) return false
      if (allowed && !allowed.includes('local')) return false
      return true
    })
  })

  afterEach(async () => {
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // ── MQA-022 ────────────────────────────────────────────────────────────────

  it('MQA-022: fails over to local when a provider rejects the credential with no HTTP status in the message', async () => {
    writeFileSync(join(meetingsFolder, 'expired-token.md'), '---\ndate: 2026-02-01\n---\nAcme renewal call.', 'utf8')
    allowProviders(['anthropic', 'local'])
    setApiKey('anthropic', 'fake-anthropic-key')
    // Verbatim Dust phrasing (pinned in llm/dust.test.ts): an expired OAuth token surfaces as prose with
    // no status code, because dust.ts passes only `.message` and the 401 is discarded before ingest sees
    // it. The old digit-shaped gate read this as PERMANENT and threw instead of hopping.
    createStreamMock.mockImplementation((opts: StreamOptions & { handlers: StreamHandlers }) =>
      opts.providerId === 'anthropic'
        ? respondError('The user request does not have a valid authenticated credential.')(opts)
        : respondJson()(opts)
    )

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['expired-token.md']?.ok).toBe(true)
    expect(createStreamMock.mock.calls.map((c) => c[0].providerId)).toEqual(['anthropic', 'local'])
  })

  it('MQA-022: still refuses to fail over on a deliberate cancel', async () => {
    writeFileSync(join(meetingsFolder, 'cancelled.md'), '---\ndate: 2026-02-02\n---\nAcme call.', 'utf8')
    allowProviders(['anthropic', 'local'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation((opts: StreamOptions & { handlers: StreamHandlers }) =>
      opts.providerId === 'anthropic' ? respondError('The request was aborted.')(opts) : respondJson()(opts)
    )

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    // An abort means the user is gone, not that this provider is broken — the walk must stop, so local is
    // never contacted (2 calls = first attempt + extractMeeting's same-provider reminder retry).
    expect(readIndex(getSettings()).ingested['cancelled.md']?.ok).toBe(false)
    expect(createStreamMock.mock.calls.map((c) => c[0].providerId)).toEqual(['anthropic', 'anthropic'])
  })

  // ── MQA-029 ────────────────────────────────────────────────────────────────

  it('MQA-029: indexes through a connected CLI provider that has no configured model id', async () => {
    writeFileSync(join(meetingsFolder, 'codex-only.md'), '---\ndate: 2026-02-03\n---\nAcme pricing call.', 'utf8')
    // The Codex-only install: no API keys, Local AI excluded by policy, so codex-cli is the ONLY thing
    // that can index this meeting. PROVIDERS['codex-cli'] ships models: [] — resolveModelTier returns ''.
    allowProviders(['codex-cli'])
    setSettings({ cliConnected: { 'codex-cli': true } })
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['codex-only.md']?.ok).toBe(true)
    expect(createStreamMock).toHaveBeenCalledTimes(1)
    expect(createStreamMock.mock.calls[0][0].providerId).toBe('codex-cli')
    // Passed through empty exactly as resolved: cli.ts omits -m entirely and lets Codex use its default.
    expect(createStreamMock.mock.calls[0][0].model).toBe('')
  })

  // ── MQA-018 ────────────────────────────────────────────────────────────────

  it('MQA-018: refuses to purge the brain when the only candidate is a local runtime that cannot run', async () => {
    writeFileSync(join(meetingsFolder, 'indexed.md'), '---\ndate: 2026-02-04\n---\nAcme renewal call.', 'utf8')
    allowProviders(['local']) // zero cloud candidates: the Cahê pilot with its one key removed
    createStreamMock.mockImplementation(respondJson())
    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()
    expect(listMeetingExtractions(getSettings())).toHaveLength(1)

    // llama-server exhausted its restart budget (or never had the RAM): a session-long lockout that
    // localBaseReady cannot see, because it only checks provisioning.
    localRuntimeStateMock.mockReturnValue('unavailable')
    createStreamMock.mockClear()
    createStreamMock.mockImplementation(respondError('local runtime unavailable for this session'))

    const result = await startRebuild(getSettings())

    expect(result.error).toContain('Connect an AI provider')
    expect(result.queued).toBe(0)
    // The derived store survived: an automatic source-refresh rebuild must never wipe entities/extractions
    // it is about to discover nothing can recreate.
    expect(listMeetingExtractions(getSettings())).toHaveLength(1)
    expect(readIndex(getSettings()).ingested['indexed.md']?.ok).toBe(true)
    expect(createStreamMock).not.toHaveBeenCalled()
  })

  it('MQA-018: still rebuilds on local alone while the runtime is healthy', async () => {
    writeFileSync(join(meetingsFolder, 'healthy-local.md'), '---\ndate: 2026-02-05\n---\nAcme call.', 'utf8')
    allowProviders(['local'])
    createStreamMock.mockImplementation(respondJson())
    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    // 'stopped' is the normal idle state (the sidecar stops after 15 idle minutes) — it is not a lockout,
    // so the last-resort fallback must keep authorizing the rebuild that indexes an on-device-only install.
    const result = await startRebuild(getSettings())
    await waitForIdle()

    expect(result.error).toBeUndefined()
    expect(result.queued).toBe(1)
    expect(readIndex(getSettings()).ingested['healthy-local.md']?.ok).toBe(true)
  })

  /** The two variants the runtime-state gate above cannot see, because neither ever reaches the sidecar:
   *  a machine under the model's declared RAM floor (assertRamOk) and a model file whose bytes match the
   *  manifest's size but not its sha256 (a half-synced or corrupted download). Both throw on EVERY cold
   *  start, so a purge authorized on "local is configured" deletes a brain that nothing can then recreate. */
  for (const variant of [
    { label: 'the machine is under the model RAM floor', error: 'Local model "qwen3.5-0.8b" needs 8 GB of RAM; this machine has 4 GB.' },
    { label: 'the model file is corrupt', error: 'Local model "qwen3.5-0.8b" (gguf) failed its checksum check.' }
  ]) {
    it(`MQA-018: refuses to purge when local is the only candidate and ${variant.label}`, async () => {
      writeFileSync(join(meetingsFolder, 'precious.md'), '---\ndate: 2026-02-07\n---\nAcme renewal call.', 'utf8')
      allowProviders(['local'])
      createStreamMock.mockImplementation(respondJson())
      expect(startBackfill()).toEqual({ queued: 1 })
      await waitForIdle()
      expect(listMeetingExtractions(getSettings())).toHaveLength(1)

      // 'stopped' is the healthy idle state — the restart-budget lockout is NOT what fails here. The model
      // simply cannot be loaded, and only the integrity/RAM precheck can tell.
      localRuntimeStateMock.mockReturnValue('stopped')
      verifyIntegrityMock.mockRejectedValue(new Error(variant.error))
      createStreamMock.mockClear()

      const result = await startRebuild(getSettings())

      expect(result.queued).toBe(0)
      expect(result.error).toContain('cannot load its model')
      expect(result.error).toContain(variant.error)
      // The whole point: the derived store is still there, and no re-extraction was ever attempted.
      expect(listMeetingExtractions(getSettings())).toHaveLength(1)
      expect(readIndex(getSettings()).ingested['precious.md']?.ok).toBe(true)
      expect(createStreamMock).not.toHaveBeenCalled()
    })
  }

  it('MQA-018: a keyed cloud provider rebuilds without paying for the local model precheck', async () => {
    writeFileSync(join(meetingsFolder, 'cloud.md'), '---\ndate: 2026-02-08\n---\nAcme call.', 'utf8')
    allowProviders(['anthropic', 'local'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondJson())
    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    // A corrupt local model is irrelevant when a cloud candidate can recreate the brain — and re-hashing
    // gigabytes to discover that would be pure cost on the common path.
    verifyIntegrityMock.mockRejectedValue(new Error('Local model "qwen3.5-0.8b" (gguf) failed its checksum check.'))

    const result = await startRebuild(getSettings())
    await waitForIdle()

    expect(result.error).toBeUndefined()
    expect(result.queued).toBe(1)
    expect(verifyIntegrityMock).not.toHaveBeenCalled()
  })

  // ── MQA-023 ────────────────────────────────────────────────────────────────
  // Both stall tests run last: they leave jobs parked in the module-level queue if the fix regresses, and
  // that residue would otherwise contaminate every test after them.

  /** Queue 4 backfill jobs, let 3 occupy the workers, then remove the provider so pump() parks the 4th.
   *  Returns once the queue is genuinely stalled: nothing in flight, one job that can never restart itself. */
  const stallBackfillMidBatch = async (): Promise<void> => {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      writeFileSync(join(meetingsFolder, name), `---\ndate: 2026-02-06\n---\nAcme call ${name}.`, 'utf8')
    }
    allowProviders(['anthropic'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(holdStream)

    expect(startBackfill()).toEqual({ queued: 4 })
    // EXTRACT_CONCURRENCY jobs occupy the workers; the 4th waits in the queue.
    await vi.waitFor(() => expect(held).toHaveLength(3), { timeout: 10_000 })

    // The user clears the dead key mid-batch (Settings → AI) intending to paste a fresh one.
    allowProviders([])
    releaseHeld()

    await vi.waitFor(() => expect(okCount()).toBe(3), { timeout: 10_000 })
    expect(createStreamMock).toHaveBeenCalledTimes(3) // the 4th job never started
    expect(brainBackfillProgress().running).toBe(true) // ...and the progress bar says otherwise

    allowProviders(['anthropic']) // the fresh key is pasted
  }

  it('MQA-023: Retry index revives a backfill stalled by a mid-batch provider loss', async () => {
    await stallBackfillMidBatch()

    // BrainView's "Retry index" button → brainBackfill IPC → requestBackfill. It short-circuited on
    // hasActiveBackfill() and did nothing at all, leaving the last meeting unindexed for the session.
    requestBackfill()

    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })
    releaseHeld()
    await waitForIdle()

    expect(okCount()).toBe(4)
    expect(createStreamMock).toHaveBeenCalledTimes(4)
  })

  it('MQA-023: the periodic reconcile tick revives a backfill stalled by a mid-batch provider loss', async () => {
    await stallBackfillMidBatch()

    // The 60s background tick — the recovery path that must not depend on the user finding a button.
    reconcileMeetingsInBackground()

    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })
    releaseHeld()
    await waitForIdle()

    expect(okCount()).toBe(4)
    expect(createStreamMock).toHaveBeenCalledTimes(4)
  })

  // MQA-100 (docs/qa/BUG-LEDGER.md): observed on a real physical run — the bundled 0.8B model returned an
  // unterminated object and the meeting failed with "No complete JSON object in model output", leaving it
  // unindexed until a later reconcile happened to retry it. Now that on-device extraction is the DEFAULT
  // fallback, "usually valid JSON" is not good enough: llama-server compiles response_format into a GBNF
  // grammar and masks any token that would break the syntax, making truncation impossible.
  describe('on-device extraction asks for constrained JSON decoding (MQA-100)', () => {
    it('sends response_format for a LOCAL extraction, so invalid JSON becomes unrepresentable', async () => {
      writeFileSync(join(meetingsFolder, 'grammar-local.md'), '---\ndate: 2026-01-10\n---\nAcme call.', 'utf8')
      writeFileSync(join(userData, 'managed-config.json'), JSON.stringify({ allowedProviders: ['local'] }), 'utf8')
      createStreamMock.mockImplementation(respondJson())

      expect(startBackfill()).toEqual({ queued: 1 })
      await waitForIdle()

      const localCall = createStreamMock.mock.calls.find((c) => c[0].providerId === 'local')
      expect(localCall, 'expected a local extraction call').toBeTruthy()
      expect(localCall![0].responseFormat).toEqual({ type: 'json_object' })
    })

    it('does NOT send it to a cloud provider — never risk a working path to fix one that is not broken', async () => {
      writeFileSync(join(meetingsFolder, 'grammar-cloud.md'), '---\ndate: 2026-01-11\n---\nAcme call.', 'utf8')
      setApiKey('anthropic', 'fake-anthropic-key')
      createStreamMock.mockImplementation(respondJson())

      expect(startBackfill()).toEqual({ queued: 1 })
      await waitForIdle()

      const cloudCall = createStreamMock.mock.calls.find((c) => c[0].providerId === 'anthropic')
      expect(cloudCall, 'expected a cloud extraction call').toBeTruthy()
      expect(cloudCall![0].responseFormat).toBeUndefined()
    })
  })

})
