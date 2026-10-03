import { z } from 'zod'

/**
 * The durable local journal's record contract (M2-0066). Main appends records to
 * userData/journal/<sessionId>/seg-<n>.jnl and acknowledges them only after they are fsynced, so an
 * acknowledged record survives a SIGKILL of the app.
 */

/** One directory name under userData/journal: it can never name the journal root, a parent or a nested path. */
export const JournalSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
export type JournalSessionId = z.infer<typeof JournalSessionIdSchema>

export const JOURNAL_RECORD_VERSION = 1

/** The journal's copy of the transcript line shape (TranscriptLineSchema in shared/ipc.ts): contracts import
 *  only zod, and the contract test pins this copy to the IPC schema so the two cannot drift apart. */
export const JournalLineSchema = z.object({
  speaker: z.enum(['them', 'you', 'unknown']),
  text: z.string(),
  t: z.number(),
  name: z.string().optional(),
  lang: z.string().optional(),
  provisional: z.boolean().optional()
})

/** Live-caption placeholders are never persisted, so a finals batch carries committed lines only. */
const FinalLineSchema = JournalLineSchema.refine((line) => line.provisional !== true, {
  message: 'A provisional caption is not a final transcript line.'
})

const FinalsEntrySchema = z.object({ kind: z.literal('finals'), lines: z.array(FinalLineSchema).min(1) })

/** A revision is a full snapshot of its document: the newest one for a doc supersedes every earlier one. */
const RevisionEntrySchema = z.object({ kind: z.literal('revision'), doc: z.enum(['recap', 'note']), text: z.string() })

/** What a writer hands the journal. */
export const JournalEntrySchema = z.discriminatedUnion('kind', [FinalsEntrySchema, RevisionEntrySchema])
export type JournalEntry = z.infer<typeof JournalEntrySchema>
export type JournalDoc = z.infer<typeof RevisionEntrySchema>['doc']

/** `seq` starts at 1 and strictly increases across every segment of a session. It is never reused, so a
 *  failed append leaves a gap rather than handing its seqs to a later record. */
const RecordMetaSchema = z.object({
  v: z.literal(JOURNAL_RECORD_VERSION),
  seq: z.number().int().positive(),
  at: z.number().int().nonnegative()
})

/** What one journal frame decrypts to. */
export const JournalRecordSchema = z.discriminatedUnion('kind', [
  FinalsEntrySchema.merge(RecordMetaSchema),
  RevisionEntrySchema.merge(RecordMetaSchema)
])
export type JournalRecord = z.infer<typeof JournalRecordSchema>

/** Records fromSeq..toSeq of the session are fsynced to disk. Sent only after the fsync returned. */
export const JournalAckSchema = z
  .object({
    sessionId: JournalSessionIdSchema,
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    savedAt: z.number().int().nonnegative()
  })
  .refine((ack) => ack.fromSeq <= ack.toSeq, { message: 'An ack covers at least one record.' })
export type JournalAck = z.infer<typeof JournalAckSchema>

/** The decoded record, or null when the value is not a record this version understands. */
export function parseJournalRecord(value: unknown): JournalRecord | null {
  const parsed = JournalRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
