import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptRevision } from '@shared/contracts/speech/transcript-revision'
import type { Settings } from '@shared/ipc'
import type { ReceiptJournalPort, SaveReceiptRecord } from '../../infra/storage/transcript-receipt-journal'
import type { FileClass } from '../../infra/storage/gateway'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => paths.userData } }))
vi.mock('../../logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))
const ingest = vi.hoisted(() => ({ enqueueIngest: vi.fn(async () => undefined) }))
vi.mock('../../brain/ingest', () => ingest)
const graph = vi.hoisted(() => ({ scheduleRebuild: vi.fn(async () => undefined) }))
vi.mock('../../graphify', () => graph)

let root: string
const STARTED_AT = 1_700_000_000_000
const TEST_SPEECH_LIMITS = {
  maxFieldBytes: 64 * 1024,
  maxPayloadBytes: 1024 * 1024,
  maxRecordBytes: 64 * 1024,
  maxRecords: 100,
  maxWords: 10_000
}

function savedDocument(date = new Date(STARTED_AT).toISOString(), revision?: number): string {
  return [
    '---',
    'type: meeting-transcript',
    `date: ${date}`,
    ...(revision === undefined ? [] : [`transcriptRevision: ${revision}`, 'revisionSchema: 1']),
    '---',
    '# Planning',
    ''
  ].join('\n')
}

function journalRecord(folder: string, overrides: Partial<SaveReceiptRecord> = {}): SaveReceiptRecord {
  return {
    receiptId: 'receipt-direct',
    ownerKey: `3:${STARTED_AT}`,
    authGeneration: 3,
    meetingStartedAt: STARTED_AT,
    payloadSha256: 'f'.repeat(64),
    revision: 0,
    stages: {
      draftSealed: false,
      savedWritten: true,
      brainIngestQueued: false,
      draftsUnlinked: false,
      receiptsDeleted: false
    },
    completed: [],
    savedBasename: '2023-11-14_221320-planning.md',
    folderIdSha256: createHash('sha256').update(resolve(folder)).digest('hex'),
    updatedAt: 1,
    ...overrides
  }
}

function memoryJournal(initial: SaveReceiptRecord): { journal: ReceiptJournalPort; records(): SaveReceiptRecord[] } {
  let records = [initial]
  return {
    journal: {
      load: vi.fn(async () => ({ ok: true as const, records })),
      put: vi.fn(async (next) => {
        records = records.map((record) => (record.receiptId === next.receiptId ? next : record))
      }),
      remove: vi.fn(async (receiptId) => {
        records = records.filter((record) => record.receiptId !== receiptId)
      })
    },
    records: () => records
  }
}

const classified = (name: string, fileClass: FileClass): Map<string, FileClass> => new Map([[name, fileClass]])
const version = { mtimeMs: 1, ctimeMs: 1, size: 128 }

beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'metis-main-receipts-'))
  paths.userData = join(root, 'userData')
  const speech = await import('./meeting-speech')
  speech.configureMeetingSpeechLimits(TEST_SPEECH_LIMITS)
  ingest.enqueueIngest.mockClear()
  graph.scheduleRebuild.mockClear()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const save = (durablePath: string, settings: Settings) => async (receipt: any) => {
  receipt.normalizedStartedAt = STARTED_AT
  receipt.settings = settings
  receipt.durablePath = durablePath
  for (const stage of ['summary-credit', 'time-saved-credit', 'draft-cleanup', 'audit']) receipt.completed.add(stage)
  return durablePath
}

describe('main transcript save receipts', () => {
  it('journals under userData by basename, and launch recovery resumes rebuild and ingest', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const read = vi.spyOn(storage.storageAt(folder), 'read')
    const saved = join(folder, '2023-11-14_221320-planning.md')
    await writeFile(saved, savedDocument())
    const settings = { meetingsFolder: folder, brainConsolidation: { enabled: true } } as Settings
    const { createMainTranscriptSaveReceipts } = await import('./main-save-receipts')
    const store = createMainTranscriptSaveReceipts()
    await store.run(`3:${'d'.repeat(64)}`, { startedAt: 1_700_000_000_000, authGeneration: 3 }, save(saved, settings))
    await store.journalIdle()
    const text = await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')
    expect(JSON.parse(text).records).toEqual([
      expect.objectContaining({ savedBasename: '2023-11-14_221320-planning.md', revision: 0 })
    ])
    expect(text).not.toContain(root)

    const { recoverOrphanDrafts } = await import('./draft-recovery')
    await recoverOrphanDrafts(settings)
    expect(graph.scheduleRebuild).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith('2023-11-14_221320-planning.md', { maxBytes: TEST_SPEECH_LIMITS.maxPayloadBytes })
    // No recorded policy yet, so the current settings' consolidation policy applies.
    expect(ingest.enqueueIngest).toHaveBeenCalledWith(saved, { deferred: true })
    const after = await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')
    expect(JSON.parse(after)).toEqual({ schema: 'metis.save-receipts.v1', records: [] })
  })

  it('keeps a receipt without effects when the same basename now belongs to another meeting date', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const saved = join(folder, '2023-11-14_221320-planning.md')
    await writeFile(saved, savedDocument())
    const originalBytes = await readFile(saved)
    const settings = { meetingsFolder: folder, brainConsolidation: { enabled: true } } as Settings
    const { createMainTranscriptSaveReceipts } = await import('./main-save-receipts')
    const store = createMainTranscriptSaveReceipts()
    await store.run(`3:${'d'.repeat(64)}`, { startedAt: STARTED_AT, authGeneration: 3 }, save(saved, settings))
    await store.journalIdle()

    const replacement = savedDocument(new Date(STARTED_AT + 1_000).toISOString())
    await writeFile(saved, replacement)
    const replacementBytes = await readFile(saved)
    const { recoverOrphanDrafts } = await import('./draft-recovery')
    await recoverOrphanDrafts(settings)

    expect(graph.scheduleRebuild).not.toHaveBeenCalled()
    expect(ingest.enqueueIngest).not.toHaveBeenCalled()
    expect(await readFile(saved)).toEqual(replacementBytes)
    const journal = JSON.parse(await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8'))
    expect(journal.records).toHaveLength(1)
    expect(journal.records[0]).toMatchObject({ savedBasename: '2023-11-14_221320-planning.md', revision: 0 })

    await writeFile(saved, originalBytes)
    await recoverOrphanDrafts(settings)
    expect(graph.scheduleRebuild).toHaveBeenCalledOnce()
    expect(ingest.enqueueIngest).toHaveBeenCalledOnce()
    await recoverOrphanDrafts(settings)
    expect(graph.scheduleRebuild).toHaveBeenCalledOnce()
    expect(ingest.enqueueIngest).toHaveBeenCalledOnce()
    const afterRecovery = JSON.parse(
      await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')
    )
    expect(afterRecovery).toEqual({ schema: 'metis.save-receipts.v1', records: [] })
  })

  it('keeps a receipt without effects when the same meeting file has a different transcript revision', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const saved = join(folder, '2023-11-14_221320-planning.md')
    const revision: TranscriptRevision = {
      schema: 'metis.transcript-revision.v1',
      meetingStartedAt: STARTED_AT,
      revision: 2,
      finalized: false,
      languages: [],
      segments: []
    }
    const binding = await import('./transcript-checkpoint-binding')
    const unbind = binding.bindTranscriptCheckpointStore({
      checkpoint: async () => ({ ok: true, revision: revision.revision }),
      snapshot: (meetingStartedAt) => (meetingStartedAt === STARTED_AT ? revision : null)
    })
    try {
      await writeFile(saved, savedDocument(new Date(STARTED_AT).toISOString(), 2))
      const settings = { meetingsFolder: folder, brainConsolidation: { enabled: true } } as Settings
      const { createMainTranscriptSaveReceipts } = await import('./main-save-receipts')
      const store = createMainTranscriptSaveReceipts()
      await store.run(`3:${'d'.repeat(64)}`, { startedAt: STARTED_AT, authGeneration: 3 }, save(saved, settings))
      await store.journalIdle()

      const replacement = savedDocument(new Date(STARTED_AT).toISOString(), 1)
      await writeFile(saved, replacement)
      const replacementBytes = await readFile(saved)
      const { recoverOrphanDrafts } = await import('./draft-recovery')
      await recoverOrphanDrafts(settings)

      expect(graph.scheduleRebuild).not.toHaveBeenCalled()
      expect(ingest.enqueueIngest).not.toHaveBeenCalled()
      expect(await readFile(saved)).toEqual(replacementBytes)
      const journal = JSON.parse(
        await readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')
      )
      expect(journal.records).toHaveLength(1)
      expect(journal.records[0]).toMatchObject({ savedBasename: '2023-11-14_221320-planning.md', revision: 2 })
    } finally {
      unbind()
    }
  })

  it('does not journal a save outside the meetings folder', async () => {
    const settings = { meetingsFolder: join(root, 'meetings') } as Settings
    const { createMainTranscriptSaveReceipts } = await import('./main-save-receipts')
    const store = createMainTranscriptSaveReceipts()
    const outside = save(join(root, 'elsewhere.md'), settings)
    await store.run(`3:${'e'.repeat(64)}`, { startedAt: 5, authGeneration: 3 }, outside)
    await store.journalIdle()
    await expect(readFile(join(paths.userData, 'transcript-receipts', 'receipts.v1.json'), 'utf8')).rejects.toThrow()
  })

  it.each([
    ['a symlink entry', { status: 'ok', version, isSymlink: true, isRegular: true }],
    ['a nonregular entry', { status: 'ok', version, isSymlink: false, isRegular: false }],
    ['a dataless entry', { status: 'dataless', version }],
    ['an unknown-presence entry', { status: 'unknown', version }],
    ['a timed-out classification', { status: 'timeout' }],
    ['an unavailable classification', { status: 'unavailable', code: 'TEST_UNAVAILABLE' }]
  ] as const)('keeps the receipt without reading %s', async (_label, fileClass) => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    vi.spyOn(gateway, 'classify').mockResolvedValue(classified(name, fileClass as FileClass))
    const read = vi.spyOn(gateway, 'read')
    const state = memoryJournal(journalRecord(folder))
    const settings = { meetingsFolder: folder } as Settings
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(read).not.toHaveBeenCalled()
    expect(state.records()).toHaveLength(1)
    expect(graph.scheduleRebuild).not.toHaveBeenCalled()
    expect(ingest.enqueueIngest).not.toHaveBeenCalled()
  })

  it.each([
    ['an unavailable read', { status: 'unavailable', code: 'TEST_READ_UNAVAILABLE' }],
    ['a timed-out read', { status: 'timeout' }],
    ['a dataless read', { status: 'dataless', version }],
    ['an unknown-presence read', { status: 'unknown', version }]
  ] as const)('keeps %s from being treated as a deletion', async (_label, readResult) => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    vi.spyOn(gateway, 'classify').mockResolvedValue(
      classified(name, { status: 'ok', version, isSymlink: false, isRegular: true })
    )
    vi.spyOn(gateway, 'read').mockResolvedValue(readResult as Awaited<ReturnType<typeof gateway.read>>)
    const state = memoryJournal(journalRecord(folder))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(state.records()).toHaveLength(1)
    expect(state.journal.remove).not.toHaveBeenCalled()
  })

  it('keeps a receipt when the bounded read rejects an oversized file', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    vi.spyOn(gateway, 'classify').mockResolvedValue(
      classified(name, { status: 'ok', version, isSymlink: false, isRegular: true })
    )
    vi.spyOn(gateway, 'read').mockResolvedValue({ status: 'unavailable', code: 'SIZE_LIMIT' })
    const state = memoryJournal(journalRecord(folder))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(state.journal.remove).not.toHaveBeenCalled()
  })

  it('drops a receipt only when the bounded read authoritatively reports missing', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    vi.spyOn(gateway, 'classify').mockResolvedValue(
      classified(name, { status: 'ok', version, isSymlink: false, isRegular: true })
    )
    vi.spyOn(gateway, 'read').mockResolvedValue({ status: 'missing' })
    const state = memoryJournal(journalRecord(folder))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 0, dropped: 1 })
    expect(state.journal.remove).toHaveBeenCalledOnce()
    expect(graph.scheduleRebuild).not.toHaveBeenCalled()
    expect(ingest.enqueueIngest).not.toHaveBeenCalled()
  })

  it('keeps an unreadable encrypted envelope instead of running restart effects', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    vi.spyOn(gateway, 'classify').mockResolvedValue(
      classified(name, { status: 'ok', version, isSymlink: false, isRegular: true })
    )
    vi.spyOn(gateway, 'read').mockResolvedValue({ status: 'ok', version, bytes: Buffer.from('synthetic-envelope') })
    const transcripts = await import('../../transcripts')
    const decode = vi
      .spyOn(transcripts, 'decodeSavedMeetingAsync')
      .mockResolvedValue({ ok: false, reason: 'synthetic unreadable envelope' })
    const state = memoryJournal(journalRecord(folder))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(decode).toHaveBeenCalledWith(expect.any(Buffer), false, join(folder, name))
    expect(state.journal.remove).not.toHaveBeenCalled()
  })

  it('keeps unknown checkpoint schemas and folder identity mismatches pending', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    await writeFile(
      join(folder, name),
      savedDocument().replace(
        'type: meeting-transcript',
        'type: meeting-transcript\ntranscriptRevision: 1\nrevisionSchema: 2'
      )
    )
    const state = memoryJournal(journalRecord(folder, { revision: 1 }))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')
    const unknownSchema = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(unknownSchema).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(state.journal.remove).not.toHaveBeenCalled()

    const classify = vi.spyOn(gateway, 'classify')
    const otherFolder = memoryJournal(journalRecord(folder, { folderIdSha256: 'c'.repeat(64) }))
    const mismatch = await resumeMainJournaledSaves(otherFolder.journal, { meetingsFolder: folder } as Settings)
    expect(mismatch).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(classify).not.toHaveBeenCalled()
    expect(otherFolder.journal.remove).not.toHaveBeenCalled()
  })

  it('treats confirmed missing identity as a dropped receipt', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const state = memoryJournal(journalRecord(folder))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 0, dropped: 1 })
    expect(state.journal.remove).toHaveBeenCalledOnce()
  })

  it('does not read saved identity without an explicit trusted byte budget', async () => {
    const storage = await import('../../infra/storage/meetings-storage')
    storage.useStorageForTests()
    const speech = await import('./meeting-speech')
    speech.configureMeetingSpeechLimits(undefined)
    const folder = join(root, 'meetings')
    await mkdir(folder)
    const name = '2023-11-14_221320-planning.md'
    const gateway = storage.storageAt(folder)
    vi.spyOn(gateway, 'classify').mockResolvedValue(
      classified(name, { status: 'ok', version, isSymlink: false, isRegular: true })
    )
    const read = vi.spyOn(gateway, 'read')
    const state = memoryJournal(journalRecord(folder))
    const { resumeMainJournaledSaves } = await import('./main-save-receipts')

    const outcome = await resumeMainJournaledSaves(state.journal, { meetingsFolder: folder } as Settings)
    expect(outcome).toMatchObject({ finished: 0, kept: 1, dropped: 0 })
    expect(read).not.toHaveBeenCalled()
    expect(state.journal.remove).not.toHaveBeenCalled()
  })
})
