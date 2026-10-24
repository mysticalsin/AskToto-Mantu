import { z } from 'zod'

/**
 * Label schema for the offline live-intervention (JEV) evaluation harness. Fixtures are synthetic by
 * construction (`synthetic: true` is a literal); decision records and reports carry no transcript text.
 */

export const SCENARIO_IDS = [
  'JEV-01',
  'JEV-02',
  'JEV-03',
  'JEV-04',
  'JEV-05',
  'JEV-06',
  'JEV-07',
  'JEV-08',
  'JEV-09',
  'JEV-10',
  'JEV-11',
  'JEV-12'
] as const
export const ScenarioIdSchema = z.enum(SCENARIO_IDS)
export type ScenarioId = z.infer<typeof ScenarioIdSchema>

export const LANGUAGES = ['en', 'fr', 'pt-BR', 'es'] as const
export const LanguageSchema = z.enum(LANGUAGES)
export type Language = z.infer<typeof LanguageSchema>

export const MEETING_TYPES = ['sales', 'support', 'technical', 'interview', 'internal'] as const
export const MeetingTypeSchema = z.enum(MEETING_TYPES)
export type MeetingType = z.infer<typeof MeetingTypeSchema>

/** What a decider must be able to do for a scenario to be runnable against it. */
export const CAPABILITIES = [
  'stale-drop',
  'card-swap',
  'classifier',
  'network-boundary',
  'cost-attribution',
  'action-contract'
] as const
export const CapabilitySchema = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof CapabilitySchema>

/** The ticket that owns each capability; a `not_run` verdict names it. */
export const CAPABILITY_OWNERS: Record<Capability, string> = {
  'stale-drop': 'G05/G70',
  'card-swap': 'G71',
  classifier: 'G74',
  'network-boundary': 'G74',
  'cost-attribution': 'G74',
  'action-contract': 'G71'
}

const Speaker = z.enum(['them', 'you', 'unknown'])
const Ms = z.number().int().nonnegative()
const Id = z.string().min(1).max(64)

export const CLASSIFIER_OUTCOMES = [
  'ok',
  'timeout',
  'nan',
  'malformed',
  'unauthenticated',
  'rate-limited',
  'outage'
] as const

export const NETWORK_MODES = ['cloud', 'local-only', 'offline', 'custom-provider'] as const

export const StepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('final'),
    utteranceId: Id,
    revision: z.number().int().positive(),
    speaker: Speaker,
    text: z.string().min(1),
    lang: LanguageSchema,
    tMs: Ms
  }),
  z.strictObject({ kind: z.literal('partial'), utteranceId: Id, text: z.string().min(1), tMs: Ms }),
  z.strictObject({
    kind: z.literal('correction'),
    utteranceId: Id,
    revision: z.number().int().positive(),
    text: z.string().min(1),
    tMs: Ms
  }),
  z.strictObject({ kind: z.literal('retraction'), utteranceId: Id, tMs: Ms }),
  z.strictObject({ kind: z.literal('pause'), ms: Ms }),
  z.strictObject({
    kind: z.literal('scope'),
    change: z.enum(['stop', 'resume', 'meeting-switch', 'sign-out', 'permission-revoked']),
    tMs: Ms
  }),
  z.strictObject({
    kind: z.literal('candidate'),
    cardKey: Id,
    text: z.string().min(1),
    tMs: Ms,
    // The utterance that produced the card, so a stale-drop can be attributed to it.
    forUtteranceId: Id.optional()
  }),
  z.strictObject({ kind: z.literal('pin'), cardKey: Id, tMs: Ms }),
  z.strictObject({
    kind: z.literal('classifier'),
    outcome: z.enum(CLASSIFIER_OUTCOMES),
    scores: z
      .strictObject({
        question: z.number(),
        objection: z.number(),
        hesitation: z.number(),
        decision: z.number()
      })
      .optional()
  }),
  z.strictObject({ kind: z.literal('network'), mode: z.enum(NETWORK_MODES) }),
  z.strictObject({ kind: z.literal('action'), proposal: z.literal('external-action'), tMs: Ms })
])
export type Step = z.infer<typeof StepSchema>

export const LABEL_REASONS = [
  'direct-question',
  'indirect-request',
  'objection',
  'decision',
  'hesitation-help',
  'rhetorical',
  'quoted',
  'acknowledgement',
  'silence',
  'stale-evidence',
  'duplicate',
  'new-guidance',
  'scope-revoked',
  'degraded',
  'network-boundary',
  'action-contract'
] as const
export const LabelReasonSchema = z.enum(LABEL_REASONS)
export type LabelReason = z.infer<typeof LabelReasonSchema>

export const LabelSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  warranted: z.boolean(),
  reason: LabelReasonSchema,
  useful: z.boolean().optional()
})
export type Label = z.infer<typeof LabelSchema>

export const ExpectSchema = z.strictObject({
  maxCards: z.number().int().nonnegative().optional(),
  mustStaleDrop: z.array(Id).optional(),
  finalCardKey: Id.optional(),
  noActionWithoutContract: z.literal(true).optional(),
  maxClassifierCalls: z.number().int().nonnegative().optional()
})
export type Expect = z.infer<typeof ExpectSchema>

export const ScenarioSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: ScenarioIdSchema,
    title: z.string().min(1),
    synthetic: z.literal(true),
    language: LanguageSchema,
    meetingType: MeetingTypeSchema,
    requires: z.array(CapabilitySchema),
    steps: z.array(StepSchema).min(1),
    labels: z.array(LabelSchema),
    expect: ExpectSchema
  })
  .refine((s) => s.labels.every((l) => l.at < s.steps.length), { message: 'label.at beyond steps' })
export type Scenario = z.infer<typeof ScenarioSchema>

export const DECISION_OUTCOMES = [
  'generate',
  'adopt-speculative',
  'hold',
  'suppressed-quiet',
  'stale-drop',
  'keep-card',
  'replace-card',
  'refuse-action',
  'degraded-existing-rules'
] as const
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number]

export const DECISION_REASONS = [
  'question-detected',
  'not-a-question',
  'cooldown',
  'auto-suggest-off',
  'provider-not-ready',
  'quiet-gate',
  'provisional',
  'unmodelled-step',
  'other'
] as const

/** A decision record never carries utterance or card text: only ids, a hash and counters. */
export const DecisionRecordSchema = z.strictObject({
  scenarioId: ScenarioIdSchema,
  stepIndex: z.number().int().nonnegative(),
  utteranceId: Id.optional(),
  revision: z.number().int().positive().optional(),
  cardKey: Id.optional(),
  cardHash: z.number().int().nonnegative().optional(),
  outcome: z.enum(DECISION_OUTCOMES),
  reason: z.enum(DECISION_REASONS),
  latencyMs: z.number().nonnegative().optional(),
  classifierCalls: z.number().int().nonnegative(),
  generationCalls: z.number().int().nonnegative()
})
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>
