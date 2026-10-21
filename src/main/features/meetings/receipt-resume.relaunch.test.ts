import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelaunchHarness, readRaw, type RelaunchHarness } from '../../../test-helpers/relaunch-harness'

vi.mock('electron')
const productionStages = vi.hoisted(() => ({
  scheduleRebuild: vi.fn(async () => undefined),
  enqueueIngest: vi.fn(async (_path: string, _options: { deferred: boolean }) => undefined)
}))
vi.mock('../../graphify', () => ({ scheduleRebuild: productionStages.scheduleRebuild }))
vi.mock('../../brain/ingest', () => ({ enqueueIngest: productionStages.enqueueIngest }))

/** Where this module-reset harness simulates a restart boundary; it does not kill an OS process. */
type RestartBoundary = 'after-saved-written' | 'after-draft-cleanup' | 'after-rebuild' | 'after-ingest'
const RESTART_BOUNDARIES: readonly RestartBoundary[] = [
  'after-saved-written',
  'after-draft-cleanup',
  'after-rebuild',
  'after-ingest'
]

let nextStartedAt = 1_700_000_500_123
let harness: RelaunchHarness | undefined
let journalDir: string | undefined

afterEach(async () => {
  await harness?.dispose()
  if (journalDir) await rm(journalDir, { recursive: true, force: true })
  harness = undefined
  journalDir = undefined
})

const freshProcess = async () => {
  vi.resetModules()
  const storage = await import('../../infra/storage/meetings-storage')
  storage.useStorageForTests()
  const speech = await import('./meeting-speech')
  speech.configureMeetingSpeechLimits({
    maxFieldBytes: 64 * 1024,
    maxPayloadBytes: 1024 * 1024,
    maxRecordBytes: 64 * 1024,
    maxRecords: 100,
    maxWords: 10_000
  })
  return {
    transcripts: await import('../../transcripts'),
    receipts: await import('../../transcript-save-receipts'),
    journal: await import('../../infra/storage/transcript-receipt-journal'),
    recovery: await import('./draft-recovery'),
    mainReceipts: await import('./main-save-receipts')
  }
}

/** Mock effects across module graphs; this is not a process-kill or exactly-once oracle. */
interface Effects {
  credits: number
  rebuilds: number
  ingests: string[]
}

async function setup() {
  expect(vi.isFakeTimers()).toBe(false)
  const h = (harness = await createRelaunchHarness(nextStartedAt))
  nextStartedAt += 1_000
  journalDir = await mkdtemp(join(tmpdir(), 'metis-receipt-journal-'))
  const journalFile = join(journalDir, 'transcript-receipts', 'receipts.v1.json')
  const folderIdSha256 = createHash('sha256').update(resolve(h.folder)).digest('hex')
  const effects: Effects = { credits: 0, rebuilds: 0, ingests: [] }
  const startedAt = h.meeting.startedAt
  productionStages.scheduleRebuild.mockReset()
  productionStages.scheduleRebuild.mockImplementation(async () => {
    effects.rebuilds++
  })
  productionStages.enqueueIngest.mockReset()

  /** One module graph saves through the receipt store and stops at the selected simulated boundary. */
  const saveUntilBoundary = async (boundary: RestartBoundary): Promise<string> => {
    const p = await freshProcess()
    await p.transcripts.saveDraftTranscript(h.settings, h.meeting)
    const store = new p.receipts.TranscriptSaveReceiptStore(256, {
      journal: p.journal.createReceiptJournal(journalFile),
      locate: (path) => ({ savedBasename: basename(path), folderIdSha256, revision: 0 }),
      newId: () => 'receipt-1'
    })
    let died!: (file: string) => void
    const death = new Promise<string>((r) => (died = r))
    const simulateBoundary = (file: string): Promise<never> => {
      died(file)
      return new Promise<never>(() => {}) // leave the first module graph pending while the test opens another
    }
    void store.run(`1:${'c'.repeat(64)}`, { startedAt, authGeneration: 1 }, async (receipt) => {
      // The order and receipt fields of the IPC.saveTranscript handler.
      receipt.normalizedStartedAt = startedAt
      receipt.settings = h.settings
      receipt.durablePath = await p.transcripts.saveMeeting(h.settings, h.meeting)
      const file = receipt.durablePath
      if (boundary === 'after-saved-written') return simulateBoundary(file)
      effects.credits++
      receipt.completed.add('summary-credit')
      receipt.completed.add('time-saved-credit')
      await p.transcripts.clearDraftTranscript(h.settings, startedAt, file)
      receipt.completed.add('draft-cleanup')
      if (boundary === 'after-draft-cleanup') return simulateBoundary(file)
      receipt.completed.add('audit')
      effects.rebuilds++
      receipt.completed.add('rebuild')
      if (boundary === 'after-rebuild') return simulateBoundary(file)
      receipt.deferredIngest = false
      effects.ingests.push(file)
      receipt.completed.add('ingest')
      return simulateBoundary(file)
    })
    const file = await death
    // Journal writes already issued before the kill reached the disk.
    await store.journalIdle()
    return file
  }

  /** A fresh module graph runs launch recovery through the production Main adapter. */
  const relaunch = async (failIngest = false) => {
    const p = await freshProcess()
    const journal = p.journal.createReceiptJournal(journalFile)
    const outcomes: unknown[] = []
    productionStages.enqueueIngest.mockImplementation(async (path) => {
      if (failIngest) throw new Error('brain busy')
      effects.ingests.push(path)
    })
    p.recovery.bindLaunchResume(async (settings) => {
      outcomes.push(await p.mainReceipts.resumeMainJournaledSaves(journal, settings))
    })
    const recovered = await p.recovery.recoverOrphanDrafts(h.settings)
    return { recovered, outcome: outcomes[0], records: await journal.load() }
  }

  return { h, effects, journalFile, saveUntilBoundary, relaunch }
}

describe('durable save receipts across a module-reset relaunch (WP03-S09, GATE-07)', () => {
  it.each(RESTART_BOUNDARIES)('relaunch skips durably marked stages after %s', async (boundary) => {
    const { h, effects, saveUntilBoundary, relaunch } = await setup()
    const file = await saveUntilBoundary(boundary)
    const bytes = await readRaw(h.folder, basename(file))

    const first = await relaunch()
    expect(first.recovered).toEqual({ recovered: 0 })
    expect(first.outcome).toMatchObject({ finished: 1, kept: 0, dropped: 0 })
    expect(first.records).toEqual({ ok: true, records: [] })
    // The later module graph skips recorded stages; the fixture does not simulate a real process kill.
    expect(effects.rebuilds).toBe(1)
    expect(effects.ingests).toEqual([file])
    expect(effects.credits).toBe(boundary === 'after-saved-written' ? 0 : 1)
    expect(await h.drafts()).toEqual([])
    const meetings = await h.meetings()
    expect(meetings.map((m) => m.name)).toEqual([basename(file)])
    expect(meetings[0].fields.status).not.toBe('recovered')
    expect((await readRaw(h.folder, basename(file))).equals(bytes)).toBe(true)

    // A second relaunch finds nothing left to do.
    const second = await relaunch()
    expect(second.outcome).toEqual({ finished: 0, kept: 0, dropped: 0, abandoned: 0 })
    expect(effects.rebuilds).toBe(1)
    expect(effects.ingests).toEqual([file])
    expect(await h.meetings()).toHaveLength(1)
  })

  it('a stage that fails during resumption is retried on the next launch, and only that stage', async () => {
    const { h, effects, saveUntilBoundary, relaunch } = await setup()
    const file = await saveUntilBoundary('after-saved-written')
    const first = await relaunch(true)
    expect(first.outcome).toMatchObject({ finished: 0, kept: 1 })
    expect(first.records.ok && first.records.records[0].completed).toEqual(['draft-cleanup', 'rebuild'])
    expect(first.records.ok && first.records.records[0].stages).toMatchObject({
      savedWritten: true,
      draftsUnlinked: true,
      brainIngestQueued: false
    })
    expect(await h.drafts()).toEqual([])
    const second = await relaunch()
    expect(second.outcome).toMatchObject({ finished: 1, kept: 0 })
    expect(effects.rebuilds).toBe(1)
    expect(effects.ingests).toEqual([file])
    expect(await h.meetings()).toHaveLength(1)
  })

  it('a receipt whose saved meeting was deleted is dropped without running anything', async () => {
    const { h, effects, saveUntilBoundary, relaunch } = await setup()
    const file = await saveUntilBoundary('after-draft-cleanup')
    await rm(file)
    const first = await relaunch()
    expect(first.outcome).toMatchObject({ finished: 0, dropped: 1 })
    expect(first.records).toEqual({ ok: true, records: [] })
    expect(effects.rebuilds).toBe(0)
    expect(effects.ingests).toEqual([])
    expect(await h.meetings()).toEqual([])
  })

  it('a corrupt journal fails closed: nothing is resumed and the journal is not rewritten', async () => {
    const { h, effects, journalFile, saveUntilBoundary, relaunch } = await setup()
    await saveUntilBoundary('after-draft-cleanup')
    const future = JSON.stringify({ schema: 'metis.save-receipts.v2', records: [] })
    await writeFile(journalFile, future)
    const first = await relaunch()
    expect(first.outcome).toMatchObject({ error: 'corrupt', finished: 0 })
    expect(effects.ingests).toEqual([])
    expect(await readFile(journalFile, 'utf8')).toBe(future)
    expect(await h.meetings()).toHaveLength(1)
  })

  it('the journal never holds transcript text or full paths', async () => {
    const { h, journalFile, saveUntilBoundary } = await setup()
    await saveUntilBoundary('after-rebuild')
    const text = await readFile(journalFile, 'utf8')
    for (const line of h.meeting.lines) expect(text).not.toContain(line.text)
    expect(text).not.toContain(h.meeting.title)
    expect(text).not.toContain(h.folder)
    expect(text).not.toMatch(/[/\\]/)
  })
})
