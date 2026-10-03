import { z } from 'zod'

export const LocalModelSummarySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    minTotalRamGB: z.number(),
    ready: z.boolean(),
    source: z.enum(['bundled', 'download']).optional(),
    unavailableReason: z
      .enum(['invalid-bundle', 'insufficient-ram', 'insufficient-disk', 'downloading', 'download-failed', 'not-downloaded'])
      .nullable(),
    /** 0..1 while `unavailableReason === 'downloading'`, 0 otherwise. */
    downloadProgress: z.number().min(0).max(1),
    /** Concrete refuse/fail reason while `unavailableReason === 'download-failed'`. */
    downloadError: z.string().max(2000).nullable().optional()
  })
  .strict()
export type LocalModelSummary = z.infer<typeof LocalModelSummarySchema>

/** Payload for local:prewarm — a debounced live-meeting transcript tail (PLAN.md §4.4's pre-warm path),
 *  sent fire-and-forget from the renderer's instant-suggestions effect so the sidecar's per-slot KV cache
 *  stays hot between real suggest requests. The renderer already clips this to the same ~6000-char tail
 *  the suggest mode itself sends (llm/shared.ts's `.slice(-6000)`) before it ever reaches IPC; the 24000
 *  cap here is defense-in-depth against a compromised/malfunctioning renderer, not the real bound.
 *  M2-0430: `purpose: 'summary'` is the Stop-time warm of the summary slot. It carries the whole meeting
 *  so far (the recap's own prefix), bounded by the 80,000-char local summary transcript cap. */
export const LocalPrewarmPayloadSchema = z.union([
  z.object({ text: z.string().min(1).max(24_000), purpose: z.literal('suggest').optional() }),
  z.object({ text: z.string().min(1).max(80_000), purpose: z.literal('summary') })
])
export type LocalPrewarmPayload = z.infer<typeof LocalPrewarmPayloadSchema>

/** Content-free post-meeting latency spans (M2-0430), measured in the renderer from the Stop click. */
export const WRITEUP_SPANS = ['stop_to_transcript_saved', 'stop_to_first_recap_token', 'stop_to_recap_done'] as const
export type WriteupSpan = typeof WRITEUP_SPANS[number]
export const WriteupSpanPayloadSchema = z
  .object({ span: z.enum(WRITEUP_SPANS), ms: z.number().int().min(0).max(24 * 60 * 60_000) })
  .strict()
export type WriteupSpanPayload = z.infer<typeof WriteupSpanPayloadSchema>
