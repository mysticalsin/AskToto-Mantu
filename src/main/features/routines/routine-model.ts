import { z } from 'zod'
import {
  ErrorClassSchema,
  PauseReasonSchema,
  PurposeSchema,
  ConsentKindSchema,
  ROUTINE_FAILURE_PAUSE_AT,
  ROUTINE_HISTORY_LIMIT,
  ROUTINE_TITLE_MAX_CHARS,
  RoutineIdSchema,
  RunOutcomeSchema,
  ScheduleSchema,
  WaitReasonSchema
} from '@shared/routines'
import { AssistantIdSchema } from '@shared/assistants'
import type { RoutineSchedule } from './schedule'

export type PauseReason = z.infer<typeof PauseReasonSchema>
export type ErrorClass = z.infer<typeof ErrorClassSchema>
export type WaitReason = z.infer<typeof WaitReasonSchema>
export type RunOutcome = z.infer<typeof RunOutcomeSchema>
export type Purpose = z.infer<typeof PurposeSchema>

const EPOCH = z.number().int().nonnegative()
const HEX64 = z.string().regex(/^[0-9a-f]{64}$/)

export const HistoryEntrySchema = z
  .object({
    occurrenceKey: z.string().max(160),
    outcome: RunOutcomeSchema,
    at: EPOCH,
    count: z.number().int().min(1).max(100_000).optional(),
    waitReason: WaitReasonSchema.optional(),
    errorClass: ErrorClassSchema.optional()
  })
  .strict()
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

/**
 * A stored routine. There is deliberately no `publishable` field: whether a result may be shown is recomputed when a
 * run settles (success, same scope, still runnable, not expired) and is never persisted. The schema is strict, so a file
 * that carries one is not accepted.
 */
export const RoutineRecordSchema = z
  .object({
    routineId: RoutineIdSchema,
    assistantId: AssistantIdSchema,
    ownerKey: HEX64,
    tenantKey: HEX64,
    revision: z.number().int().min(1).max(1_000_000),
    purpose: PurposeSchema,
    title: z.string().min(1).max(ROUTINE_TITLE_MAX_CHARS),
    schedule: ScheduleSchema,
    tools: z.array(z.enum(['connector.read', 'web.search'])).max(2),
    consent: z
      .object({
        consentKind: ConsentKindSchema,
        idempotencyKey: HEX64,
        previewHash: HEX64,
        grantedAt: EPOCH
      })
      .strict(),
    status: z.enum(['active', 'completed']),
    pauseReasons: z.array(PauseReasonSchema).max(5),
    failures: z.number().int().min(0).max(100),
    lastErrorClass: ErrorClassSchema.optional(),
    quota: z.object({ resetAt: EPOCH.nullable(), noticeShownFor: EPOCH.nullable() }).strict().optional(),
    nextDueAt: EPOCH.nullable(),
    lastEvaluatedAt: EPOCH,
    waiting: z
      .object({ reason: WaitReasonSchema, since: EPOCH, occurrenceKey: z.string().max(160) })
      .strict()
      .optional(),
    history: z.array(HistoryEntrySchema).max(ROUTINE_HISTORY_LIMIT),
    action: z
      .object({ request: z.record(z.string(), z.unknown()), argsHash: HEX64 })
      .strict()
      .optional(),
    createdAt: EPOCH,
    updatedAt: EPOCH
  })
  .strict()
export type RoutineRecord = z.infer<typeof RoutineRecordSchema>

export const JOURNAL_STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'uncertain', 'coalesced'] as const

/** The run lease: one entry per `(routineId, revision, occurrenceKey)`. */
export const JournalEntrySchema = z
  .object({
    key: z.string().min(1).max(300),
    routineId: RoutineIdSchema,
    ownerKey: HEX64,
    tenantKey: HEX64,
    status: z.enum(JOURNAL_STATUSES),
    dueAt: EPOCH,
    expiresAt: EPOCH,
    startedAt: EPOCH,
    settledAt: EPOCH.optional()
  })
  .strict()
export type JournalEntry = z.infer<typeof JournalEntrySchema>

export const sortedReasons = (reasons: Iterable<PauseReason>): PauseReason[] => [...new Set(reasons)].sort()

/** Runnable means active with no pause reason at all. */
export const isRunnable = (r: RoutineRecord): boolean => r.status === 'active' && r.pauseReasons.length === 0

export function newRoutineRecord(input: {
  routineId: string
  assistantId: string
  purpose: Purpose
  title: string
  consentKind: 'once' | 'recurring'
  schedule: RoutineSchedule
  tools: Array<'connector.read' | 'web.search'>
  ownerKey: string
  tenantKey: string
  idempotencyKey: string
  previewHash: string
  now: number
  nextDueAt: number | null
  action?: { request: Record<string, unknown>; argsHash: string }
}): RoutineRecord {
  return {
    routineId: input.routineId,
    assistantId: input.assistantId,
    ownerKey: input.ownerKey,
    tenantKey: input.tenantKey,
    revision: 1,
    purpose: input.purpose,
    title: input.title,
    schedule: input.schedule,
    tools: input.tools,
    consent: {
      consentKind: input.consentKind,
      idempotencyKey: input.idempotencyKey,
      previewHash: input.previewHash,
      grantedAt: input.now
    },
    status: 'active',
    pauseReasons: [],
    failures: 0,
    nextDueAt: input.nextDueAt,
    lastEvaluatedAt: input.now,
    history: [],
    ...(input.action ? { action: input.action } : {}),
    createdAt: input.now,
    updatedAt: input.now
  }
}

export function addPause(r: RoutineRecord, reason: PauseReason): RoutineRecord {
  return { ...r, pauseReasons: sortedReasons([...r.pauseReasons, reason]) }
}

/** The allowance is back: clears the `quota` reason and nothing else. */
export function applyAllowanceBack(r: RoutineRecord): RoutineRecord {
  if (!r.pauseReasons.includes('quota')) return r
  const { quota: _quota, ...rest } = r
  void _quota
  return { ...rest, pauseReasons: r.pauseReasons.filter((reason) => reason !== 'quota') }
}

export function pushHistory(
  r: RoutineRecord,
  entry: Omit<HistoryEntry, 'occurrenceKey'> & { occurrenceKey?: string }
): RoutineRecord {
  const full: HistoryEntry = { occurrenceKey: '', ...entry }
  return { ...r, history: [...r.history, full].slice(-ROUTINE_HISTORY_LIMIT) }
}

/**
 * Applies a settled run. Only a genuine failure counts; waiting never reaches here. The third consecutive failure adds
 * `failure`; an uncertain run adds `review`; a success resets the counter.
 */
export function settleRun(
  r: RoutineRecord,
  run: {
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'suppressed'
    errorClass?: ErrorClass
    at: number
    occurrenceKey?: string
  }
): RoutineRecord {
  let next: RoutineRecord = r
  if (run.outcome === 'failed') {
    const failures = Math.min(100, r.failures + 1)
    next = { ...next, failures, lastErrorClass: run.errorClass ?? 'internal' }
    if (failures >= ROUTINE_FAILURE_PAUSE_AT) next = addPause(next, 'failure')
  } else if (run.outcome === 'succeeded') {
    const { lastErrorClass: _last, ...rest } = next
    void _last
    next = { ...rest, failures: 0 }
  } else if (run.outcome === 'uncertain') {
    next = addPause(next, 'review')
  }
  return {
    ...pushHistory(next, {
      outcome: run.outcome,
      at: run.at,
      ...(run.occurrenceKey ? { occurrenceKey: run.occurrenceKey } : {}),
      ...(run.outcome === 'failed' ? { errorClass: run.errorClass ?? 'internal' } : {})
    }),
    updatedAt: run.at
  }
}

export type ResumeResult =
  | { ok: true; record: RoutineRecord }
  | { ok: false; reason: 'assistant_archived' | 'reconciliation_required' }

/**
 * Resume clears `user`, `failure` (and resets the counter) and, once the assistant is no longer archived, `archive`.
 * It clears `review` only when no run is still open. It never touches `quota`.
 */
export function resumeRoutine(
  r: RoutineRecord,
  context: { assistantArchived: boolean; openJournal: boolean }
): ResumeResult {
  if (r.pauseReasons.includes('archive') && context.assistantArchived)
    return { ok: false, reason: 'assistant_archived' }
  if (r.pauseReasons.includes('review') && context.openJournal) return { ok: false, reason: 'reconciliation_required' }
  const kept = r.pauseReasons.filter((reason) => reason === 'quota')
  const { waiting: _waiting, ...rest } = r
  void _waiting
  return {
    ok: true,
    record: { ...rest, pauseReasons: sortedReasons(kept), failures: 0 }
  }
}

/**
 * A stored run lease still `running` cannot be known to have finished or not (the app quit under it): it becomes
 * `uncertain` and its routine is paused for review.
 */
export function restoreRunning(
  routines: readonly RoutineRecord[],
  journal: readonly JournalEntry[]
): { routines: RoutineRecord[]; journal: JournalEntry[]; recovered: number } {
  const uncertain = new Set<string>()
  const nextJournal = journal.map((entry) => {
    if (entry.status !== 'running') return entry
    uncertain.add(entry.routineId)
    return { ...entry, status: 'uncertain' as const }
  })
  const nextRoutines = routines.map((r) => (uncertain.has(r.routineId) ? addPause(r, 'review') : r))
  const recovered = nextJournal.filter((entry, i) => entry !== journal[i]).length
  return { routines: nextRoutines, journal: nextJournal, recovered }
}
