import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { getSettings, setSettings, setApiKey } from '../store'
import { MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'
import { ingestExtraction, startBackfill, brainBackfillProgress, resumeBackfillIfPending } from './ingest'
import { readIndex, writeIndex, readAccount, writeAccount, slugify } from './store'
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

  afterEach(() => {
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
