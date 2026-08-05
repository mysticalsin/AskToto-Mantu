import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { getSettings, setSettings, setApiKey } from '../store'
import { MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'
import {
  ingestExtraction,
  startBackfill,
  brainBackfillProgress,
  resumeBackfillIfPending,
  startRebuild,
  finishRebuildReplay,
  whenIndexWritesSettle
} from './ingest'
import { readIndex, writeIndex, readAccount, writeAccount, brainDir, slugify } from './store'
import { renameEntity } from './corrections'

vi.mock('electron')

// Every completion resolves instantly with an empty-but-schema-valid extraction — matches
// ingest-progress.test.ts's own convention. The second describe block below needs SOME backfill work to
// actually run through the real queue/pump machinery; the first uses ingestExtraction directly instead
// (no LLM call at all), so it can assert a SPECIFIC entity got renamed back by the replay.
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
 * MI-2.5-JOURNAL Fix E — brain:rebuildAll's `replayPending` flag (shared/brain.ts BrainIndexSchema) must
 * survive a quit/crash independently of `backfillRequested`, and resumeBackfillIfPending (ingest.ts) must
 * consume it on the next boot regardless of which flag combination survived.
 */
/**
 * Backfill work continues on the queue after the assertions return, and its final writeJson lands via
 * transcripts.ts's tmp+rename. Deleting the temp profile while that rename is still in flight makes it
 * reject with ENOENT on a thread nobody is awaiting — an UNHANDLED REJECTION that fails the whole vitest
 * run (exit 1) while every test still reports green, and only sometimes, which is the worst shape for
 * CI. Drain before teardown; same helper ingest-progress.test.ts already uses.
 */
const waitForIdle = async (): Promise<void> => {
  await vi.waitFor(() => {
    expect(brainBackfillProgress().running).toBe(false)
  })
  // running=false only means the QUEUE drained — the last job's own index.json record is still sitting
  // on the serialized write lane at that instant. resumeBackfillIfPending() is deliberately not awaited
  // by these tests, so that trailing write is exactly what races rmSync.
  await whenIndexWritesSettle()
}

describe('resumeBackfillIfPending resumes an interrupted rebuild replay (Fix E)', () => {
  let userData: string
  let meetingsFolder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-resume-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-resume-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-test-key-not-real')
  })

  afterEach(async () => {
    await waitForIdle()
    rmSync(userData, { recursive: true, force: true })
    rmSync(meetingsFolder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const accountExtraction = (): MeetingExtraction =>
    MeetingExtractionSchema.parse({ account: { name: 'Acme Corp', sector: 'banking', confidence: 'EXTRACTED' } })

  it('runs the pending replay directly when the backfill itself already finished before the crash (backfillRequested=false, replayPending=true)', async () => {
    const s = getSettings()
    const md = '---\ntype: meeting-transcript\nmode: "meeting"\ndate: 2026-06-01\n---\n\nhello'
    await ingestExtraction(s, accountExtraction(), md, join(meetingsFolder, 'm1.md'))
    const accountSlug = slugify('Acme Corp')
    const renamed = await renameEntity(s, { kind: 'account', id: accountSlug, newName: 'Acme' })
    expect(renamed.ok).toBe(true)
    expect(readAccount(s, accountSlug)?.name).toBe('Acme')

    // Simulate: brain:rebuildAll's purge+re-extraction already finished (backfillRequested cleared), and
    // re-ingest recreated the entity under its ORIGINAL name — but the crash landed before
    // replayCorrections got to re-apply the rename. replayPending alone must still trigger the resume.
    const working = readAccount(s, accountSlug)!
    working.name = 'Acme Corp'
    await writeAccount(s, accountSlug, working)
    const idx = readIndex(s)
    idx.backfillRequested = false
    idx.replayPending = true
    await writeIndex(s, idx)

    resumeBackfillIfPending()

    await vi.waitFor(() => {
      expect(readIndex(getSettings()).replayPending).toBe(false)
    })
    expect(readAccount(s, accountSlug)?.name).toBe('Acme') // replay re-applied the rename
  })

  it('finishes a resumed backfill AND still runs the pending replay once it drains, clearing both flags (backfillRequested=true, replayPending=true)', async () => {
    writeFileSync(join(meetingsFolder, 'leftover.md'), '---\ndate: 2026-01-01\n---\nhello', 'utf8')
    const s = getSettings()
    const idx = readIndex(s)
    idx.backfillRequested = true
    idx.replayPending = true
    await writeIndex(s, idx)

    resumeBackfillIfPending()

    await vi.waitFor(() => {
      expect(brainBackfillProgress().running).toBe(false)
    })
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).replayPending).toBe(false)
    })
    expect(readIndex(getSettings()).backfillRequested).toBe(false)
  })

  it('does nothing when neither flag is set', () => {
    expect(() => resumeBackfillIfPending()).not.toThrow()
    expect(brainBackfillProgress().running).toBe(false)
  })
})

/**
 * MI-2.5 review Fix 2 — a rebuild must never report success when the correction journal is corrupt/
 * blocked (0 corrections replayed): startRebuild refuses up front, and finishRebuildReplay leaves
 * replayPending set + records the error rather than silently clearing it.
 */
describe('rebuild refuses / surfaces a corrupt-journal replay failure (review Fix 2)', () => {
  let userData: string
  let meetingsFolder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-blocked-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-blocked-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-test-key-not-real')
  })
  afterEach(async () => {
    await waitForIdle()
    rmSync(userData, { recursive: true, force: true })
    rmSync(meetingsFolder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const blockTheJournal = async (): Promise<void> => {
    const s = getSettings()
    const md = '---\ntype: meeting-transcript\nmode: "meeting"\ndate: 2026-06-01\n---\n\nhello'
    await ingestExtraction(s, MeetingExtractionSchema.parse({ account: { name: 'Acme', sector: 'banking', confidence: 'EXTRACTED' } }), md, join(meetingsFolder, 'm1.md'))
    // Corrupt the journal, then trigger detection+quarantine so the durable block is armed.
    writeFileSync(join(brainDir(s), 'corrections.json'), '{ corrupt not an array', 'utf8')
    await renameEntity(s, { kind: 'account', id: slugify('Acme'), newName: 'Acme Two' }).catch(() => undefined)
  }

  it('startRebuild refuses (queued:0 + error) over a blocked journal, WITHOUT purging or setting replayPending', async () => {
    await blockTheJournal()
    const s = getSettings()
    const before = readAccount(s, slugify('Acme'))
    expect(before).toBeTruthy() // entities still present — nothing purged yet

    const r = await startRebuild(s)
    expect(r.queued).toBe(0)
    expect(r.error).toBeTruthy()
    expect(readAccount(s, slugify('Acme'))).toBeTruthy() // store NOT purged
    expect(readIndex(s).replayPending).toBe(false) // never entered the rebuild
  })

  it('finishRebuildReplay over a blocked journal leaves replayPending SET, records replayError, and pushes a human-visible warning', async () => {
    await blockTheJournal()
    const s = getSettings()
    // Simulate: a rebuild's backfill drained and its onDrained replay callback now runs against a journal
    // that turned out to be blocked.
    const idx = readIndex(s)
    idx.replayPending = true
    await writeIndex(s, idx)

    await finishRebuildReplay(s)

    const after = readIndex(s)
    expect(after.replayPending).toBe(true) // NOT cleared — the rebuild is not silently "finished"
    expect(after.replayError).toBeTruthy()
    expect(after.warnings.some((w) => /could not re-apply your saved corrections/i.test(w))).toBe(true)
  })

  it('finishRebuildReplay over a healthy journal clears replayPending, replayError, and its warning', async () => {
    const s = getSettings()
    const md = '---\ntype: meeting-transcript\nmode: "meeting"\ndate: 2026-06-01\n---\n\nhello'
    await ingestExtraction(s, MeetingExtractionSchema.parse({ account: { name: 'Acme', sector: 'banking', confidence: 'EXTRACTED' } }), md, join(meetingsFolder, 'm1.md'))
    await renameEntity(s, { kind: 'account', id: slugify('Acme'), newName: 'Acme Two' })

    const idx = readIndex(s)
    idx.replayPending = true
    idx.replayError = 'stale error'
    idx.warnings = ['Rebuild could not re-apply your saved corrections: stale error']
    await writeIndex(s, idx)

    await finishRebuildReplay(s)

    const after = readIndex(s)
    expect(after.replayPending).toBe(false)
    expect(after.replayError).toBeUndefined()
    expect(after.warnings.some((w) => /could not re-apply/i.test(w))).toBe(false)
  })
})
