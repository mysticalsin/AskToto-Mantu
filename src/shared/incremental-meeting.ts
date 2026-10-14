import { z } from 'zod'
import { TranscriptLineSchema, type TranscriptLine } from './transcript-line'

export const INCREMENTAL_MEETING_PROTOCOL = 1 as const

const UuidSchema = z.string().uuid()
const RevisionSchema = z.number().int().nonnegative().safe()
const TimestampSchema = z.number().finite().int().min(-8.64e15).max(8.64e15)
const TrackSchema = z.enum(['microphone', 'system'])
const lineKeys = new Set(['speaker', 'text', 't', 'name', 'lang', 'provisional', 'speech'])
const ExactTranscriptLineSchema = z
  .custom<TranscriptLine>((value) => {
    try {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      )
        return false
      if (Object.keys(value).some((key) => !lineKeys.has(key))) return false
      return TranscriptLineSchema.safeParse(value).success
    } catch {
      return false
    }
  })
  .transform((value) => TranscriptLineSchema.parse(value))

export const IncrementalMeetingIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), recordId: UuidSchema }).strict(),
  z
    .object({
      kind: z.literal('cloud'),
      captureId: UuidSchema,
      captureGeneration: z.number().int().positive().safe(),
      track: TrackSchema,
      epoch: z.number().int().positive().safe(),
      segmentIndex: z.number().int().positive().safe()
    })
    .strict()
])
export type IncrementalMeetingIdentity = z.infer<typeof IncrementalMeetingIdentitySchema>

export const IncrementalMeetingRecordSchema = z
  .object({
    identity: IncrementalMeetingIdentitySchema,
    source: z.enum(['local-final', 'cloud-final']),
    line: ExactTranscriptLineSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (!Number.isSafeInteger(record.line.t) || Math.abs(record.line.t) > 8.64e15 || record.line.provisional === true) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['line'] })
    }
    if (record.source === 'local-final') {
      if (record.identity.kind !== 'local' || record.line.speech !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['identity'] })
      }
    } else {
      const speech = record.line.speech
      if (
        record.identity.kind !== 'cloud' ||
        !speech ||
        speech.type !== 'segment' ||
        speech.segment.final !== true ||
        speech.captureId !== record.identity.captureId ||
        speech.captureGeneration !== record.identity.captureGeneration ||
        speech.segment.stream.track !== record.identity.track ||
        speech.segment.stream.epoch !== record.identity.epoch ||
        speech.segment.index !== record.identity.segmentIndex ||
        record.line.text !== speech.segment.text
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['identity'] })
      }
    }
  })

const MeetingIdSchema = UuidSchema
const AppendRecordSchema = z
  .object({
    protocol: z.literal(INCREMENTAL_MEETING_PROTOCOL),
    operation: z.literal('append-record'),
    meetingId: MeetingIdSchema,
    expectedRevision: RevisionSchema,
    record: IncrementalMeetingRecordSchema
  })
  .strict()
const PatchRecordSchema = z
  .object({
    protocol: z.literal(INCREMENTAL_MEETING_PROTOCOL),
    operation: z.literal('patch-record'),
    meetingId: MeetingIdSchema,
    expectedRevision: RevisionSchema,
    patch: z
      .object({
        kind: z.literal('speaker-name'),
        target: IncrementalMeetingIdentitySchema,
        name: z.string().nullable()
      })
      .strict()
  })
  .strict()
const RemoveRecordSchema = z
  .object({
    protocol: z.literal(INCREMENTAL_MEETING_PROTOCOL),
    operation: z.literal('remove-record'),
    meetingId: MeetingIdSchema,
    expectedRevision: RevisionSchema,
    target: IncrementalMeetingIdentitySchema
  })
  .strict()
const CheckpointSchema = z
  .object({
    protocol: z.literal(INCREMENTAL_MEETING_PROTOCOL),
    operation: z.literal('checkpoint'),
    meetingId: MeetingIdSchema,
    frontier: RevisionSchema
  })
  .strict()
const FinalizeSchema = z
  .object({
    protocol: z.literal(INCREMENTAL_MEETING_PROTOCOL),
    operation: z.literal('finalize'),
    meetingId: MeetingIdSchema,
    frontier: RevisionSchema,
    metadata: z.object({ title: z.string(), startedAt: TimestampSchema, endedAt: TimestampSchema }).strict()
  })
  .strict()
const DiscardSchema = z
  .object({
    protocol: z.literal(INCREMENTAL_MEETING_PROTOCOL),
    operation: z.literal('discard'),
    meetingId: MeetingIdSchema,
    expectedRevision: RevisionSchema
  })
  .strict()

export const IncrementalMeetingCommandSchema = z.discriminatedUnion('operation', [
  AppendRecordSchema,
  PatchRecordSchema,
  RemoveRecordSchema,
  CheckpointSchema,
  FinalizeSchema,
  DiscardSchema
])
export type IncrementalMeetingCommand = z.infer<typeof IncrementalMeetingCommandSchema>

export type IncrementalMeetingCommandResult =
  | { status: 'accepted'; revision: number }
  | { status: 'durable'; frontier: number }
  | { status: 'finalized'; frontier: number }
  | { status: 'discarded'; revision: number }
  | {
      status: 'refused'
      reason:
        | 'INVALID_COMMAND'
        | 'STALE_REVISION'
        | 'DUPLICATE_IDENTITY'
        | 'CONFLICTING_IDENTITY'
        | 'LIMIT'
        | 'STALE_OWNER'
        | 'UNAVAILABLE'
    }

export type IncrementalMeetingRecord = {
  identity: IncrementalMeetingIdentity
  source: 'local-final' | 'cloud-final'
  line: TranscriptLine
}

export type CanonicalIncrementalRecord = {
  identityKey: string
  sha256: string
  canonicalBytes: Uint8Array
  canonicalByteLength: number
  wordCount: number
}

export type IncrementalMeetingCommandParse =
  | { ok: true; command: IncrementalMeetingCommand }
  | { ok: false; reason: 'INVALID_COMMAND' }

/** Parse one bounded mutation envelope; ownership and byte admission remain main-owned. */
export function parseIncrementalMeetingCommand(value: unknown): IncrementalMeetingCommandParse {
  const parsed = IncrementalMeetingCommandSchema.safeParse(value)
  return parsed.success ? { ok: true, command: parsed.data } : { ok: false, reason: 'INVALID_COMMAND' }
}
