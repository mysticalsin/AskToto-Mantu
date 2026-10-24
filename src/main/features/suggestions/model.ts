import { z } from 'zod'
import {
  DismissReasonSchema,
  EVIDENCE_LABEL_MAX,
  RUN_ERROR_CLASSES,
  RUN_STATES,
  SUGGESTION_TITLE_MAX
} from '@shared/suggestions'

const HEX64 = z.string().regex(/^[0-9a-f]{64}$/)
const HEX24 = z.string().regex(/^[0-9a-f]{24}$/)
const HEX32 = z.string().regex(/^[0-9a-f]{32}$/)
const Millis = z.number().int().nonnegative()

export const EVIDENCE_KINDS = ['calendar', 'memory'] as const

const CalendarRefSchema = z
  .object({ accountRef: z.string().min(1).max(200), eventKey: z.string().regex(/^[0-9a-f]{8,64}$/) })
  .strict()
const MemoryRefSchema = z.object({ memoryId: HEX32, sourceId: z.enum(['preference', 'project-context']) }).strict()

const EvidenceBase = {
  label: z.string().max(EVIDENCE_LABEL_MAX),
  /** Lowercased words of 4+ characters derived from the source text. The text itself is never stored. */
  terms: z.array(z.string().min(4).max(60)).max(12),
  /** When the thing happened. Apart from `retrievedAt`, which is when main read it. */
  eventAt: Millis.nullable(),
  retrievedAt: Millis
}

export const EvidenceSchema = z.discriminatedUnion('sourceKind', [
  z.object({ sourceKind: z.literal('calendar'), ref: CalendarRefSchema, ...EvidenceBase }).strict(),
  z.object({ sourceKind: z.literal('memory'), ref: MemoryRefSchema, ...EvidenceBase }).strict()
])
export type Evidence = z.infer<typeof EvidenceSchema>
export type EvidenceKind = Evidence['sourceKind']

/** One thing a source found. An anchor is an event to prepare for; support is context that may belong to one. */
export interface SourceItem {
  role: 'anchor' | 'support'
  evidence: Evidence
}

export const SUGGESTION_STATES = ['open', 'accepted', 'dismissed', 'expired', 'superseded', 'sources_changed'] as const

export const SuggestionSchema = z
  .object({
    id: HEX24,
    revision: z.number().int().positive(),
    nonce: HEX32,
    ownerKey: HEX64,
    tenantKey: HEX64,
    fingerprint: HEX64,
    evidenceDigest: HEX64,
    title: z.string().min(1).max(SUGGESTION_TITLE_MAX),
    kind: z.literal('prepare_for_event'),
    evidence: z.array(EvidenceSchema).min(1).max(8),
    state: z.enum(SUGGESTION_STATES),
    createdAt: Millis,
    expiresAt: Millis,
    supersededBy: HEX24.optional(),
    /** An adjusted title waiting to be committed. The current revision stays in force until then. */
    pendingRevision: z
      .object({ revision: z.number().int().positive(), title: z.string().min(1).max(SUGGESTION_TITLE_MAX) })
      .strict()
      .optional()
  })
  .strict()
export type Suggestion = z.infer<typeof SuggestionSchema>

export const FeedbackSchema = z
  .object({
    fingerprint: HEX64,
    evidenceDigest: HEX64,
    verdict: z.enum(['accepted', 'dismissed']),
    reason: DismissReasonSchema.optional(),
    at: Millis
  })
  .strict()
export type Feedback = z.infer<typeof FeedbackSchema>

export const NudgeStateSchema = z
  .object({
    unopenedStreak: z.number().int().nonnegative(),
    breaks: z.number().int().nonnegative(),
    quietUntil: Millis.nullable(),
    lastNudgeAt: Millis.nullable()
  })
  .strict()
export type NudgeState = z.infer<typeof NudgeStateSchema>

export const RunSchema = z
  .object({
    runId: HEX24,
    trigger: z.enum(['manual', 'routine']),
    state: z.enum(RUN_STATES),
    enqueuedAt: Millis,
    startedAt: Millis.optional(),
    finishedAt: Millis.optional(),
    sourceMs: z.record(z.string(), Millis).optional(),
    errorClass: z.enum(RUN_ERROR_CLASSES).optional()
  })
  .strict()
export type Run = z.infer<typeof RunSchema>

export const ShownSchema = z.object({ id: HEX24, revision: z.number().int().positive(), nonce: HEX32 }).strict()
export type Shown = z.infer<typeof ShownSchema>

export const MAX_SUGGESTIONS = 200
export const MAX_FEEDBACK = 500
export const MAX_RUNS = 20

export const OwnerDataSchema = z
  .object({
    suggestions: z.array(SuggestionSchema).max(MAX_SUGGESTIONS),
    feedback: z.array(FeedbackSchema).max(MAX_FEEDBACK),
    nudge: NudgeStateSchema,
    runs: z.array(RunSchema).max(MAX_RUNS),
    /** The card the owner was last shown. Accept and dismiss are only honoured for this exact card. */
    shown: ShownSchema.nullable()
  })
  .strict()
export type OwnerData = z.infer<typeof OwnerDataSchema>

export const emptyOwnerData = (): OwnerData => ({
  suggestions: [],
  feedback: [],
  nudge: { unopenedStreak: 0, breaks: 0, quietUntil: null, lastNudgeAt: null },
  runs: [],
  shown: null
})
