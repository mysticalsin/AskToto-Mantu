/**
 * live-translation.ts — contracts for the live translation channel (Métis 2.12 G73).
 *
 * A translation is a separate, live-only channel bound to `(utteranceId, revision)` of a final transcript line. It never
 * rewrites the original line and is not persisted. Main owns routing, prompts and provider calls; the renderer only
 * receives the four pushes below.
 */
import { z } from 'zod'
import { LEDGER_ID_PATTERN } from './kernel/transcript-ledger'
import { LiveTranslationTargetSchema } from './live-translation-settings'

export {
  DEFAULT_LIVE_TRANSLATION_TARGET,
  LIVE_TRANSLATION_FEATURE,
  LIVE_TRANSLATION_TARGETS,
  LiveTranslationTargetSchema,
  type LiveTranslationTarget
} from './live-translation-settings'

export const TRANSLATION_IPC = {
  segment: 'translation:segment',
  retract: 'translation:retract',
  reset: 'translation:reset',
  status: 'translation:status'
} as const

export const TRANSLATION_MAX_TEXT = 4_000
export const TRANSLATION_MAX_SOURCE = 2_000
export const TRANSLATION_MAX_RETRACT_IDS = 64
export const TRANSLATION_MAX_SUBSCRIPTIONS = 4

const MeetingStartedAtSchema = z.number().int().positive()
const ActiveTargetSchema = z.enum(['en', 'fr', 'pt-BR', 'es'])

export const TranslationSegmentSchema = z
  .object({
    meetingStartedAt: MeetingStartedAtSchema,
    utteranceId: z.string().regex(LEDGER_ID_PATTERN),
    revision: z.number().int().positive(),
    target: ActiveTargetSchema,
    text: z.string().min(1).max(TRANSLATION_MAX_TEXT),
    lowConfidence: z.boolean()
  })
  .strict()
export type TranslationSegment = z.infer<typeof TranslationSegmentSchema>

export const TranslationRetractSchema = z
  .object({
    meetingStartedAt: MeetingStartedAtSchema,
    utteranceIds: z.array(z.string().regex(LEDGER_ID_PATTERN)).min(1).max(TRANSLATION_MAX_RETRACT_IDS)
  })
  .strict()
export type TranslationRetract = z.infer<typeof TranslationRetractSchema>

export const TranslationResetSchema = z
  .object({ meetingStartedAt: MeetingStartedAtSchema, target: LiveTranslationTargetSchema })
  .strict()
export type TranslationReset = z.infer<typeof TranslationResetSchema>

export const TranslationStatusSchema = z
  .object({
    meetingStartedAt: MeetingStartedAtSchema,
    state: z.enum(['on', 'unavailable']),
    message: z.string().max(300).optional()
  })
  .strict()
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>

/** What the translator model must reply with. */
export const TranslatorOutputSchema = z.object({
  text: z.string(),
  confidence: z.enum(['high', 'low'])
})
export type TranslatorOutput = z.infer<typeof TranslatorOutputSchema>
