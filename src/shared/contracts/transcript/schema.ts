import { z } from 'zod'
import { RECAP_STATUSES, recapStatusValidationError, type RecapStatus } from '../../recap-status'

export const TranscriptLineSchema = z.object({
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
  provisional: z.boolean().optional()
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

/** Single source of truth for the import pipeline's decode window. Both decoders that turn a recording
 *  into PCM windows — main's ffmpeg sidecar (main/ffmpeg-decoder.ts) and the renderer's Chromium
 *  AudioContext fallback (renderer/lib/import-audio.ts) — chunk at this size, and main/import-jobs.ts
 *  derives each line's display timestamp from it. A renderer lib may only import from shared (never from
 *  main), so this lives here rather than in ffmpeg-decoder.ts. Shorter windows give main/whisper-import.ts's
 *  ported language-follow machine more, smaller chances to notice a mixed-language recording switch than
 *  one slab spanning the whole switch. */
export const IMPORT_CHUNK_SECONDS = 12

function validateRecapStatus(value: { recap: string; recapStatus?: RecapStatus }, context: z.RefinementCtx): void {
  const message = recapStatusValidationError(value.recap, value.recapStatus)
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['recap'], message })
}

export const SaveMeetingSchema = z.object({
  title: z.string().default(''),
  mode: z.string().default('general'),
  startedAt: z.number(),
  /** Actual elapsed recording length, when measured by the capture/import pipeline. */
  durationMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  lines: z.array(TranscriptLineSchema),
  recap: z.string().default(''),
  recapStatus: z.enum(RECAP_STATUSES).optional()
}).superRefine(validateRecapStatus)
export type SaveMeeting = z.infer<typeof SaveMeetingSchema>
