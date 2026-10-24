/**
 * The structured meeting record contract (Métis 2.12 G78, CAP-07): decisions, open questions and actions, each with a
 * transcript-range citation and the owner's own edits. Shared by main, the preload bridge and the renderer.
 *
 * The record is derived on every read from the saved recap and transcript, so a corrected transcript or an edited recap
 * can never leave a stale range behind. Only the owner's edits are stored, in a sidecar next to the meeting.
 */
import { z } from 'zod'

export const MEETING_RECORD_IPC = {
  get: 'meeting-record:get',
  edit: 'meeting-record:edit'
} as const

export const MEETING_RECORD_KINDS = ['decision', 'question', 'action'] as const
export type RecordKind = (typeof MEETING_RECORD_KINDS)[number]

/** PROPOSED caps: bounded so a sidecar or a reply never grows without limit. */
export const MEETING_RECORD_TEXT_MAX = 2000
export const MEETING_RECORD_FIELD_MAX = 120
export const MEETING_RECORD_MAX_ITEMS = 200
export const MEETING_RECORD_MAX_EDITS = 200
export const MEETING_RECORD_MAX_ADDED = 100

export const CitationSchema = z
  .object({
    fromLine: z.number().int().min(0),
    toLine: z.number().int().min(0),
    fromT: z.number(),
    toT: z.number(),
    utteranceIds: z.array(z.string())
  })
  .strict()
export type Citation = z.infer<typeof CitationSchema>

export const RecordItemSchema = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.enum(MEETING_RECORD_KINDS),
    text: z.string().max(MEETING_RECORD_TEXT_MAX),
    owner: z.string().max(MEETING_RECORD_FIELD_MAX).nullable(),
    dueText: z.string().max(MEETING_RECORD_FIELD_MAX).nullable(),
    citation: CitationSchema.nullable(),
    source: z.enum(['recap', 'user'])
  })
  .strict()
export type RecordItem = z.infer<typeof RecordItemSchema>

export const MeetingRecordSchema = z
  .object({
    status: z.enum(['ok', 'no-recap', 'unavailable']),
    items: z.array(RecordItemSchema).max(MEETING_RECORD_MAX_ITEMS * 2),
    summaryOnly: z.boolean(),
    orphanedEdits: z.number().int().min(0),
    startedAt: z.number().nullable()
  })
  .strict()
export type MeetingRecord = z.infer<typeof MeetingRecordSchema>

const FILE = z.string().min(1).max(300)
const ITEM_ID = z.string().min(1).max(80)

export const MeetingRecordGetSchema = z.object({ file: FILE }).strict()

const field = z.string().trim().max(MEETING_RECORD_FIELD_MAX).nullable()
const text = z.string().trim().min(1).max(MEETING_RECORD_TEXT_MAX)

export const MeetingRecordEditSchema = z.discriminatedUnion('op', [
  z
    .object({
      file: FILE,
      op: z.literal('set'),
      id: ITEM_ID,
      text: text.optional(),
      owner: field.optional(),
      dueText: field.optional()
    })
    .strict(),
  z.object({ file: FILE, op: z.literal('delete'), id: ITEM_ID }).strict(),
  z
    .object({
      file: FILE,
      op: z.literal('add'),
      kind: z.enum(MEETING_RECORD_KINDS),
      text,
      owner: field.optional(),
      dueText: field.optional()
    })
    .strict()
])
export type MeetingRecordEdit = z.infer<typeof MeetingRecordEditSchema>

export const MeetingRecordAckSchema = z.object({ ok: z.boolean() }).strict()
export type MeetingRecordAck = z.infer<typeof MeetingRecordAckSchema>

export const UNAVAILABLE_RECORD: MeetingRecord = {
  status: 'unavailable',
  items: [],
  summaryOnly: false,
  orphanedEdits: 0,
  startedAt: null
}
