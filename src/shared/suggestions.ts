/**
 * Read-only research and suggestion pipeline contract (G67, CAP-32). Main gathers from sources the owner has already
 * granted and shows suggestion cards; the owner accepts or dismisses them. Nothing here writes to any provider.
 *
 * What a renderer can NOT do on this surface: name an owner, tenant, account, grant or source (strict schemas reject
 * unknown keys), accept a card it has not been shown, or accept a card whose revision or nonce is not the current one.
 * Replies are content-free refusals; they never say why a card was refused beyond the typed reason.
 */
import { z } from 'zod'

export const SUGGESTION_IPC = {
  list: 'suggestions:list',
  checkNow: 'suggestions:checkNow',
  shown: 'suggestions:shown',
  accept: 'suggestions:accept',
  dismiss: 'suggestions:dismiss',
  adjust: 'suggestions:adjust'
} as const

export const DISMISS_REASONS = ['not_useful', 'wrong', 'already_done', 'other'] as const
export const DismissReasonSchema = z.enum(DISMISS_REASONS)
export type DismissReason = z.infer<typeof DismissReasonSchema>

export const SUGGESTION_TITLE_MAX = 160
export const EVIDENCE_LABEL_MAX = 120

/** A card, as the renderer names it: the id, the revision it saw and the nonce issued with that revision. */
export const CardRefSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/),
    revision: z.number().int().positive(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/)
  })
  .strict()
export type CardRef = z.infer<typeof CardRefSchema>

export const DismissRequestSchema = CardRefSchema.extend({ reason: DismissReasonSchema }).strict()
export type DismissRequest = z.infer<typeof DismissRequestSchema>

const TitleSchema = z.string().trim().min(1).max(SUGGESTION_TITLE_MAX)
export const AdjustRequestSchema = z.discriminatedUnion('action', [
  CardRefSchema.extend({ action: z.literal('draft'), title: TitleSchema }).strict(),
  CardRefSchema.extend({ action: z.literal('commit') }).strict(),
  CardRefSchema.extend({ action: z.literal('cancel') }).strict()
])
export type AdjustRequest = z.infer<typeof AdjustRequestSchema>

/** `list` and `checkNow` take no input: an injected payload is invalid, not ignored. */
export const SuggestionNoPayloadSchema = z.undefined()

export const RUN_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export const RUN_ERROR_CLASSES = ['connector', 'internal', 'timeout'] as const

export const RunViewSchema = z
  .object({
    runId: z.string().regex(/^[0-9a-f]{24}$/),
    trigger: z.enum(['manual', 'routine']),
    state: z.enum(RUN_STATES),
    enqueuedAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().optional(),
    finishedAt: z.number().int().nonnegative().optional(),
    /** Time spent reading each source. Kept apart from the time the run waited in the queue. */
    sourceMs: z.record(z.string(), z.number().int().nonnegative()).optional(),
    errorClass: z.enum(RUN_ERROR_CLASSES).optional()
  })
  .strict()
export type RunView = z.infer<typeof RunViewSchema>

export const EvidenceViewSchema = z
  .object({
    sourceKind: z.enum(['calendar', 'memory']),
    label: z.string().max(EVIDENCE_LABEL_MAX),
    /** When the thing happened (an event start, when the owner said it). Null when it has no time of its own. */
    eventAt: z.number().int().nonnegative().nullable(),
    /** When main read it. Never the same thing as `eventAt`. */
    retrievedAt: z.number().int().nonnegative()
  })
  .strict()

export const CardViewSchema = CardRefSchema.extend({
  title: z.string().max(SUGGESTION_TITLE_MAX),
  evidence: z.array(EvidenceViewSchema).max(8),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative()
}).strict()
export type CardView = z.infer<typeof CardViewSchema>

const REFUSALS = ['signed-out', 'disabled', 'unavailable', 'invalid'] as const
const refusal = z.object({ ok: z.literal(false), reason: z.enum(REFUSALS) }).strict()

export const ListResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      cards: z.array(CardViewSchema).max(200),
      lastShownId: z
        .string()
        .regex(/^[0-9a-f]{24}$/)
        .nullable(),
      activeRun: RunViewSchema.nullable(),
      lastRun: RunViewSchema.nullable()
    })
    .strict(),
  refusal
])
export type ListResult = z.infer<typeof ListResultSchema>

export const CheckResultSchema = z.union([
  z.object({ ok: z.literal(true), run: RunViewSchema, created: z.number().int().nonnegative() }).strict(),
  refusal
])
export type CheckResult = z.infer<typeof CheckResultSchema>

export const AckResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum([...REFUSALS, 'stale']) }).strict()
])
export type AckResult = z.infer<typeof AckResultSchema>

export const AcceptResultSchema = z.union([
  /** The labels of the sources the card rests on ("Sources: ..."), for a later task to start from. */
  z
    .object({ ok: z.literal(true), sources: z.array(z.string().max(EVIDENCE_LABEL_MAX)).max(8) })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.enum([...REFUSALS, 'stale', 'sources_changed']) }).strict()
])
export type AcceptResult = z.infer<typeof AcceptResultSchema>

export const AdjustResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      revision: z.number().int().positive(),
      /** Present only once a revision is committed. */
      nonce: z
        .string()
        .regex(/^[0-9a-f]{32}$/)
        .optional()
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.enum([...REFUSALS, 'stale']) }).strict()
])
export type AdjustResult = z.infer<typeof AdjustResultSchema>
