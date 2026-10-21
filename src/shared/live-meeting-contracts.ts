import { z } from 'zod'
import { TranscriptLineSchema, type TranscriptLine } from './transcript-line'

/** The existing persisted meeting start is also its live audio owner. Never coerce or create a clock. */
export const LiveMeetingStartedAtSchema = z.number().int().positive().max(8.64e15)
export const ListeningStatePayloadSchema = z.object({
  on: z.boolean(),
  startedAt: LiveMeetingStartedAtSchema.optional()
})
export type ListeningStatePayload = z.infer<typeof ListeningStatePayloadSchema>
export const MeetingMicAdmissionRequestSchema = z.object({ startedAt: LiveMeetingStartedAtSchema }).strict()
export const DraftMeetingLifecyclePayloadSchema = z.object({ startedAt: LiveMeetingStartedAtSchema }).strict()
export const DiscardSavedTranscriptPayloadSchema = z
  .object({
    startedAt: LiveMeetingStartedAtSchema,
    title: z.string().max(200).optional(),
    path: z.string().max(4096).optional()
  })
  .strict()

// ─── Live meeting journal (WP03 / C09b): one durable record per committed cloud final ───────────────────────────
const JOURNAL_LINE_KEYS = new Set(['speaker', 'text', 't', 'name', 'lang', 'provisional', 'speech'])
const JOURNAL_LABEL_MAX = 256

/**
 * A committed cloud-final transcript line: it carries the full provider segment (`speech`), is final and never a
 * provisional caption. Unknown keys are refused (not stripped) so the renderer cannot smuggle extra data into a
 * durable record; `name` and `lang` are bounded because the line schema leaves them open.
 */
export const JournalCloudFinalLineSchema = z
  .custom<TranscriptLine>((raw) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype)
        return false
      if (Object.keys(raw).some((key) => !JOURNAL_LINE_KEYS.has(key))) return false
      const parsed = TranscriptLineSchema.safeParse(raw)
      if (!parsed.success) return false
      const line = parsed.data
      return (
        line.provisional !== true &&
        line.speech?.type === 'segment' &&
        line.speech.segment.final === true &&
        (line.name?.length ?? 0) <= JOURNAL_LABEL_MAX &&
        (line.lang?.length ?? 0) <= JOURNAL_LABEL_MAX
      )
    } catch {
      return false
    }
  })
  .transform((raw) => TranscriptLineSchema.parse(raw))

export const AppendMeetingJournalSchema = z
  .object({ startedAt: LiveMeetingStartedAtSchema, line: JournalCloudFinalLineSchema })
  .strict()
export type AppendMeetingJournalPayload = z.infer<typeof AppendMeetingJournalSchema>

/** Content-free outcome: the renderer learns only whether the record is durable, never why it was refused. */
export type AppendMeetingJournalResult = { status: 'durable' | 'refused' }
