/**
 * The routine contract shared by main, the preload bridge and the renderer (Métis 2.12 G66, CAP-31).
 *
 * A routine runs while Métis is open, on this device only (owner decision D-28: no hosted scheduler). Every view carries
 * the availability copy so the UI never claims "always on". The renderer never sees an owner key, a tenant key, an
 * idempotency key, a journal key or a raw action argument, and never supplies a scope: main derives it.
 *
 * Channels live here, not in ipc.ts, so this feature adds no lines to that ratcheted file.
 */
import { z } from 'zod'
import { AssistantIdSchema, PreviewHashSchema, ProposalIdSchema } from './assistants'

/** IPC methods with no input reject accidental or injected payloads instead of silently ignoring them. */
export const RoutineNoPayloadSchema = z.undefined()

export const ROUTINE_IPC = {
  list: 'routines:list',
  compile: 'routines:compile',
  consent: 'routines:consent',
  pause: 'routines:pause',
  resume: 'routines:resume',
  runNow: 'routines:runNow',
  remove: 'routines:delete',
  /** Push (main to renderer): the list changed; fetch it again. */
  changed: 'routines:changed',
  /** Push (main to renderer): one run settled. */
  result: 'routines:result'
} as const

/** PROPOSED bounds. */
export const ROUTINE_TITLE_MAX_CHARS = 80
export const ROUTINE_LIMIT_PER_OWNER = 64
export const ROUTINE_PROPOSAL_TTL_MS = 10 * 60_000
export const ROUTINE_HISTORY_LIMIT = 20
export const ROUTINE_FAILURE_PAUSE_AT = 3
export const ROUTINE_AVAILABILITY_COPY = 'Runs while Métis is open'
export const ROUTINE_TOOLS = ['connector.read', 'web.search'] as const

export const ROUTINE_PURPOSES = ['reminder', 'read_only_suggestion', 'scheduled_task'] as const
export const PAUSE_REASONS = ['user', 'archive', 'quota', 'failure', 'review'] as const
export const ERROR_CLASSES = ['provider', 'connector', 'timeout', 'internal'] as const
export const WAIT_REASONS = ['network', 'quiet', 'owner_busy'] as const
export const RUN_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
  'coalesced',
  'waiting',
  'suppressed'
] as const

export const RoutineIdSchema = z.string().regex(/^r_[0-9a-f]{24}$/)
export const TimeZoneSchema = z.string().min(1).max(64)
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const EPOCH_MS = z.number().int().nonnegative()

export const OnceScheduleSchema = z
  .object({ kind: z.literal('once'), date: DATE, time: TIME, timeZone: TimeZoneSchema })
  .strict()
export const RecurringScheduleSchema = z
  .object({
    kind: z.literal('recurring'),
    cadence: z.enum(['daily', 'weekdays', 'weekly']),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    time: TIME,
    timeZone: TimeZoneSchema
  })
  .strict()
export const ScheduleSchema = z.union([OnceScheduleSchema, RecurringScheduleSchema])

export const ConsentKindSchema = z.enum(['once', 'recurring'])
export const PurposeSchema = z.enum(ROUTINE_PURPOSES)
export const PauseReasonSchema = z.enum(PAUSE_REASONS)
export const ErrorClassSchema = z.enum(ERROR_CLASSES)
export const WaitReasonSchema = z.enum(WAIT_REASONS)
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES)

const TitleSchema = z.string().trim().min(1).max(ROUTINE_TITLE_MAX_CHARS)

/** What the owner asks to schedule. The schedule is a structured spec or a bounded English phrase, never both. */
export const CompileRequestSchema = z
  .object({
    assistantId: AssistantIdSchema,
    purpose: PurposeSchema,
    title: TitleSchema,
    consentKind: ConsentKindSchema,
    schedule: ScheduleSchema.optional(),
    phrase: z.string().min(1).max(120).optional(),
    timeZone: TimeZoneSchema.optional(),
    tools: z.array(z.enum(ROUTINE_TOOLS)).max(ROUTINE_TOOLS.length).optional()
  })
  .strict()
  .refine((v) => (v.schedule === undefined) !== (v.phrase === undefined))
export type CompileRequest = z.infer<typeof CompileRequestSchema>

export const ConsentRequestSchema = z.object({ proposalId: ProposalIdSchema, previewHash: PreviewHashSchema }).strict()
export const RoutineTargetSchema = z.object({ routineId: RoutineIdSchema }).strict()
/** `reconciled` is the owner saying they checked what an interrupted run did; without it a run left open blocks resume. */
export const ResumeRequestSchema = z
  .object({ routineId: RoutineIdSchema, reconciled: z.literal(true).optional() })
  .strict()

export const PreviewSchema = z
  .object({
    assistantId: AssistantIdSchema,
    purpose: PurposeSchema,
    title: TitleSchema,
    consentKind: ConsentKindSchema,
    schedule: ScheduleSchema,
    tools: z.array(z.enum(ROUTINE_TOOLS)).max(ROUTINE_TOOLS.length),
    /** `Every day 09:00 New York; next run <local>`, or `Runs once on <date> ...`. Main's template, not renderer text. */
    copy: z.string().max(200),
    /** Up to three upcoming instants (one for a once routine). */
    nextRuns: z.array(EPOCH_MS).min(1).max(3)
  })
  .strict()
export type RoutinePreview = z.infer<typeof PreviewSchema>

export const AvailabilitySchema = z
  .object({
    runner: z.enum(['running', 'not_running']),
    copy: z.literal(ROUTINE_AVAILABILITY_COPY)
  })
  .strict()
export type RoutineAvailability = z.infer<typeof AvailabilitySchema>

export const HistoryEntryViewSchema = z
  .object({
    outcome: RunOutcomeSchema,
    at: EPOCH_MS,
    count: z.number().int().min(1).max(100_000).optional(),
    waitReason: WaitReasonSchema.optional(),
    errorClass: ErrorClassSchema.optional()
  })
  .strict()

/** What the renderer may see of a routine. No owner key, tenant key, idempotency key, journal key or action args. */
export const RoutineViewSchema = z
  .object({
    routineId: RoutineIdSchema,
    assistantId: AssistantIdSchema,
    title: TitleSchema,
    purpose: PurposeSchema,
    consentKind: ConsentKindSchema,
    schedule: ScheduleSchema,
    copy: z.string().max(200),
    status: z.enum(['active', 'completed']),
    pauseReasons: z.array(PauseReasonSchema).max(PAUSE_REASONS.length),
    waiting: z.object({ reason: WaitReasonSchema, since: EPOCH_MS }).strict().nullable(),
    failures: z.number().int().min(0).max(100),
    lastErrorClass: ErrorClassSchema.nullable(),
    nextDueAt: EPOCH_MS.nullable(),
    /** Set while paused for quota: when the allowance is expected back. */
    quotaResetAt: EPOCH_MS.nullable(),
    history: z.array(HistoryEntryViewSchema).max(ROUTINE_HISTORY_LIMIT),
    availability: AvailabilitySchema
  })
  .strict()
export type RoutineView = z.infer<typeof RoutineViewSchema>

export const LIST_REFUSALS = ['signed-out', 'invalid', 'unavailable'] as const
export const ListResultSchema = z.union([
  z.object({ ok: z.literal(true), routines: z.array(RoutineViewSchema).max(ROUTINE_LIMIT_PER_OWNER) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(LIST_REFUSALS) }).strict()
])
export type ListResult = z.infer<typeof ListResultSchema>

export const COMPILE_REFUSALS = [
  'signed-out',
  'invalid',
  'invalid_zone',
  'invalid_schedule',
  'unrecognized_schedule',
  'consent_mismatch',
  'tool_not_allowed',
  'unsupported',
  'unknown_assistant',
  'assistant_archived',
  'limit',
  'unavailable'
] as const
export const CompileResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      proposalId: ProposalIdSchema,
      /** The renderer echoes this on consent: it proves the exact preview below is what is created. */
      previewHash: PreviewHashSchema,
      expiresAt: EPOCH_MS,
      preview: PreviewSchema
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.enum(COMPILE_REFUSALS) }).strict()
])
export type CompileResult = z.infer<typeof CompileResultSchema>

export const CONSENT_REFUSALS = [
  'signed-out',
  'invalid',
  'unknown-proposal',
  'expired',
  'preview-mismatch',
  'unknown_assistant',
  'assistant_archived',
  'limit',
  'stale',
  'unavailable'
] as const
export const ConsentResultSchema = z.union([
  z.object({ ok: z.literal(true), routine: RoutineViewSchema, created: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(CONSENT_REFUSALS) }).strict()
])
export type ConsentResult = z.infer<typeof ConsentResultSchema>

export const MUTATION_REFUSALS = [
  'signed-out',
  'invalid',
  'not-found',
  'paused',
  'not_runnable',
  'reconciliation_required',
  'assistant_archived',
  'stale',
  'unavailable'
] as const
export const MutationResultSchema = z.union([
  z.object({ ok: z.literal(true), routine: RoutineViewSchema.nullable() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(MUTATION_REFUSALS) }).strict()
])
export type MutationResult = z.infer<typeof MutationResultSchema>

/** Push payloads. Content-free: ids, an outcome and a time. */
export const ChangedPushSchema = z.object({}).strict()
export const ResultPushSchema = z
  .object({ routineId: RoutineIdSchema, outcome: RunOutcomeSchema, at: EPOCH_MS })
  .strict()
export type ResultPush = z.infer<typeof ResultPushSchema>
