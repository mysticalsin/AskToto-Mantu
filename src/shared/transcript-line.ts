import { z } from 'zod'
import { CloudSpeechSegmentEventSchema } from './cloud-speech'
import { LEDGER_ID_PATTERN } from './kernel/transcript-ledger'
import { lineIdentityIsConsistent } from './transcript-line-identity'

/** Every key a persisted or journalled line may carry. Allow-lists that refuse unknown keys share this one list. */
export const TRANSCRIPT_LINE_KEYS: ReadonlySet<string> = new Set([
  'speaker',
  'text',
  't',
  'name',
  'lang',
  'provisional',
  'speech',
  'utteranceId',
  'revision'
])

export const TranscriptLineSchema = z
  .object({
    // Imported recordings have speech but no diarization. `unknown` prevents the UI and recap prompt from
    // inventing that every imported sentence was spoken by the operator.
    speaker: z.enum(['them', 'you', 'unknown']),
    text: z.string(),
    t: z.number(),
    // Speaker Intelligence (Phase A) — the resolved human display name for this line's speaker, backfilled
    // best-effort from the meeting's own Microsoft Teams transcript after the meeting ends (see
    // main/graph-transcript.ts + shared/transcript-align.ts). Additive only: the SIDE (`speaker` — them/
    // you/unknown) is never inferred or changed by this. Optional so every previously saved meeting, and
    // any line no name was ever resolved for, still parses unchanged.
    name: z.string().optional(),
    // Detected spoken language of this line (shared/lang-id.ts display name, e.g. 'Portuguese') — tagged
    // by commitLine so mixed-language meetings render "[conversation switches to …]" markers in the recap
    // prompt and the saved transcript (the LLM otherwise has no way to know a switch happened). Absent
    // when detection wasn't confident, and on every line saved before this field existed.
    lang: z.string().optional(),
    // Streaming first-caption placeholder (docs/asr/QUALITY.md). Never persisted; transcriptToText drops it.
    provisional: z.boolean().optional(),
    speech: CloudSpeechSegmentEventSchema.refine((event) => event.segment.final).optional(),
    // Canonical transcript identity (2.12 G03, CAP-03): the stable utterance this line is a revision of. Additive
    // and optional, only ever present as a pair, and absent on every line saved before it existed; a cloud-final
    // line must agree with the provider segment it carries (shared/transcript-line-identity.ts).
    utteranceId: z.string().regex(LEDGER_ID_PATTERN).optional(),
    revision: z.number().int().positive().safe().optional()
  })
  .superRefine((line, context) => {
    if (!lineIdentityIsConsistent(line)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['utteranceId'] })
    if (line.speech && (line.text !== line.speech.segment.text || line.provisional === true))
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['speech'] })
  })
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>

/** ASR quality (1B.2b) — strip UI-only provisional placeholders (see TranscriptLineSchema.provisional
 *  above) before a transcript reaches disk or the recap prompt. `transcriptToText` (renderer/lib/
 *  transcript.ts) is the live-text guard; this is the save-path guard, applied once at the IPC boundary
 *  (main/index.ts's saveTranscript/saveDraftTranscript handlers) so every caller is covered even one that
 *  forgot to filter — belt-and-suspenders, since commitLine already removes the placeholder it's
 *  replacing before pushing the real line, so in the common case there is nothing left to strip. Returns
 *  the input array unchanged (same reference) when nothing needed removing, so a save of an ordinary
 *  meeting with no provisional lines never pays a spurious copy. */
export function stripProvisionalLines(lines: TranscriptLine[]): TranscriptLine[] {
  return lines.some((l) => l.provisional) ? lines.filter((l) => !l.provisional) : lines
}

/** Folder snapshot outcome; saved means the existing write completed, not a durable revision ACK. */
export type SaveDraftTranscriptResult = { status: 'saved' | 'disabled' | 'failed' }
