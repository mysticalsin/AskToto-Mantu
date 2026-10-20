import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createReceiptJournal,
  RECEIPT_JOURNAL_LIMIT,
  RECEIPT_JOURNAL_SCHEMA,
  type SaveReceiptRecord
} from './transcript-receipt-journal'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'metis-receipts-'))
  file = join(dir, 'transcript-receipts', 'receipts.v1.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const record = (receiptId: string, patch: Partial<SaveReceiptRecord> = {}): SaveReceiptRecord => ({
  receiptId,
  ownerKey: '7:1700000000000',
  authGeneration: 7,
  meetingStartedAt: 1_700_000_000_000,
  payloadSha256: 'a'.repeat(64),
  revision: 3,
  stages: {
    draftSealed: false,
    savedWritten: true,
    brainIngestQueued: false,
    draftsUnlinked: false,
    receiptsDeleted: false
  },
  completed: ['summary-credit'],
  savedBasename: '2023-11-14_221320-planning.md',
  folderIdSha256: 'b'.repeat(64),
  updatedAt: 1,
  ...patch
})

describe('transcript receipt journal', () => {
  it('round-trips records through atomic temp and rename', async () => {
    const journal = createReceiptJournal(file)
    await expect(journal.load()).resolves.toEqual({ ok: true, records: [] })
    await journal.put(record('r1'))
    await journal.put(record('r2'))
    await journal.put(record('r1', { completed: ['summary-credit', 'draft-cleanup'] }))
    const reopened = createReceiptJournal(file)
    const loaded = await reopened.load()
    expect(loaded).toEqual({
      ok: true,
      records: [record('r2'), record('r1', { completed: ['summary-credit', 'draft-cleanup'] })]
    })
    expect(JSON.parse(await readFile(file, 'utf8')).schema).toBe(RECEIPT_JOURNAL_SCHEMA)
    // No temp file survives a completed write.
    expect(await readdir(join(dir, 'transcript-receipts'))).toEqual(['receipts.v1.json'])
    await reopened.remove('r2')
    await reopened.remove('missing')
    expect(await createReceiptJournal(file).load()).toEqual({
      ok: true,
      records: [record('r1', { completed: ['summary-credit', 'draft-cleanup'] })]
    })
  })

  it('serializes concurrent writes so none is lost', async () => {
    const journal = createReceiptJournal(file)
    await Promise.all(Array.from({ length: 20 }, (_, i) => journal.put(record(`r${i}`))))
    const loaded = await createReceiptJournal(file).load()
    expect(loaded.ok && loaded.records.map((r) => r.receiptId).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `r${i}`).sort()
    )
  })

  it('treats unknown major schema as corrupt and keeps drafts', async () => {
    await createReceiptJournal(file).put(record('r1'))
    const future = JSON.stringify({ schema: 'metis.save-receipts.v2', records: [] })
    await writeFile(file, future)
    const journal = createReceiptJournal(file)
    await expect(journal.load()).resolves.toEqual({ ok: false, error: 'corrupt' })
    // Fail closed: a corrupt journal is never overwritten, so nothing it holds is lost or replaced.
    await expect(journal.put(record('r2'))).rejects.toThrow(/corrupt/)
    await expect(journal.remove('r1')).rejects.toThrow(/corrupt/)
    expect(await readFile(file, 'utf8')).toBe(future)
    await writeFile(file, '{not json')
    await expect(journal.load()).resolves.toEqual({ ok: false, error: 'corrupt' })
  })

  it('reports an unreadable journal distinctly from a missing one', async () => {
    await createReceiptJournal(file).put(record('r1'))
    await rm(file)
    await writeFile(file, '') // empty is corrupt, not missing
    await expect(createReceiptJournal(file).load()).resolves.toEqual({ ok: false, error: 'corrupt' })
    await rm(file)
    await expect(createReceiptJournal(file).load()).resolves.toEqual({ ok: true, records: [] })
    await expect(createReceiptJournal(dir).load()).resolves.toEqual({ ok: false, error: 'unreadable' })
  })

  it('contains no transcript text or full paths', async () => {
    const journal = createReceiptJournal(file)
    await expect(journal.put(record('r1', { savedBasename: join(dir, 'meeting.md') }))).rejects.toThrow()
    await expect(journal.put(record('r1', { savedBasename: '..' }))).rejects.toThrow()
    const withText = { ...record('r1'), text: 'Shall we ship on Friday?' } as SaveReceiptRecord
    await expect(journal.put(withText)).rejects.toThrow()
    await journal.put(record('r1'))
    const bytes = await readFile(file, 'utf8')
    expect(bytes).not.toContain(dir)
    expect(bytes).not.toMatch(/[/\\]/)
  })

  it(`refuses a record beyond ${RECEIPT_JOURNAL_LIMIT} instead of evicting one`, async () => {
    const full = Array.from({ length: RECEIPT_JOURNAL_LIMIT }, (_, i) => record(`r${i}`))
    await createReceiptJournal(file).put(full[0])
    await writeFile(file, JSON.stringify({ schema: RECEIPT_JOURNAL_SCHEMA, records: full }))
    const journal = createReceiptJournal(file)
    await expect(journal.put(record('extra'))).rejects.toThrow(/full/)
    await journal.put(record('r5', { completed: ['summary-credit', 'audit'] }))
    const loaded = await journal.load()
    expect(loaded.ok && loaded.records).toHaveLength(RECEIPT_JOURNAL_LIMIT)
  })
})
