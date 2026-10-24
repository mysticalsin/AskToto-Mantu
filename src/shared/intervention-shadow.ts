import { z } from 'zod'
import { INTERVENTION_STATUSES } from './intervention-contract'

/**
 * One shadow-log record per intervention decision (G70). Closed enums, integers and a reason code only:
 * no transcript, card or question text can be expressed in this shape, and main rejects anything else.
 */
export const INTERVENTION_PATHS = ['question', 'shadow'] as const
export const INTERVENTION_OUTCOMES = ['generate', 'adopt', 'hold', 'stale-drop', 'suppressed-quiet'] as const

export type InterventionPath = (typeof INTERVENTION_PATHS)[number]
export type InterventionOutcome = (typeof INTERVENTION_OUTCOMES)[number]

/** Reason codes are short identifiers (`cooldown`, `question-detected`), never prose. */
const REASON_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

export const interventionShadowRecordSchema = z.strictObject({
  path: z.enum(INTERVENTION_PATHS),
  status: z.enum(INTERVENTION_STATUSES),
  shouldGenerate: z.boolean(),
  reason: z.string().regex(REASON_CODE),
  outcome: z.enum(INTERVENTION_OUTCOMES),
  generation: z.number().int().nonnegative().safe(),
  contextRevision: z.number().int().nonnegative().safe()
})
export type InterventionShadowRecord = z.infer<typeof interventionShadowRecordSchema>

/** The validated record, or null for anything that is not exactly this shape. */
export function parseInterventionShadowRecord(value: unknown): InterventionShadowRecord | null {
  const parsed = interventionShadowRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Which of the G70 counters a record moves. Every record is one eligible decision. */
export function interventionCountersFor(
  record: InterventionShadowRecord
): readonly ('intervention_eligible' | 'intervention_generated' | 'intervention_superseded')[] {
  const counters: ('intervention_eligible' | 'intervention_generated' | 'intervention_superseded')[] = [
    'intervention_eligible'
  ]
  if (record.outcome === 'generate' || record.outcome === 'adopt') counters.push('intervention_generated')
  if (record.outcome === 'stale-drop') counters.push('intervention_superseded')
  return counters
}
