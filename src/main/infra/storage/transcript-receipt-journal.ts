import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

export const RECEIPT_JOURNAL_SCHEMA = 'metis.save-receipts.v1'
export const RECEIPT_JOURNAL_LIMIT = 256

/** Post-save side effects of one final transcript save, in the order the save handler runs them. */
export const SAVE_RECEIPT_STAGES = [
  'summary-credit',
  'time-saved-credit',
  'draft-cleanup',
  'audit',
  'rebuild',
  'ingest',
  'speaker-save',
  'complete'
] as const
export type SaveReceiptStage = (typeof SAVE_RECEIPT_STAGES)[number]

/**
 * One durable save receipt. P1: no transcript text, no settings and no full paths. The saved file is named only by
 * its basename inside the meetings folder whose resolved path hashes to `folderIdSha256`.
 */
export interface SaveReceiptRecord {
  receiptId: string
  ownerKey: string
  authGeneration: number
  meetingStartedAt: number
  payloadSha256: string
  revision: number
  stages: {
    draftSealed: boolean
    savedWritten: boolean
    brainIngestQueued: boolean
    draftsUnlinked: boolean
    receiptsDeleted: boolean
  }
  /** The handler's own stage set, so a relaunch resumes exactly the stages that did not complete. */
  completed: SaveReceiptStage[]
  deferredIngest?: boolean
  savedBasename?: string
  folderIdSha256: string
  updatedAt: number
}

export type ReceiptJournalLoad =
  | { ok: true; records: SaveReceiptRecord[] }
  | { ok: false; error: 'corrupt' | 'unreadable' }

export interface ReceiptJournalPort {
  load(): Promise<ReceiptJournalLoad>
  /** Atomic temp + fsync + rename. Rejects when the journal is corrupt or full, so nothing valid is overwritten. */
  put(rec: SaveReceiptRecord): Promise<void>
  remove(receiptId: string): Promise<void>
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const RecordSchema = z
  .object({
    receiptId: z.string().min(1).max(64),
    ownerKey: z.string().min(1).max(64),
    authGeneration: z.number().int().nonnegative(),
    meetingStartedAt: z.number().finite(),
    payloadSha256: sha256,
    revision: z.number().int().nonnegative(),
    stages: z
      .object({
        draftSealed: z.boolean(),
        savedWritten: z.boolean(),
        brainIngestQueued: z.boolean(),
        draftsUnlinked: z.boolean(),
        receiptsDeleted: z.boolean()
      })
      .strict(),
    completed: z.array(z.enum(SAVE_RECEIPT_STAGES)).max(SAVE_RECEIPT_STAGES.length),
    deferredIngest: z.boolean().optional(),
    // A basename only: no separator, no traversal, no drive.
    savedBasename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\:]+$/)
      .refine((name) => name !== '.' && name !== '..')
      .optional(),
    folderIdSha256: sha256,
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
const FileSchema = z
  .object({ schema: z.literal(RECEIPT_JOURNAL_SCHEMA), records: z.array(RecordSchema).max(RECEIPT_JOURNAL_LIMIT) })
  .strict()

async function readJournal(file: string): Promise<ReceiptJournalLoad> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, records: [] }
    return { ok: false, error: 'unreadable' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'corrupt' }
  }
  // An unknown schema (including a future major version) is corrupt: fail closed, never rewrite it.
  const parsed = FileSchema.safeParse(json)
  return parsed.success ? { ok: true, records: parsed.data.records } : { ok: false, error: 'corrupt' }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  // Persist the rename itself where the platform lets a directory be fsynced (not Windows).
  try {
    const dir = await open(dirname(file), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch {
    // best effort
  }
}

/** File-backed journal at `file`. Operations run one at a time, each a read-modify-write of the whole file. */
export function createReceiptJournal(file: string): ReceiptJournalPort {
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = tail.then(op, op)
    tail = next.catch(() => undefined)
    return next
  }
  const update = (change: (records: SaveReceiptRecord[]) => SaveReceiptRecord[] | null): Promise<void> =>
    serial(async () => {
      const current = await readJournal(file)
      if (!current.ok) throw new Error(`Transcript receipt journal is ${current.error}`)
      const records = change(current.records)
      if (records === null) return
      if (records.length > RECEIPT_JOURNAL_LIMIT) throw new Error('Transcript receipt journal is full')
      await writeAtomic(file, JSON.stringify({ schema: RECEIPT_JOURNAL_SCHEMA, records }))
    })
  return {
    load: () => serial(() => readJournal(file)),
    put: async (rec) => {
      const checked = RecordSchema.parse(rec)
      return update((records) => [...records.filter((r) => r.receiptId !== checked.receiptId), checked])
    },
    remove: (receiptId) =>
      update((records) =>
        records.some((r) => r.receiptId === receiptId) ? records.filter((r) => r.receiptId !== receiptId) : null
      )
  }
}
