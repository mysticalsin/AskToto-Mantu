/**
 * The read-only dictation status the renderer's activity pill shows (G30).
 *
 * Channels live here, not in ipc.ts, so the feature adds no lines to that file. The schema is strict and its only
 * free-form field, `message`, is fixed copy chosen in main from a machine reason: never speech, never field text.
 */
import { z } from 'zod'

export const DICTATION_STATUS_IPC = {
  /** renderer -> main: the current status. */
  getState: 'dictationStatus:getState',
  /** main -> renderer: the status changed. */
  state: 'dictationStatus:state'
} as const

export const DICTATION_STATUS_STATES = [
  'off',
  'idle',
  'starting',
  'listening',
  'thinking',
  'inserting',
  'done',
  'failed'
] as const

/** The longest fixed sentence main sends; the cap keeps a future change from letting arbitrary text through. */
export const DICTATION_STATUS_MESSAGE_MAX = 120

export const DictationStatusSchema = z
  .object({
    /** Orders pushes: a consumer keeps the highest revision it has seen. */
    revision: z.number().int().nonnegative(),
    state: z.enum(DICTATION_STATUS_STATES),
    message: z.string().min(1).max(DICTATION_STATUS_MESSAGE_MAX).nullable(),
    enabled: z.boolean()
  })
  .strict()
export type DictationStatus = z.infer<typeof DictationStatusSchema>
