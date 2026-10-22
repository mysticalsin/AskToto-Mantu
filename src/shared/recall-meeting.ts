/**
 * Recall (saved-meeting) result and payload contracts that outgrew ipc.ts: reading one meeting back, the confidential
 * flag's honest result, the durable push markers (Q07) and the debrief limit. Re-exported from ipc.ts, so every
 * existing `@shared/ipc` import keeps working.
 */
import { z } from 'zod'
import type { RecapStatus } from './recap-status'
import type { TranscriptLine } from './transcript-line'

/** The frontmatter fields an outbound push may stamp on a saved meeting (Q07, D4-6). An enum, never a free
 *  string, so a renderer cannot choose which frontmatter line main rewrites. */
export const PUSH_MARKER_FIELDS = ['crm_pushed', 'clickup_pushed', 'next_steps_pushed'] as const
export type PushMarkerField = (typeof PUSH_MARKER_FIELDS)[number]

/** Payload for recall:set-push-marker (Q07) — one fingerprint per push that landed. `key` is a base-36 hash
 *  written into a YAML scalar, so the shape is pinned here and re-checked in main. For `next_steps_pushed`
 *  main appends the key to a bounded list; for the others it replaces the one stored value. */
export const SetPushMarkerPayloadSchema = z.object({
  file: z.string().min(1, 'Missing meeting file.'),
  field: z.enum(PUSH_MARKER_FIELDS),
  key: z.string().regex(/^[a-z0-9]{1,32}$/, 'Invalid push key.')
})
export type SetPushMarkerPayload = z.infer<typeof SetPushMarkerPayloadSchema>

/** Result of recall:set-confidential. `flagSaved` is true only when the frontmatter write landed but the
 *  republish that enforces it failed (Q07, D4-1), so Review keeps the flag and says what is still wrong. */
export interface RecallSetConfidentialResult {
  ok: boolean
  error?: string
  flagSaved?: boolean
}

/** Longest debrief main accepts (characters). The renderer enforces the same number on the textarea. */
export const DEBRIEF_MAX_CHARS = 8000

/** Result of reading a saved meeting back for "Resume session" (decoded transcript + recap). */
export interface RecallReadResult {
  ok: boolean
  error?: string
  title?: string
  mode?: string
  startedAt?: number
  durationMs?: number
  recap?: string
  /** Absent on legacy/unspecified notes; text length is not proof of generation completion. */
  recapStatus?: RecapStatus
  lines?: TranscriptLine[]
  /** Task MI-5 — frontmatter `confidential: true`, so a reopened past meeting's toggle reflects its
   *  actual saved state instead of always starting unflagged. */
  confidential?: boolean
  /** True only when the saved meeting's frontmatter status is exactly `recovered`. */
  recovered?: boolean
  /** MQA-092 — frontmatter `crm_pushed: <payload fingerprint>`. Seeds Review's push state on mount so a
   *  meeting pushed before the last relaunch does not offer to push itself again. Absent = never pushed;
   *  a DIFFERENT fingerprint means the recap was edited since, which correctly re-arms the chip. */
  crmPushedKey?: string
  /** Q07 (D4-6) — frontmatter `clickup_pushed: <payload fingerprint>`; same contract as `crmPushedKey`. */
  clickupPushedKey?: string
  /** Q07 (D4-6) — frontmatter `next_steps_pushed`: fingerprints of the next-step tasks that landed. */
  nextStepsPushedKeys?: string[]
  /** Q07 (D4-3) — frontmatter `recap_edited: true`: a person changed the notes by hand, so a regeneration
   *  would replace their work and Review asks first. Cleared when a generation writes the recap. */
  recapEdited?: boolean
}
