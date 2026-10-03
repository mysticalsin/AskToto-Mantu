import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  JOURNAL_RECORD_VERSION,
  JournalEntrySchema,
  JournalSessionIdSchema,
  parseJournalRecord,
  type JournalAck,
  type JournalEntry,
  type JournalRecord
} from '@shared/contracts/journal'
import { decodeSavedResult, encryptEnvelopeV2, isEncryptedBytes, type SavedDecode } from '../../transcripts'
import { journalEnabled } from './flag'
import { encodeFrame, listSegments, scanFrames, segmentName, SegmentWriter, syncDirectory } from './segment'

/**
 * The append-only local journal: userData/journal/<sessionId>/seg-<n>.jnl. Every record is sealed with
 * the transcript envelope (AES-256-GCM under a per-record content key wrapped for this device), framed,
 * appended and fsynced before its ack resolves.
 *
 * INV-ACK: append() resolves only after the fsync of the records it wrote returned. Appends run one at a
 * time in call order, so acks resolve in seq order.
 */

/** A segment is closed and the next one started once it reaches this size. */
export const SEGMENT_MAX_BYTES = 4 * 1024 * 1024

export type JournalCodec = {
  seal: (plaintext: string) => Buffer
  open: (payload: Buffer) => SavedDecode
}

/** The transcript envelope. A frame that is not envelope-encrypted is refused, never read as plaintext. */
export const envelopeCodec: JournalCodec = {
  seal: encryptEnvelopeV2,
  open: (payload) =>
    isEncryptedBytes(payload) ? decodeSavedResult(payload) : { ok: false, reason: 'journal frame is not envelope-encrypted' }
}

export function defaultJournalRoot(): string {
  return join(app.getPath('userData'), 'journal')
}

export type JournalLocation = { sessionId: string; root?: string; codec?: JournalCodec }

function sessionDir(location: JournalLocation): { root: string; dir: string } {
  const sessionId = JournalSessionIdSchema.parse(location.sessionId)
  const root = location.root ?? defaultJournalRoot()
  return { root, dir: join(root, sessionId) }
}

/** Everything the session's segments hold, in seq order. `tornTailSegments` lists segments that end in an
 *  incomplete frame (a crash or failed write mid-append); `unreadable` counts whole frames that did not open
 *  or decode as a record. */
export type JournalReplay = { records: JournalRecord[]; tornTailSegments: number[]; unreadable: number }

export async function readJournal(location: JournalLocation): Promise<JournalReplay> {
  const { dir } = sessionDir(location)
  const codec = location.codec ?? envelopeCodec
  const replay: JournalReplay = { records: [], tornTailSegments: [], unreadable: 0 }
  for (const n of await listSegments(dir)) {
    const scan = scanFrames(await readFile(join(dir, segmentName(n))))
    if (scan.tornTail) replay.tornTailSegments.push(n)
    for (const payload of scan.payloads) {
      const opened = codec.open(payload)
      let record: JournalRecord | null = null
      if (opened.ok) {
        try {
          record = parseJournalRecord(JSON.parse(opened.text))
        } catch {
          record = null
        }
      }
      if (record) replay.records.push(record)
      else replay.unreadable++
    }
  }
  replay.records.sort((a, b) => a.seq - b.seq)
  return replay
}

export interface JournalStore {
  readonly sessionId: string
  /** Seals and appends the entries as consecutive records, fsyncs, then resolves their ack (INV-ACK). */
  append(entries: JournalEntry[]): Promise<JournalAck>
  close(): Promise<void>
}

export type OpenJournalOptions = JournalLocation & { now?: () => number; segmentMaxBytes?: number }

/** Opens the session's journal for appending. Records continue the seq of what is already on disk, and the
 *  first append starts a new segment (INV-APPEND in segment.ts). */
export async function openJournal(options: OpenJournalOptions): Promise<JournalStore> {
  const { root, dir } = sessionDir(options)
  const sessionId = options.sessionId
  const codec = options.codec ?? envelopeCodec
  const now = options.now ?? Date.now
  const segmentMaxBytes = options.segmentMaxBytes ?? SEGMENT_MAX_BYTES

  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await syncDirectory(root)

  const existing = await readJournal(options)
  let nextSeq = existing.records.length > 0 ? existing.records[existing.records.length - 1].seq + 1 : 1
  let nextSegment = ((await listSegments(dir)).at(-1) ?? 0) + 1
  let writer: SegmentWriter | null = null
  let closed = false
  let queue: Promise<unknown> = Promise.resolve()

  async function retireWriter(): Promise<void> {
    const current = writer
    writer = null
    if (current) await current.close()
  }

  async function write(entries: JournalEntry[]): Promise<JournalAck> {
    const valid = entries.map((entry) => JournalEntrySchema.parse(entry))
    if (valid.length === 0) throw new Error('journal: nothing to append')
    // Seqs are taken before the write so a failed append never hands its seqs to a later record.
    const fromSeq = nextSeq
    nextSeq += valid.length
    const at = now()
    const frames = Buffer.concat(
      valid.map((entry, i) => {
        const record: JournalRecord = { ...entry, v: JOURNAL_RECORD_VERSION, seq: fromSeq + i, at }
        return encodeFrame(codec.seal(JSON.stringify(record)))
      })
    )
    if (writer && writer.size > 0 && writer.size + frames.length > segmentMaxBytes) await retireWriter()
    try {
      if (!writer) writer = await SegmentWriter.create(dir, nextSegment++)
      await writer.appendDurably(frames)
    } catch (e) {
      // The failed segment may now end in a torn frame; nothing is ever appended after it (INV-APPEND).
      await retireWriter().catch(() => {})
      throw e
    }
    return { sessionId, fromSeq, toSeq: fromSeq + valid.length - 1, savedAt: now() }
  }

  return {
    sessionId,
    append(entries) {
      if (closed) return Promise.reject(new Error('journal: the store is closed'))
      const result = queue.then(() => write(entries))
      queue = result.catch(() => {})
      return result
    },
    /** Appends made before close() still complete; any made after it reject. */
    async close() {
      closed = true
      await queue
      await retireWriter()
    }
  }
}

/** The session's journal when the `journal` flag is on; otherwise null, and nothing is created on disk. */
export async function openJournalIfEnabled(options: OpenJournalOptions): Promise<JournalStore | null> {
  return journalEnabled() ? openJournal(options) : null
}
