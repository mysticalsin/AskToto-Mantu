import { z } from 'zod'
import { InstantSchema, PrincipalRefSchema, RecordAddressSchema, RevisionSchema, SourceRefSchema } from './identity'
import { reportIssue } from './issue'

/**
 * Provenance of canonical knowledge (ADR-019, M2-0120). The unit is a claim: one value of one record
 * field, the state that says how far it can be trusted, and the evidence it rests on. A model's
 * probability is a separate `confidence` band and never changes the state.
 */

export const ProvenanceStateSchema = z.enum([
  // Origin: produced by a source system or a model. Never certified by a person.
  'SOURCE-OBSERVED',
  'EXTRACTED',
  'INFERRED',
  // Human: a named user acted on the value at a stated record revision.
  'HUMAN-VERIFIED',
  'PINNED',
  'EDITED',
  // Condition: the value is not presented as settled, current truth.
  'DISPUTED',
  'SUPERSEDED',
  'STALE',
  'DELETED'
])
export type ProvenanceState = z.infer<typeof ProvenanceStateSchema>

const ORIGIN_STATES: ReadonlySet<ProvenanceState> = new Set(['SOURCE-OBSERVED', 'EXTRACTED', 'INFERRED'])
const HUMAN_STATES: ReadonlySet<ProvenanceState> = new Set(['HUMAN-VERIFIED', 'PINNED', 'EDITED'])

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)])
)

/** A top-level record field. Never a path, so a patch cannot reach into nested values or the envelope. */
export const FieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)

/** A byte-exact excerpt of the cited evidence: never trimmed or normalized. */
const QuoteSchema = z.string().min(1).max(2000)

/**
 * What a claim rests on: a canonical record at an exact revision (an approved summary is cited as that
 * summary), or a source item at an exact revision. A record reference has no tenant, so evidence can
 * never cross tenants.
 */
export const EvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('record'),
    record: RecordAddressSchema,
    revision: RevisionSchema,
    quote: QuoteSchema.optional()
  }),
  z.object({ kind: z.literal('source'), source: SourceRefSchema, quote: QuoteSchema.optional() })
])
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

/** An act on a claim by a user or a service: who, when, and the record revision it applies to. */
export const AttestationSchema = z.object({
  by: PrincipalRefSchema.refine((principal) => principal.kind !== 'group', 'A group never acts.'),
  at: InstantSchema,
  revision: RevisionSchema
})

const ClaimShapeSchema = z.object({
  value: JsonValueSchema,
  state: ProvenanceStateSchema,
  /** When the evidence asserted this value (for a meeting, when the meeting took place). */
  observedAt: InstantSchema,
  // Bounded so one claim cannot grow a record without limit; broader support is an approved summary record.
  evidence: z.array(EvidenceRefSchema).max(16),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  attestation: AttestationSchema.optional()
})

function checkClaim(claim: z.infer<typeof ClaimShapeSchema>, context: z.RefinementCtx): void {
  const { state, attestation } = claim
  if ((claim.value === null) !== (state === 'DELETED')) {
    reportIssue(context, 'A claim has no value exactly when it is DELETED.', ['value'])
  }
  if ((HUMAN_STATES.has(state) || state === 'DELETED') && !attestation) {
    reportIssue(context, `A ${state} claim names who acted and at which revision.`, ['attestation'])
  }
  if (HUMAN_STATES.has(state) && attestation && attestation.by.kind !== 'user') {
    reportIssue(context, `Only a user puts a claim in ${state}.`, ['attestation', 'by', 'kind'])
  }
  if (ORIGIN_STATES.has(state) && attestation) {
    reportIssue(context, `A ${state} claim is not attested.`, ['attestation'])
  }
  if (claim.confidence && (HUMAN_STATES.has(state) || state === 'SOURCE-OBSERVED')) {
    reportIssue(context, `Confidence is a model probability, and a ${state} claim has none.`, ['confidence'])
  }
  if (state === 'EXTRACTED' && !claim.evidence.some((evidence) => evidence.quote)) {
    reportIssue(context, 'An EXTRACTED claim quotes its evidence.', ['evidence'])
  }
  if (state === 'SOURCE-OBSERVED' && !claim.evidence.some((evidence) => evidence.kind === 'source')) {
    reportIssue(context, 'A SOURCE-OBSERVED claim cites the source item it was read from.', ['evidence'])
  }
  if (state === 'DELETED') {
    claim.evidence.forEach((evidence, index) => {
      if (evidence.quote) reportIssue(context, 'A DELETED claim keeps no quoted content.', ['evidence', index, 'quote'])
    })
  }
}

export const ClaimSchema = ClaimShapeSchema.superRefine(checkClaim)
export type Claim = z.infer<typeof ClaimSchema>

/**
 * One record field. `current` is the value presented, in whatever state it is in. `history` holds the
 * values it replaced, and `disputes` holds contradicting values that wait for a person to resolve them.
 * Both are capped at 10, like the legacy brain's `superseded` history.
 */
export const FieldSchema = z
  .object({
    current: ClaimSchema,
    history: z.array(ClaimSchema).max(10),
    disputes: z.array(ClaimSchema).max(10)
  })
  .superRefine((field, context) => {
    if (field.current.state === 'SUPERSEDED') {
      reportIssue(context, 'A SUPERSEDED value is history, not the current value.', ['current', 'state'])
    }
    if (field.current.state === 'DISPUTED' && field.disputes.length === 0) {
      reportIssue(context, 'A DISPUTED value names the value it conflicts with.', ['disputes'])
    }
    field.history.forEach((claim, index) => {
      if (claim.state !== 'SUPERSEDED') {
        reportIssue(context, 'A history entry is SUPERSEDED.', ['history', index, 'state'])
      }
    })
    field.disputes.forEach((claim, index) => {
      if (claim.state !== 'DISPUTED') {
        reportIssue(context, 'A dispute entry is DISPUTED.', ['disputes', index, 'state'])
      }
    })
  })
export type Field = z.infer<typeof FieldSchema>
