import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { setSettings, setApiKey } from '../store'
import { startBackfill, brainBackfillProgress, enqueueIngest } from './ingest'

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
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-test-key-not-real')
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(meetingsFolder, { recursive: true, force: true })
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
    await waitForIdle()
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
})
