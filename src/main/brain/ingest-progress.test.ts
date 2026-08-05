import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { getSettings, setSettings, setApiKey } from '../store'
import {
  startBackfill,
  requestBackfill,
  brainBackfillProgress,
  brainLiveIngestProgress,
  enqueueIngest,
  reconcileMeetingsInBackground,
  ingestExtraction, whenIndexWritesSettle } from './ingest'
import { MeetingExtractionSchema } from '@shared/brain'
import { readAccount, readIndex, slugify, writeMeetingExtraction } from './store'

vi.mock('electron')

// Every completion resolves instantly with an empty-but-schema-valid extraction (every
// MeetingExtractionSchema field has a zod .default()) — the merge/index-write path runs for real,
// only the network call is faked, matching the ROOT CAUSE under test: queue/progress bookkeeping
// across multiple backfill runs and concurrent enqueues, not extraction content. Wrapped in vi.fn()
// (not a bare arrow function) so individual tests can override one call via mockImplementationOnce.
vi.mock('../llm', () => ({
  createStream: vi.fn((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  })
}))

/**
 * R1 follow-ups (confirmed in the same audit pass as the no-provider bail):
 *  (a) backfillTotal/backfillDone are module-level and were never reset when a NEW backfill run starts
 *      after a previous one fully completed — a stale total/done from run #1 corrupted run #2's readout.
 *  (b) startBackfill()'s in-flight dedup only checked the `queue` array, but pump() splices the
 *      currently-processing job OUT of that array before it's spliced there — a second startBackfill()
 *      call while the first file is still mid-extraction re-queued the same file.
 */
describe('backfill progress bookkeeping across runs', () => {
  let userData: string
  let meetingsFolder: string

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    })
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-progress-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-progress-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    // getApiKey() short-circuits on the provider's env var before it reads the temp profile, so a
    // machine exporting a real KIMI_API_KEY / NVIDIA_API_KEY / … makes extra providers eligible and
    // the extraction failover walk longer than the mocks these tests queue. Sweep every provider key
    // var so anthropic below is the ONLY eligible candidate (same sweep store.test.ts uses; every name
    // in store.ts's ENV_VAR map ends in `_API_KEY`).
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
    }
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-test-key-not-real')
  })

  afterEach(async () => {
    // The queue draining is not the same as the writes landing: the last job’s index.json record is
    // still on ingest.ts’s serialized lane at that moment. Await it, or the stale write lands during
    // the NEXT test (and races this rmSync — ENOTEMPTY on the Windows CI runner).
    await whenIndexWritesSettle()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('resets total/done for a fresh run instead of accumulating stale counts from a finished one', async () => {
    writeFileSync(join(meetingsFolder, 'run1-a.md'), '---\ndate: 2026-01-01\n---\nhello', 'utf8')
    writeFileSync(join(meetingsFolder, 'run1-b.md'), '---\ndate: 2026-01-02\n---\nworld', 'utf8')

    const first = startBackfill()
    expect(first.queued).toBe(2)
    await waitForIdle()
    expect(brainBackfillProgress()).toEqual({ total: 2, done: 2, running: false })

    // A live meeting save AFTER the first backfill finished — with the pre-fix code, this incremented
    // backfillDone again just because backfillTotal was still > 0 from the completed run.
    writeFileSync(join(meetingsFolder, 'live-1.md'), '---\ndate: 2026-01-03\n---\nlive', 'utf8')
    enqueueIngest(join(meetingsFolder, 'live-1.md'))
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['live-1.md']?.ok).toBe(true)
    })
    expect(brainBackfillProgress()).toEqual({ total: 2, done: 2, running: false }) // untouched by the live job

    // A second, later backfill run over new transcripts must start its OWN fresh total/done, not
    // continue accumulating onto run #1's already-finished 2/2.
    writeFileSync(join(meetingsFolder, 'run2-a.md'), '---\ndate: 2026-02-01\n---\nfoo', 'utf8')
    const second = startBackfill()
    expect(second.queued).toBe(1)
    expect(brainBackfillProgress().total).toBe(1) // not 3 — reset, not accumulated
    await waitForIdle()
    expect(brainBackfillProgress()).toEqual({ total: 1, done: 1, running: false })
  })

  it('does not re-queue the file currently mid-extraction when startBackfill is called again', async () => {
    writeFileSync(join(meetingsFolder, 'slow.md'), '---\ndate: 2026-01-01\n---\nslow', 'utf8')

    // Hold the in-flight extraction open so the file is spliced out of `queue` (pump() picked it up)
    // but not yet finished — exactly the window the pre-fix dedup missed.
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { createStream } = await import('../llm')
    vi.mocked(createStream).mockImplementationOnce((opts) => {
      void gate.then(() => {
        opts.handlers.onDelta('{}')
        opts.handlers.onDone({})
      })
      return { abort: () => {} }
    })

    const first = startBackfill()
    expect(first.queued).toBe(1)
    // Give pump() a tick to splice the job out of `queue` and start processing it.
    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(true)
    })

    // Re-click "Index meetings" while the only candidate file is still mid-extraction.
    const second = startBackfill()
    expect(second.queued).toBe(0) // the in-flight file must not be queued a second time

    releaseFirst()
    await waitForIdle()
    expect(brainBackfillProgress()).toEqual({ total: 1, done: 1, running: false })
  })

  it('keeps an automatic live ingest separate from a zero-item Index request', async () => {
    const liveFile = join(meetingsFolder, 'live-only.md')
    writeFileSync(liveFile, '---\ndate: 2026-01-03\n---\nlive meeting still extracting', 'utf8')

    // Keep the automatic ingest open. The historical-index scan sees this same file in-flight and
    // therefore has no legitimate candidate to queue.
    let releaseLive: () => void = () => {}
    let liveExtractionStarted = false
    const gate = new Promise<void>((resolve) => {
      releaseLive = resolve
    })
    const { createStream } = await import('../llm')
    vi.mocked(createStream).mockImplementationOnce((opts) => {
      liveExtractionStarted = true
      void gate.then(() => {
        opts.handlers.onDelta('{}')
        opts.handlers.onDone({})
      })
      return { abort: () => {} }
    })

    await enqueueIngest(liveFile)
    await vi.waitFor(() => {
      expect(liveExtractionStarted).toBe(true)
    })

    // A live-only job must not be painted as a user-requested batch.
    expect(brainBackfillProgress().running).toBe(false)
    expect(startBackfill()).toEqual({ queued: 0 })
    expect(brainBackfillProgress()).toEqual({ total: 0, done: 0, running: false })
    // The in-flight save is durably marked so quitting at this exact point resumes it on next launch.
    expect(readIndex(getSettings()).backfillRequested).toBe(true)

    releaseLive()
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['live-only.md']?.ok).toBe(true)
    })
  })

  it('persists a live meeting as pending background work, then clears that state only after it is indexed', async () => {
    const liveFile = join(meetingsFolder, 'durable-live.md')
    writeFileSync(liveFile, '---\ndate: 2026-01-04\n---\nkeep this meeting current after a restart', 'utf8')

    let releaseLive: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseLive = resolve
    })
    const { createStream } = await import('../llm')
    vi.mocked(createStream).mockImplementationOnce((opts) => {
      void gate.then(() => {
        opts.handlers.onDelta('{}')
        opts.handlers.onDone({})
      })
      return { abort: () => {} }
    })

    await enqueueIngest(liveFile)
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).backfillRequested).toBe(true)
      expect(brainLiveIngestProgress()).toEqual({ pending: 1, running: true })
    })

    releaseLive()
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['durable-live.md']?.ok).toBe(true)
      expect(brainLiveIngestProgress()).toEqual({ pending: 0, running: false })
      expect(readIndex(getSettings()).backfillRequested).toBe(false)
    })
  })

  it('reconciles a saved extraction with no successful ingest record instead of making Index meetings a no-op', async () => {
    const file = 'partial-after-write.md'
    writeFileSync(join(meetingsFolder, file), '---\ndate: 2026-01-05\n---\nAcme asked for a follow-up.', 'utf8')
    await writeMeetingExtraction(
      getSettings(),
      slugify(file),
      MeetingExtractionSchema.parse({
        title24: 'Acme follow-up',
        account: { name: 'Acme', sector: 'technology', confidence: 'EXTRACTED' }
      })
    )

    // This models a crash or OneDrive error after extraction.json was saved but before entity merge +
    // index.json could record success. It must re-merge the saved extraction without calling the model.
    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(readIndex(getSettings()).ingested[file]?.ok).toBe(true)
    expect(readAccount(getSettings(), slugify('Acme'))?.meetings.map((m) => m.file)).toContain(file)
  })

  it('reconciles the meeting folder in the background without waiting for someone to open Intelligence', async () => {
    const file = 'background-scan.md'
    writeFileSync(join(meetingsFolder, file), '---\ndate: 2026-01-06\n---\nA synced meeting should be indexed automatically.', 'utf8')

    reconcileMeetingsInBackground()

    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested[file]?.ok).toBe(true)
    })
    // The index write lands before the queue drains — leaving the pump running would let this test's
    // backfill spill into the NEXT test's temp profile and eat its mockImplementationOnce responses.
    await waitForIdle()
  })

  it('returns a preparing state before scanning a historical meeting folder', async () => {
    writeFileSync(join(meetingsFolder, 'queued-from-ui.md'), '---\ndate: 2026-01-04\n---\nprepare the folder before mapping', 'utf8')

    // The UI must get a state to animate before the synchronous folder scan starts on the next turn.
    expect(requestBackfill()).toEqual({ queued: 0, preparing: true })
    expect(brainBackfillProgress()).toMatchObject({ preparing: true, running: true })

    await vi.waitFor(() => {
      expect(readIndex(getSettings()).ingested['queued-from-ui.md']?.ok).toBe(true)
    })
    await waitForIdle() // same reason: don't hand a still-running pump to the next test
  })

  it('counts a failed extraction separately so completed queue work is not presented as mapped', async () => {
    writeFileSync(join(meetingsFolder, 'fails.md'), '---\ndate: 2026-01-01\n---\nthis extraction fails', 'utf8')

    // extractMeeting intentionally retries once. Reject both attempts so the backfill settles with a
    // durable failed index record rather than a successful retry.
    const { createStream } = await import('../llm')
    vi.mocked(createStream)
      .mockImplementationOnce((opts) => {
        queueMicrotask(() => opts.handlers.onError('404 page not found'))
        return { abort: () => {} }
      })
      .mockImplementationOnce((opts) => {
        queueMicrotask(() => opts.handlers.onError('404 page not found'))
        return { abort: () => {} }
      })

    expect(startBackfill()).toEqual({ queued: 1 })
    await waitForIdle()

    expect(brainBackfillProgress()).toMatchObject({
      total: 1,
      done: 1,
      failed: 1,
      running: false
    })
  })

  it('rebuilds changed indexed sources so facts removed from a meeting cannot remain in Intelligence', async () => {
    const file = 'source-edited.md'
    const path = join(meetingsFolder, file)
    const original = '---\ndate: 2026-01-07\n---\nAcme discussed the original scope.'
    writeFileSync(path, original, 'utf8')
    await ingestExtraction(
      getSettings(),
      MeetingExtractionSchema.parse({ account: { name: 'Acme', sector: 'technology', confidence: 'EXTRACTED' } }),
      original,
      path,
      original
    )
    expect(readAccount(getSettings(), slugify('Acme'))).not.toBeNull()

    // Same filename, materially different source. A normal incremental merge cannot remove Acme's old
    // entity, so the background scan must perform a clean rebuild before presenting current Intelligence.
    writeFileSync(path, '---\ndate: 2026-01-07\n---\nA different topic replaced the original scope entirely.', 'utf8')
    reconcileMeetingsInBackground()

    await vi.waitFor(() => {
      const idx = readIndex(getSettings())
      expect(idx.sourceRefreshRequested).toBe(false)
      expect(idx.ingested[file]?.ok).toBe(true)
      expect(readAccount(getSettings(), slugify('Acme'))).toBeNull()
      expect(idx.revision).toBeGreaterThan(1)
    })
    await waitForIdle() // same reason: don't hand a still-running pump to the next test
  })

  it('removes derived facts when an indexed source is deleted by sync or retention', async () => {
    const file = 'source-deleted.md'
    const path = join(meetingsFolder, file)
    const source = '---\ndate: 2026-01-08\n---\nGlobex discussed a renewal.'
    writeFileSync(path, source, 'utf8')
    await ingestExtraction(
      getSettings(),
      MeetingExtractionSchema.parse({ account: { name: 'Globex', sector: 'technology', confidence: 'EXTRACTED' } }),
      source,
      path,
      source
    )
    expect(readAccount(getSettings(), slugify('Globex'))).not.toBeNull()

    unlinkSync(path)
    reconcileMeetingsInBackground()

    await vi.waitFor(() => {
      const idx = readIndex(getSettings())
      expect(idx.sourceRefreshRequested).toBe(false)
      expect(idx.ingested[file]).toBeUndefined()
      expect(readAccount(getSettings(), slugify('Globex'))).toBeNull()
    })
  })
})
