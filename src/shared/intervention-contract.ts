/**
 * Live-intervention (JEV) contract: the single source of truth for the classifier input budget, the
 * score schema, the decision result and the named thresholds. Main, renderer and the Operator route
 * (G74) all import these limits so the byte budget is chosen once.
 *
 * The classifier is an optional relevance gate. It never writes the answer and never executes a
 * desktop action: the only things that cross this contract are bounded transcript text, one card and
 * four scores in [0, 1].
 *
 * Evidence labels:
 * - PROPOSED: the 8,192 UTF-8 byte budget and the per-field caps. The reference kernel chose them; the
 *   packaged Canary client used a different unit (JS string length, 20,000). They are not calibrated.
 * - ASSUMED: the guide thresholds (0.85 / 0.90 / 0.75), 3 s timeout, 1,100 ms interval and 275 ms
 *   debounce come from the Canary defaults. They are configuration, not measured probabilities.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------------------------------
// Budget (PROPOSED). One byte budget, measured in UTF-8 bytes of the canonical serialized input.
// ---------------------------------------------------------------------------------------------------

export const INTERVENTION_SCHEMA_VERSION = 1 as const

/** Default hard cap on the serialized classifier input. PROPOSED: reference kernel value. */
export const INTERVENTION_INPUT_MAX_UTF8_BYTES = 8_192
/** Smallest and largest budget a caller may configure. */
export const INTERVENTION_INPUT_MIN_UTF8_BYTES = 512
export const INTERVENTION_INPUT_CEILING_UTF8_BYTES = 32_768

export const INTERVENTION_MAX_FINAL_MESSAGES = 8
export const INTERVENTION_OBJECTIVE_MAX_UTF8_BYTES = 512
export const INTERVENTION_MESSAGE_MAX_UTF8_BYTES = 640
export const INTERVENTION_LIVE_FRAGMENT_MAX_UTF8_BYTES = 512
export const INTERVENTION_CARD_TEXT_MAX_UTF8_BYTES = 640
/** Display-side card text cap used by the swap guard (characters, not bytes). */
export const INTERVENTION_CARD_SWAP_MAX_CHARS = 8_000

// ---------------------------------------------------------------------------------------------------
// Thresholds and timings (ASSUMED: Canary defaults, uncalibrated).
// ---------------------------------------------------------------------------------------------------

/** Respond to the remote speaker (question, objection, decision scores). */
export const INTERVENTION_RESPONSE_THRESHOLD = 0.85
/** User needs help (hesitation score). */
export const INTERVENTION_HELP_THRESHOLD = 0.9
/** Hesitation threshold when the live fragment is a short fragment. Fixed, with no step adaptation. */
export const INTERVENTION_SHORT_FRAGMENT_HELP_THRESHOLD = 0.7
/** A duplicate-review score above this may restore the prior card (consumed by the G71 review). */
export const INTERVENTION_DUPLICATE_THRESHOLD = 0.75
/** A live fragment of at most this many Unicode code points counts as short. */
export const INTERVENTION_SHORT_FRAGMENT_CODE_POINTS = 24

export const INTERVENTION_CLASSIFIER_TIMEOUT_MS = 3_000
/** Minimum spacing between classifier call starts. */
export const INTERVENTION_MIN_REQUEST_INTERVAL_MS = 1_100
export const INTERVENTION_MAX_REQUEST_INTERVAL_MS = 60_000
/** A partial must be unchanged this long before it may be classified. A debounce, not a latency result. */
export const INTERVENTION_PARTIAL_DEBOUNCE_MS = 275
/** Duplicate review queue deadline (consumed by G71). */
export const INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS = 4_000

export const INTERVENTION_SCORE_NAMES = ['question', 'objection', 'hesitation', 'decision'] as const
export type InterventionScoreName = (typeof INTERVENTION_SCORE_NAMES)[number]

export interface InterventionThresholds {
  readonly question: number
  readonly objection: number
  readonly hesitation: number
  readonly decision: number
  readonly shortHesitation: number
}

export const DEFAULT_INTERVENTION_THRESHOLDS: InterventionThresholds = Object.freeze({
  question: INTERVENTION_RESPONSE_THRESHOLD,
  objection: INTERVENTION_RESPONSE_THRESHOLD,
  hesitation: INTERVENTION_HELP_THRESHOLD,
  decision: INTERVENTION_RESPONSE_THRESHOLD,
  shortHesitation: INTERVENTION_SHORT_FRAGMENT_HELP_THRESHOLD
})

// ---------------------------------------------------------------------------------------------------
// Errors and data helpers
// ---------------------------------------------------------------------------------------------------

export type InterventionErrorCode =
  | 'INTERVENTION_INPUT'
  | 'INTERVENTION_TEXT'
  | 'INTERVENTION_CLASSIFIER'
  | 'INTERVENTION_TIMEOUT'
  | 'INTERVENTION_INTERVAL'
  | 'INTERVENTION_DISPOSED'
  | 'INTERVENTION_MESSAGE_LIMIT'
  | 'INTERVENTION_BYTE_LIMIT'
  | 'INTERVENTION_TRANSCRIPT'
  | 'INTERVENTION_SEGMENT'
  | 'INTERVENTION_CARD'
  | 'INTERVENTION_BUDGET_TOO_SMALL'
  | 'INTERVENTION_TRIGGER'
  | 'EXISTING_RULE_SCHEMA'
  | 'PARTIAL_STABILITY'
  | 'SHORT_FRAGMENT_LIMIT'
  | 'THRESHOLD_SCHEMA'
  | 'THRESHOLD_RANGE'
  | 'SCORE_SCHEMA'
  | 'SCORE_RANGE'
  | 'SCOPE_SHAPE'
  | 'SCOPE_MISMATCH'
  | 'CARD_SCHEMA'
  | 'CARD_GUARD_CLOSED'
  | 'CARD_TICKET_NOT_ISSUED'

export class InterventionError extends Error {
  readonly code: InterventionErrorCode

  constructor(code: InterventionErrorCode, message: string = code) {
    super(message)
    this.name = 'InterventionError'
    this.code = code
  }
}

export function requireCondition(condition: unknown, code: InterventionErrorCode): asserts condition {
  if (!condition) throw new InterventionError(code)
}

const ENCODER = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return ENCODER.encode(value).length
}

/** Clip to at most `budget` UTF-8 bytes on a code point boundary, so no replacement character appears. */
export function clipUtf8(value: string, budget: number): string {
  requireCondition(typeof value === 'string', 'INTERVENTION_TEXT')
  if (utf8ByteLength(value) <= budget) return value
  let clipped = ''
  let used = 0
  for (const point of value) {
    const bytes = utf8ByteLength(point)
    if (used + bytes > budget) break
    clipped += point
    used += bytes
  }
  return clipped
}

/** JSON with object keys sorted at every level, so byte counts match across processes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

// ---------------------------------------------------------------------------------------------------
// Scope and identifiers
// ---------------------------------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
export const interventionIdSchema = z.string().regex(ID_PATTERN)
export const isInterventionId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value)

export const interventionScopeSchema = z
  .object({ tenantId: interventionIdSchema, userId: interventionIdSchema, sessionId: interventionIdSchema })
  .strict()
export type InterventionScope = z.infer<typeof interventionScopeSchema>

export function validateInterventionScope(scope: unknown): InterventionScope {
  const parsed = interventionScopeSchema.safeParse(scope)
  if (!parsed.success) throw new InterventionError('SCOPE_SHAPE')
  return parsed.data
}

export function assertSameScope(expected: unknown, actual: unknown): void {
  const a = validateInterventionScope(expected)
  const b = validateInterventionScope(actual)
  if (a.tenantId !== b.tenantId || a.userId !== b.userId || a.sessionId !== b.sessionId) {
    throw new InterventionError('SCOPE_MISMATCH')
  }
}

// ---------------------------------------------------------------------------------------------------
// Classifier input
// ---------------------------------------------------------------------------------------------------

const countBytes = (max: number) => (value: string) => utf8ByteLength(value) <= max

export const interventionFinalMessageSchema = z
  .object({
    streamId: interventionIdSchema,
    streamEpoch: z.number().int().positive().safe(),
    utteranceId: interventionIdSchema,
    revision: z.number().int().positive().safe(),
    speakerId: interventionIdSchema,
    text: z.string().refine(countBytes(INTERVENTION_MESSAGE_MAX_UTF8_BYTES), { message: 'message text over cap' })
  })
  .strict()
export type InterventionFinalMessage = z.infer<typeof interventionFinalMessageSchema>

export const interventionCardRefSchema = z
  .object({
    id: interventionIdSchema,
    text: z.string().refine(countBytes(INTERVENTION_CARD_TEXT_MAX_UTF8_BYTES), { message: 'card text over cap' })
  })
  .strict()

export const interventionInputSchema = z
  .object({
    schemaVersion: z.literal(INTERVENTION_SCHEMA_VERSION),
    scope: interventionScopeSchema,
    generation: z.number().int().nonnegative().safe(),
    contextRevision: z.number().int().nonnegative().safe(),
    objective: z.string().refine(countBytes(INTERVENTION_OBJECTIVE_MAX_UTF8_BYTES), { message: 'objective over cap' }),
    finalMessages: z.array(interventionFinalMessageSchema).max(INTERVENTION_MAX_FINAL_MESSAGES),
    liveFragment: z
      .string()
      .refine(countBytes(INTERVENTION_LIVE_FRAGMENT_MAX_UTF8_BYTES), { message: 'fragment over cap' }),
    currentCard: interventionCardRefSchema.nullable()
  })
  .strict()
export type InterventionInput = z.infer<typeof interventionInputSchema>

/** Serialized size of a classifier input in UTF-8 bytes (canonical key order). */
export function interventionInputBytes(input: unknown): number {
  return utf8ByteLength(canonicalJson(input))
}

export function assertInterventionByteBudget(maxUtf8Bytes: number): void {
  requireCondition(
    Number.isInteger(maxUtf8Bytes) &&
      maxUtf8Bytes >= INTERVENTION_INPUT_MIN_UTF8_BYTES &&
      maxUtf8Bytes <= INTERVENTION_INPUT_CEILING_UTF8_BYTES,
    'INTERVENTION_BYTE_LIMIT'
  )
}

/**
 * Strict parse for the receiving side (the Operator route, G74): closed key set, per-field byte caps
 * and the total byte budget. Throws InterventionError; never returns a partial value.
 */
export function parseInterventionInput(
  value: unknown,
  maxUtf8Bytes: number = INTERVENTION_INPUT_MAX_UTF8_BYTES
): InterventionInput {
  assertInterventionByteBudget(maxUtf8Bytes)
  const parsed = interventionInputSchema.safeParse(value)
  if (!parsed.success) throw new InterventionError('INTERVENTION_INPUT')
  if (interventionInputBytes(parsed.data) > maxUtf8Bytes) throw new InterventionError('INTERVENTION_BYTE_LIMIT')
  return parsed.data
}

// ---------------------------------------------------------------------------------------------------
// Scores and decision
// ---------------------------------------------------------------------------------------------------

const scoreValue = z.number().min(0).max(1)

export const interventionScoresSchema = z
  .object({
    schemaVersion: z.literal(INTERVENTION_SCHEMA_VERSION),
    scores: z
      .object({
        question: scoreValue,
        objection: scoreValue,
        hesitation: scoreValue,
        decision: scoreValue
      })
      .strict()
  })
  .strict()

export type InterventionScores = Readonly<Record<InterventionScoreName, number>>

/** Closed schema: the four scores in [0, 1] and nothing else (no answer, no action field). */
export function validateInterventionScores(value: unknown): InterventionScores {
  const parsed = interventionScoresSchema.safeParse(value)
  if (!parsed.success) {
    const onScoreValue = parsed.error.issues.some(
      (issue) => issue.path.length === 2 && issue.path[0] === 'scores' && issue.code !== 'unrecognized_keys'
    )
    throw new InterventionError(onScoreValue ? 'SCORE_RANGE' : 'SCORE_SCHEMA')
  }
  return Object.freeze({ ...parsed.data.scores })
}

export const interventionExistingRulesSchema = z
  .object({ shouldGenerate: z.boolean(), reason: z.string().max(160) })
  .strict()
export type InterventionExistingRules = z.infer<typeof interventionExistingRulesSchema>

export const INTERVENTION_STATUSES = ['classified', 'busy', 'stale', 'held', 'existing-rules'] as const
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number]

export const interventionBudgetSchema = z
  .object({
    utf8Bytes: z.number().int().nonnegative(),
    maxUtf8Bytes: z.number().int().positive(),
    finalMessagesUsed: z.number().int().nonnegative(),
    finalMessagesAvailable: z.number().int().nonnegative()
  })
  .strict()
export type InterventionBudget = z.infer<typeof interventionBudgetSchema>

/** What the policy returns. No answer text and no action: a generation decision plus evidence stamp. */
export const interventionDecisionSchema = z
  .object({
    stage: z.literal('intervention-classification'),
    status: z.enum(INTERVENTION_STATUSES),
    shouldGenerate: z.boolean(),
    reason: z.string().max(160),
    scope: interventionScopeSchema,
    generation: z.number().int().nonnegative().safe(),
    contextRevision: z.number().int().nonnegative().safe(),
    scores: interventionScoresSchema.shape.scores.optional(),
    thresholds: z
      .object({
        question: z.number(),
        objection: z.number(),
        hesitation: z.number(),
        decision: z.number()
      })
      .strict()
      .optional(),
    matched: z.array(z.enum(INTERVENTION_SCORE_NAMES)).optional(),
    budget: interventionBudgetSchema.optional()
  })
  .strict()
export type InterventionDecision = z.infer<typeof interventionDecisionSchema>

// ---------------------------------------------------------------------------------------------------
// Structural view of the session context. SessionContext (G02) satisfies it; the policy depends only
// on this so the two tickets can land independently.
// ---------------------------------------------------------------------------------------------------

export interface InterventionSnapshotRef {
  readonly scope: InterventionScope
  readonly generation: number
  readonly contextRevision: number
}

export interface InterventionSegment {
  readonly scope: InterventionScope
  readonly state: string
  readonly utteranceId: string
  readonly streamId: string
  readonly streamEpoch: number
  readonly revision: number
  readonly speakerId: string
  readonly text: string
}

export interface InterventionSnapshot extends InterventionSnapshotRef {
  readonly objective: string
  readonly transcript: {
    readonly scope: InterventionScope
    readonly segments: readonly InterventionSegment[]
  }
}

export interface InterventionContext<S extends InterventionSnapshotRef = InterventionSnapshotRef> {
  /** Subscribe to any context change; returns an unsubscribe function. */
  onChange(listener: (reason: string) => void): () => unknown
  /** Throws unless the snapshot was issued by this context and is still current. */
  assertCurrent(snapshot: S): void
  isCurrent(snapshot: S): boolean
}
