import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { DealEntitySchema, type BrainIndex } from '@shared/brain'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { clearApiKey, getApiKey, getSettings, setApiKey, setSettings } from '../store'
import {
  brainBackfillProgress,
  enqueueIngest,
  ingestFailureCounts,
  ingestFailureDetails,
  isPendingIngestRecord,
  reconcileMeetingsInBackground,
  requestBackfill,
  settleCommitment,
  startBackfill,
  startRebuild,
  updateIndex,
  whenIndexWritesSettle
} from './ingest'
import { readDeal, readIndex, setDealOutcome, withEntityLock, writeDeal } from './store'

vi.mock('electron')

// Same disk-free stand-in the other ingest suites use: mirrors the real localBaseReady's two
// settings-driven checks (localLlm.enabled, the org allowlist) and skips its binary-on-disk /
// model-downloaded checks, which no test environment here can satisfy.
const localBaseReadyMock = vi.hoisted(() =>
  vi.fn((s: { localLlm: { enabled: boolean } }, allowed: string[] | null) => {
    if (!s.localLlm.enabled) return false
    if (allowed && !allowed.includes('local')) return false
    return true
  })
)
vi.mock('../llm/local-routing', () => ({ localBaseReady: localBaseReadyMock }))

// The sidecar's live state plus its attached-stream count — the two things brain ingest now reads before
// it is willing to occupy a local slot (MQA-048). Everything else stays real.
const localRuntimeStateMock = vi.hoisted(() => vi.fn<() => 'stopped' | 'starting' | 'running' | 'unavailable'>(() => 'stopped'))
const activeStreamsMock = vi.hoisted(() => vi.fn<() => number>(() => 0))
vi.mock('../llm/local-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/local-runtime')>()),
  getState: localRuntimeStateMock,
  activeStreams: activeStreamsMock
}))

const createStreamMock = vi.hoisted(() => vi.fn())
vi.mock('../llm', () => ({ createStream: createStreamMock }))

const refreshDustCliSessionMock = vi.hoisted(() => vi.fn())
vi.mock('../dustcli', () => ({ refreshDustCliSession: refreshDustCliSessionMock }))

// MQA-046 is an ORDERING defect: whether the store is still being written when it is wiped. The real
// purgeBrain is kept (the rebuild must genuinely work); it only records when it ran, relative to the
// index write that was in flight.
const trace = vi.hoisted(() => [] as string[])
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>()
  return {
    ...actual,
    purgeBrain: (...args: Parameters<typeof actual.purgeBrain>) => {
      trace.push('purge')
      return actual.purgeBrain(...args)
    }
  }
})

/**
 * The remaining audited ingest defects (docs/qa/BUG-LEDGER.md): a rebuild wiping the store out from under
 * an in-flight index write (MQA-046), a stalled backfill that never resumes (MQA-047), background
 * extraction monopolizing the on-device sidecar (MQA-048), a pending meeting reported as a failed one
 * (MQA-049), an expired Dust token that never self-heals during indexing (MQA-055), a connected Codex CLI
 * dropped from the waterfall (MQA-057), and an unserialized promise settlement (MQA-085).
 */
describe('brain ingest — audited fixes', () => {
  let userData: string
  let meetingsFolder: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    }, { timeout: 10_000 })
    await whenIndexWritesSettle()
  }

  const respondJson = (json = '{}') => (opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(json)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  }

  // Streams that stay open until the test decides — the only way to observe how many extractions are
  // actually in flight at once, and to hold jobs while the world changes underneath them.
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
  const writeMeeting = (name: string): string => {
    const file = join(meetingsFolder, name)
    writeFileSync(file, `---\ndate: 2026-08-08\n---\nAcme renewal call (${name}).`, 'utf8')
    return file
  }
  const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-audit-fixes-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-audit-fixes-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    // Same env-var sweep as the other ingest suites: a real provider key exported in this shell must
    // never leak an extra eligible cloud candidate into these tests.
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
    trace.length = 0
    createStreamMock.mockReset()
    refreshDustCliSessionMock.mockReset()
    localRuntimeStateMock.mockReturnValue('stopped')
    activeStreamsMock.mockReturnValue(0)
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

  // ── MQA-049 ────────────────────────────────────────────────────────────────

  it('MQA-049: a queued-but-never-attempted record is pending, not a failure', () => {
    // Exactly the four shapes idx.ingested can hold. The pending one is enqueueIngest's own literal:
    // ok:false with no error, not exhausted, zero attempts.
    const idx = {
      ingested: {
        'just-saved.md': { at: 4, ok: false, attempts: 0 },
        'broken.md': { at: 3, ok: false, error: 'provider said no', attempts: 2, retryAfter: 0 },
        'dead.md': { at: 2, ok: false, error: 'provider said no', attempts: 6, exhausted: true },
        'done.md': { at: 1, ok: true, attempts: 0 }
      }
    } as unknown as BrainIndex

    expect(isPendingIngestRecord(idx.ingested['just-saved.md'])).toBe(true)
    expect(isPendingIngestRecord(idx.ingested['broken.md'])).toBe(false)
    expect(isPendingIngestRecord(idx.ingested['dead.md'])).toBe(false)
    expect(isPendingIngestRecord(idx.ingested['done.md'])).toBe(false)

    // The pending meeting is not one of the two currently-failing sources, and it contributes no
    // "Unknown error" row to the attention rail.
    expect(ingestFailureCounts(idx, 1)).toEqual({ failed: 1, exhausted: 1, topError: 'provider said no' })
    expect(ingestFailureDetails(idx).map((d) => d.file)).toEqual(['broken.md', 'dead.md'])
  })

  it('MQA-049: a just-saved meeting still being extracted raises no failure banner', async () => {
    const file = writeMeeting('just-saved.md')
    allowProviders(['anthropic'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(holdStream)

    await enqueueIngest(file)
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })

    // The durable pending record exists (a quit here must replay the meeting, not lose it) — and the
    // dashboard must still say nothing is wrong while the extraction it describes is running normally.
    const idx = readIndex(getSettings())
    expect(idx.ingested['just-saved.md']).toMatchObject({ ok: false, attempts: 0 })
    expect(idx.ingested['just-saved.md']?.error).toBeUndefined()
    expect(ingestFailureCounts(idx)).toEqual({ failed: 0, exhausted: 0 })
    expect(ingestFailureDetails(idx)).toEqual([])

    releaseHeld()
    await vi.waitFor(() => expect(okCount()).toBe(1), { timeout: 10_000 })
    await whenIndexWritesSettle()
  })

  // ── MQA-085 ────────────────────────────────────────────────────────────────

  it('MQA-085: settling a promise waits for the entity lane an ingest merge holds', async () => {
    const s = getSettings()
    const DEAL = 'acme-renewal'
    await writeDeal(
      s,
      DEAL,
      DealEntitySchema.parse({
        name: 'Acme Renewal',
        account: 'Acme',
        commitments: [{ text: 'send revised pricing', meeting: 'kickoff.md' }]
      })
    )

    // Stand in for mergeExtraction mid-flight: it holds withEntityLock across its own read → writeAccount
    // → writeDeal, and that yield point is where an unlocked settle used to slip in and get overwritten.
    const order: string[] = []
    let releaseMerge!: () => void
    const mergeDone = new Promise<void>((resolve) => {
      releaseMerge = resolve
    })
    const merge = withEntityLock(async () => {
      await mergeDone
      order.push('ingest-merge')
    })

    const settled = settleCommitment(s, DEAL, 'send revised pricing', 'kept').then((r) => {
      order.push('settle')
      return r
    })
    await settle()
    releaseMerge()

    expect(await settled).toEqual({ ok: true })
    await merge
    expect(order).toEqual(['ingest-merge', 'settle'])
    expect(readDeal(s, DEAL)?.commitments[0].status).toBe('kept')
  })

  it('MQA-085: marking a deal won waits for the entity lane an ingest merge holds', async () => {
    const s = getSettings()
    const DEAL = 'acme-renewal'
    await writeDeal(s, DEAL, DealEntitySchema.parse({ name: 'Acme Renewal', account: 'Acme' }))

    const order: string[] = []
    let releaseMerge!: () => void
    const mergeDone = new Promise<void>((resolve) => {
      releaseMerge = resolve
    })
    const merge = withEntityLock(async () => {
      await mergeDone
      order.push('ingest-merge')
    })

    const marked = setDealOutcome(s, DEAL, 'won').then((d) => {
      order.push('set-outcome')
      return d
    })
    await settle()
    releaseMerge()

    expect((await marked)?.outcome).toBe('won')
    await merge
    expect(order).toEqual(['ingest-merge', 'set-outcome'])
    expect(readDeal(s, DEAL)?.outcome).toBe('won')
    expect(await setDealOutcome(s, 'no-such-deal', 'won')).toBeNull()
  })

  it('MQA-085: mutates a clone, never the cached entity another holder is still reading', async () => {
    const s = getSettings()
    const DEAL = 'acme-renewal'
    await writeDeal(
      s,
      DEAL,
      DealEntitySchema.parse({
        name: 'Acme Renewal',
        account: 'Acme',
        commitments: [{ text: 'send revised pricing', meeting: 'kickoff.md' }]
      })
    )
    // readJson hands back the SAME object on a repeat read of an unchanged file, so this is the very
    // reference an in-flight merge (or any earlier reader) is holding.
    const heldByAnotherReader = readDeal(s, DEAL)!
    expect(heldByAnotherReader.outcome).toBe('open')
    expect(heldByAnotherReader.commitments[0].status).toBe('open')

    expect((await setDealOutcome(s, DEAL, 'won'))?.outcome).toBe('won')
    expect(await settleCommitment(s, DEAL, 'send revised pricing', 'kept')).toEqual({ ok: true })

    // Persisted, and ONLY persisted — the other holder's snapshot still says what was on disk when it read.
    expect(readDeal(s, DEAL)?.outcome).toBe('won')
    expect(readDeal(s, DEAL)?.commitments[0].status).toBe('kept')
    expect(heldByAnotherReader.outcome).toBe('open')
    expect(heldByAnotherReader.commitments[0].status).toBe('open')
  })

  it('MQA-085: still reports the same errors for an unknown deal or commitment', async () => {
    const s = getSettings()
    await writeDeal(s, 'acme-renewal', DealEntitySchema.parse({ name: 'Acme Renewal', account: 'Acme' }))

    expect(await settleCommitment(s, 'nope', 'anything', 'kept')).toEqual({ ok: false, error: 'Deal not found.' })
    expect(await settleCommitment(s, 'acme-renewal', 'never promised', 'kept')).toEqual({
      ok: false,
      error: 'Commitment not found on this deal.'
    })
  })

  // ── MQA-055 ────────────────────────────────────────────────────────────────

  it('MQA-055: hands Dust a token refresher, and it re-mints and persists the session', async () => {
    writeMeeting('dust-indexed.md')
    allowProviders(['dust'])
    setApiKey('dust', 'stale-token')
    setSettings({ dustWorkspaceId: 'ws-old', dustBaseUrl: 'https://dust.tt' })
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    const opts = createStreamMock.mock.calls[0][0] as StreamOptions
    expect(opts.providerId).toBe('dust')
    expect(typeof opts.refreshDustAuth).toBe('function')

    // The ~1h OAuth token lapsed mid-backfill; dust.ts calls this on the pre-token auth failure and
    // replays the request once with what it returns.
    refreshDustCliSessionMock.mockResolvedValue({ ok: true, token: 'fresh-token', workspaceId: 'ws-new', baseUrl: 'https://eu.dust.tt' })
    await expect(opts.refreshDustAuth?.()).resolves.toEqual({
      apiKey: 'fresh-token',
      workspaceId: 'ws-new',
      baseURL: 'https://eu.dust.tt'
    })
    // Persisted as a side effect, so every later extraction in the same batch uses the fresh token.
    expect(getApiKey('dust')).toBe('fresh-token')
    expect(getSettings().dustWorkspaceId).toBe('ws-new')
    expect(getSettings().dustBaseUrl).toBe('https://eu.dust.tt')

    // A CLI that cannot re-mint yields null rather than a half-written session.
    refreshDustCliSessionMock.mockResolvedValue({ ok: false, error: 'no session' })
    await expect(opts.refreshDustAuth?.()).resolves.toBeNull()
  })

  it('MQA-055: never offers the Dust refresher to a non-Dust provider', async () => {
    writeMeeting('anthropic-indexed.md')
    allowProviders(['anthropic'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect((createStreamMock.mock.calls[0][0] as StreamOptions).refreshDustAuth).toBeUndefined()
  })

  // ── MQA-057 ────────────────────────────────────────────────────────────────
  // Fixed in this session's MQA-029 change (ingest.ts's `def.kind !== 'cli' && !model` exemption). Locked
  // here from the angle its own repro names: the local fallback is ON and eligible, so a codex-cli that
  // never enters the waterfall does not fail loudly — it is silently replaced by the 0.8B on-device model.

  it('MQA-057: a connected Codex CLI indexes the meeting instead of the on-device fallback', async () => {
    writeMeeting('codex-served.md')
    allowProviders(['codex-cli', 'local'])
    setSettings({ cliConnected: { 'codex-cli': true } })
    createStreamMock.mockImplementation(respondJson())

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested['codex-served.md']?.ok).toBe(true)
    expect(createStreamMock.mock.calls.map((c) => c[0].providerId)).toEqual(['codex-cli'])
  })

  // ── MQA-046 ────────────────────────────────────────────────────────────────

  it('MQA-046: lets every queued index.json write land before it purges the store', async () => {
    writeMeeting('indexed.md')
    allowProviders(['anthropic'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(respondJson())
    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    trace.length = 0
    // Exactly the state maybeFinishDrain leaves behind: an index mutation queued on the serialized lane,
    // deliberately un-awaited, with its tmp+rename still to come — and then, on the very next statement,
    // a rebuild. Its snapshot holds the PRE-purge ledger, so a rename landing after the wipe resurrects
    // "every meeting already indexed" over a brain that no longer has any.
    void updateIndex(getSettings(), (i) => {
      i.revision += 1
    }).then(() => trace.push('index-write'))

    const result = await startRebuild(getSettings())
    await waitForIdle()

    expect(result.error).toBeUndefined()
    expect(trace).toEqual(['index-write', 'purge'])
    // And the rebuild really did re-extract rather than find a resurrected "already ingested" ledger.
    expect(result.queued).toBe(1)
    expect(readIndex(getSettings()).ingested['indexed.md']?.ok).toBe(true)
  })

  // ── MQA-048 ────────────────────────────────────────────────────────────────

  it('MQA-048: keeps full extraction concurrency when a cloud provider serves the batch', async () => {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) writeMeeting(name)
    allowProviders(['anthropic'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(holdStream)

    expect(startBackfill()).toEqual({ queued: 4 })
    // The clamp below must not become a global slowdown: cloud extraction still runs three at a time.
    await vi.waitFor(() => expect(held).toHaveLength(3), { timeout: 10_000 })

    releaseHeld()
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })
    releaseHeld()
    await waitForIdle()
    expect(okCount()).toBe(4)
  })

  it('MQA-048: runs one extraction at a time when the on-device model is serving them', async () => {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) writeMeeting(name)
    allowProviders(['local']) // no cloud candidate: the sidecar is what indexes this profile
    createStreamMock.mockImplementation(holdStream)

    expect(startBackfill()).toEqual({ queued: 4 })
    // Three concurrent summary-mode requests all pin id_slot 1 — they cannot run in parallel, they only
    // take the slot the live meeting needs.
    await settle()
    expect(held).toHaveLength(1)

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })
      releaseHeld()
    }
    await waitForIdle()
    expect(okCount()).toBe(4)
    expect(createStreamMock).toHaveBeenCalledTimes(4)
  })

  it('MQA-048: background extraction yields the sidecar to a live local stream, and resumes after it', async () => {
    writeMeeting('during-a-meeting.md')
    allowProviders(['local'])
    createStreamMock.mockImplementation(holdStream)
    activeStreamsMock.mockReturnValue(1) // a live suggest/summary is attached right now

    expect(startBackfill()).toEqual({ queued: 1 })
    await settle()
    expect(held).toHaveLength(0)
    expect(createStreamMock).not.toHaveBeenCalled()
    // Parked, not dropped: the batch still owns the queue and still reports itself as running.
    expect(brainBackfillProgress()).toMatchObject({ total: 1, done: 0, running: true })

    activeStreamsMock.mockReturnValue(0) // the meeting's own stream finished
    reconcileMeetingsInBackground() // the 60s tick is the wake-up (same path as the MQA-023 stall)

    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })
    releaseHeld()
    await waitForIdle()
    expect(okCount()).toBe(1)
  })

  // ── MQA-047 ────────────────────────────────────────────────────────────────
  // Fixed in this session's MQA-023 change (hasJobsInFlight + the re-pump in requestBackfill /
  // reconcileMeetingsInBackground). Locked here from the angle MQA-047's own title names: the progress
  // bar frozen at N of M with nothing running. Runs last — a regression parks jobs in the module-level
  // queue, and that residue would contaminate every test after it.

  it('MQA-047: a backfill frozen at N of M by a mid-run provider loss resumes when a provider returns', async () => {
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) writeMeeting(name)
    allowProviders(['anthropic'])
    setApiKey('anthropic', 'fake-anthropic-key')
    createStreamMock.mockImplementation(holdStream)

    expect(startBackfill()).toEqual({ queued: 4 })
    await vi.waitFor(() => expect(held).toHaveLength(3), { timeout: 10_000 })

    // The key is rotated (or an admin pushes an allowlist) while the batch is running.
    allowProviders([])
    releaseHeld()

    // The frozen readout: 3 of 4, still "running", yet nothing is in flight and nothing can restart it.
    // Waited for on the progress counter rather than the index, because finishJob bumps `done` AFTER the
    // ok record lands — an okCount()-based wait can observe the batch one job earlier than the readout.
    await vi.waitFor(() => expect(brainBackfillProgress()).toMatchObject({ total: 4, done: 3, running: true }), { timeout: 10_000 })
    expect(okCount()).toBe(3)
    expect(createStreamMock).toHaveBeenCalledTimes(3)

    allowProviders(['anthropic']) // the fresh key is pasted
    requestBackfill({ respectRetryBackoff: true })

    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 })
    releaseHeld()
    await waitForIdle()
    expect(okCount()).toBe(4)
    expect(brainBackfillProgress()).toMatchObject({ total: 4, done: 4, running: false })
  })
})
