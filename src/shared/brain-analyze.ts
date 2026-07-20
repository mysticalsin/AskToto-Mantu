import { z } from 'zod'

export const BRAIN_ANALYZE_DISCLOSURE =
  'Local AI-generated analysis. Verify against cited meetings.'

const BrainScopeSchema = z.object({ kind: z.literal('brain') }).strict()
const AccountScopeSchema = z
  .object({ kind: z.literal('account'), id: z.string().min(1).max(200) })
  .strict()
const DealScopeSchema = z
  .object({ kind: z.literal('deal'), id: z.string().min(1).max(200) })
  .strict()
const MeetingScopeSchema = z
  .object({ kind: z.literal('meeting'), id: z.string().min(1).max(200) })
  .strict()
const AnyScopeSchema = z.union([
  BrainScopeSchema,
  AccountScopeSchema,
  DealScopeSchema,
  MeetingScopeSchema
])
const LanguageSchema = z.enum(['en', 'fr'])

export const BrainAnalyzeRequestSchema = z.discriminatedUnion('task', [
  z
    .object({
      version: z.literal(1),
      task: z.literal('briefing'),
      scope: BrainScopeSchema,
      language: LanguageSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      task: z.literal('account-summary'),
      scope: AccountScopeSchema,
      language: LanguageSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      task: z.literal('deal-summary'),
      scope: DealScopeSchema,
      language: LanguageSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      task: z.literal('meeting-summary'),
      scope: MeetingScopeSchema,
      language: LanguageSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      task: z.literal('question'),
      scope: AnyScopeSchema,
      question: z.string().min(1).max(500),
      language: LanguageSchema
    })
    .strict()
])
export type BrainAnalyzeRequest = z.infer<typeof BrainAnalyzeRequestSchema>

const EvidenceIdSchema = z.string().regex(/^[0-9a-f]{64}$/)
const EvidenceFileSchema = z.string().min(1).max(300)

const TranscriptEvidenceSchema = z
  .object({
    id: EvidenceIdSchema,
    grounding: z.literal('transcript'),
    file: EvidenceFileSchema,
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    quote: z.string().min(1).max(1000)
  })
  .strict()
  .refine((value) => value.lineEnd >= value.lineStart, {
    message: 'lineEnd must be greater than or equal to lineStart',
    path: ['lineEnd']
  })

const DerivedEvidenceSchema = z
  .object({
    id: EvidenceIdSchema,
    grounding: z.literal('derived'),
    file: EvidenceFileSchema,
    lineStart: z.null(),
    lineEnd: z.null(),
    quote: z.literal(''),
    derivedText: z.string().min(1).max(1000)
  })
  .strict()

const BrainAnalyzeEvidenceSchema = z.union([
  TranscriptEvidenceSchema,
  DerivedEvidenceSchema
])

const BrainAnalyzePointSchema = z
  .object({
    text: z.string().min(1).max(1000),
    evidenceIds: z
      .array(EvidenceIdSchema)
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Point evidence IDs must be unique.'
      })
  })
  .strict()

const NonnegativeFiniteSchema = z.number().finite().nonnegative()

export const BrainAnalyzeResultSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['ok', 'insufficient-evidence', 'blocked']),
    disclosure: z.literal(BRAIN_ANALYZE_DISCLOSURE),
    answer: z.string().max(4000),
    points: z.array(BrainAnalyzePointSchema).max(50),
    evidence: z.array(BrainAnalyzeEvidenceSchema).max(100),
    model: z
      .object({
        id: z.string().min(1).max(128),
        sha256: z.string().regex(/^[0-9a-f]{64}$/)
      })
      .strict(),
    timing: z
      .object({
        loadMs: NonnegativeFiniteSchema,
        prefillMs: NonnegativeFiniteSchema,
        generateMs: NonnegativeFiniteSchema,
        totalMs: NonnegativeFiniteSchema
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    const evidenceIds = value.evidence.map((evidence) => evidence.id)
    const knownEvidenceIds = new Set(evidenceIds)

    if (knownEvidenceIds.size !== evidenceIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence IDs must be unique.',
        path: ['evidence']
      })
    }

    value.points.forEach((point, pointIndex) => {
      point.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!knownEvidenceIds.has(evidenceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Point references missing evidence.',
            path: ['points', pointIndex, 'evidenceIds', evidenceIndex]
          })
        }
      })
    })
  })
export type BrainAnalyzeResult = z.infer<typeof BrainAnalyzeResultSchema>
