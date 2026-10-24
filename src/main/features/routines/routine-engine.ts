import { createHash, randomUUID } from 'node:crypto'
import type { QuietAction } from '@shared/quiet-mode-settings'
import {
  ConsentRequestSchema,
  ResumeRequestSchema,
  ROUTINE_AVAILABILITY_COPY,
  ROUTINE_LIMIT_PER_OWNER,
  ROUTINE_PROPOSAL_TTL_MS,
  ROUTINE_TOOLS,
  RoutineTargetSchema,
  type CompileRequest,
  type CompileResult,
  type ConsentResult,
  type ListResult,
  type MutationResult,
  type ResultPush,
  type RoutinePreview,
  type RoutineView
} from '@shared/routines'
import { canonicalJson } from '../../action-guard'
import type { SchedulerLimits, SchedulerResult, TaskScheduler } from '../../tasks/task-scheduler'
import { evaluateRoutine, leaseKey, type Gates, type Job, type RoutineAuditPhase } from './routine-evaluate'
import {
  addPause,
  newRoutineRecord,
  pushHistory,
  resumeRoutine,
  settleRun,
  type ErrorClass,
  type JournalEntry,
  type RoutineRecord
} from './routine-model'
import type { RoutineScope, RoutineStore } from './routine-store'
import { compileSchedule, nextOccurrence, scheduleCopy } from './schedule'

export type { RoutineAuditPhase } from './routine-evaluate'

/** One owner runs at most one effect job and two read-only jobs; every routine job is read-only to the scheduler. */
export const ROUTINE_SCHEDULER_LIMITS: SchedulerLimits = {
  maxEffectPerOwner: 1,
  maxReadOnlyPerOwner: 2,
  maxQueuedPerOwner: 4,
  maxQueueWaitMs: 60_000
}

const DAY = 24 * 60 * 60_000
const JOURNAL_MAX = 512
const JOURNAL_SETTLED_TTL = 30 * DAY
const MAX_PENDING_PROPOSALS = 64

export type RoutinePublication =
  | { kind: 'routine'; purpose: 'reminder' | 'read_only_suggestion'; title: string }
  | { kind: 'allowance'; resetAt: number | null }

export type ResearchResult = { ok: true } | { ok: false; errorClass: ErrorClass; uncertain?: boolean }

export type RoutineEvent = { type: 'changed' } | ({ type: 'result' } & ResultPush)

export interface RoutineEngineDeps {
  store: RoutineStore
  /** The scope the store reads: the verified owner and tenant keys and the partition in force. */
  scope(): RoutineScope | null
  /** One scheduler for all routine jobs, built with `ROUTINE_SCHEDULER_LIMITS`. */
  scheduler: Pick<TaskScheduler, 'submit' | 'stop'>
  now(): number
  defaultTimeZone(): string
  /** The owner's assistants, read only (G48). Null when they cannot be read. */
  assistants(): Promise<ReadonlyArray<{ assistantId: string; archived: boolean }> | null>
  isOnline(): boolean
  /** The allowance meter (D-16). Production reports available until a meter exists. */
  allowance(): { available: true } | { available: false; resetAt: number | null }
  /** The quiet policy for an unsolicited toast right now (G68). */
  quietAction(): QuietAction
  /** Hands output to the quiet gate (`submitQuietOutput`). Never a direct request. */
  publish(output: RoutinePublication): QuietAction
  /** False while a confirm card is current (an acting routine waits for it). */
  commandIdle(): boolean
  /** Absent in production until G67: compile then refuses `read_only_suggestion` as unsupported. */
  research?(request: { title: string; tools: readonly string[] }, signal: AbortSignal): Promise<ResearchResult>
  /**
   * Absent in production until G69/G64: compile then refuses `scheduled_task` as unsupported. The port proposes the
   * action through the confirm card; the effect itself belongs to the desktop-action bridge after the owner confirms.
   */
  proposeAction?(
    action: { request: Record<string, unknown>; argsHash: string },
    context: { routineId: string }
  ): Promise<{ shown: boolean }>
  /** Phase, enum reason and counts only: never a title, a phrase, an assistant name or id, or meeting content. */
  audit(record: { phase: RoutineAuditPhase; reason?: string; count?: number }): void
  emit(event: RoutineEvent): void
  newId?(): string
}

export type CompileInput = Omit<CompileRequest, 'tools'> & {
  tools?: readonly string[]
  /** A `scheduled_task` carries the action it would propose; it never reaches a renderer view. */
  action?: { request: Record<string, unknown> }
}

export interface RoutineEngine {
  compile(input: CompileInput): Promise<CompileResult>
  consent(input: unknown): Promise<ConsentResult>
  list(): Promise<ListResult>
  pause(input: unknown): Promise<MutationResult>
  resume(input: unknown): Promise<MutationResult>
  runNow(input: unknown): Promise<MutationResult>
  remove(input: unknown): Promise<MutationResult>
  /** Evaluates every routine. Single flight: a tick that arrives while one runs asks for one more pass. */
  tick(): Promise<void>
  /** Sign-out, revocation or an owner switch: abort jobs, forget proposals, withhold late results. */
  onOwnerChange(): void
  /** Resolves when every started run has settled. */
  idle(): Promise<void>
}

interface Proposal {
  scopeKey: string
  preview: RoutinePreview
  previewHash: string
  expiresAt: number
  action?: { request: Record<string, unknown>; argsHash: string }
}

const sha = (...parts: readonly unknown[]): string => createHash('sha256').update(canonicalJson(parts)).digest('hex')
const scopeKeyOf = (s: RoutineScope): string => `${s.partitionId}\0${s.tenantKey}\0${s.ownerKey}`
const sameScope = (a: RoutineScope, b: RoutineScope | null): boolean => b !== null && scopeKeyOf(a) === scopeKeyOf(b)
const isOpen = (e: JournalEntry): boolean => e.status === 'running' || e.status === 'uncertain'

export function createRoutineEngine(deps: RoutineEngineDeps): RoutineEngine {
  const proposals = new Map<string, Proposal>()
  const inflight = new Set<Promise<void>>()
  const noticed = new Set<number>()
  const newId = deps.newId ?? randomUUID
  let generation = 0
  let stopped = false
  let ticking = false
  let again = false

  const audit = (phase: RoutineAuditPhase, detail: { reason?: string; count?: number } = {}): void => {
    try {
      deps.audit({ phase, ...detail })
    } catch {
      // an audit failure never changes the outcome
    }
  }
  const emit = (event: RoutineEvent): void => {
    try {
      deps.emit(event)
    } catch {
      // a push failure never changes the outcome
    }
  }
  const publish = (output: RoutinePublication): QuietAction => {
    try {
      return deps.publish(output)
    } catch {
      return 'drop'
    }
  }

  const runner = (): 'running' | 'not_running' => (deps.scope() !== null && !stopped ? 'running' : 'not_running')

  const viewOf = (r: RoutineRecord): RoutineView => ({
    routineId: r.routineId,
    assistantId: r.assistantId,
    title: r.title,
    purpose: r.purpose,
    consentKind: r.consent.consentKind,
    schedule: r.schedule,
    copy: scheduleCopy(r.schedule),
    status: r.status,
    pauseReasons: r.pauseReasons,
    waiting: r.waiting ? { reason: r.waiting.reason, since: r.waiting.since } : null,
    failures: r.failures,
    lastErrorClass: r.lastErrorClass ?? null,
    nextDueAt: r.nextDueAt,
    quotaResetAt: r.pauseReasons.includes('quota') ? (r.quota?.resetAt ?? null) : null,
    history: r.history.map(({ occurrenceKey: _key, ...entry }) => {
      void _key
      return entry
    }),
    availability: { runner: runner(), copy: ROUTINE_AVAILABILITY_COPY }
  })

  const archivedSet = async (): Promise<Set<string> | null> => {
    try {
      const rows = await deps.assistants()
      return rows ? new Set(rows.filter((row) => row.archived).map((row) => row.assistantId)) : null
    } catch {
      return null
    }
  }

  const prune = (journal: JournalEntry[], now: number): JournalEntry[] => {
    const kept = journal.filter((e) => isOpen(e) || (e.settledAt ?? e.startedAt) > now - JOURNAL_SETTLED_TTL)
    return kept.length > JOURNAL_MAX ? kept.slice(kept.length - JOURNAL_MAX) : kept
  }

  const dropExpiredProposals = (now: number): void => {
    for (const [id, p] of proposals) if (p.expiresAt <= now) proposals.delete(id)
  }

  // ----------------------------------------------------------------------------------------------- compile / consent

  const compile = async (input: CompileInput): Promise<CompileResult> => {
    const scope = deps.scope()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    const now = deps.now()
    const compiled = compileSchedule(
      { spec: input.schedule, phrase: input.phrase, timeZone: input.timeZone },
      now,
      deps.defaultTimeZone()
    )
    if (!compiled.ok) return { ok: false, reason: compiled.reason }
    const { schedule } = compiled.compiled
    if ((input.consentKind === 'once') !== (schedule.kind === 'once')) return { ok: false, reason: 'consent_mismatch' }

    const tools = input.purpose === 'read_only_suggestion' ? [...new Set(input.tools ?? [])] : []
    const allowedTools: readonly string[] = ROUTINE_TOOLS
    if (tools.some((tool) => !allowedTools.includes(tool))) return { ok: false, reason: 'tool_not_allowed' }
    if (input.purpose === 'read_only_suggestion' && !deps.research) return { ok: false, reason: 'unsupported' }
    let action: Proposal['action']
    if (input.purpose === 'scheduled_task') {
      if (!deps.proposeAction || !input.action) return { ok: false, reason: 'unsupported' }
      action = { request: input.action.request, argsHash: sha('metis.routine.action.v1', input.action.request) }
    }

    let known: ReadonlyArray<{ assistantId: string; archived: boolean }> | null = null
    try {
      known = await deps.assistants()
    } catch {
      known = null
    }
    if (known === null) return { ok: false, reason: 'unavailable' }
    const assistant = known.find((row) => row.assistantId === input.assistantId)
    if (!assistant) return { ok: false, reason: 'unknown_assistant' }
    if (assistant.archived) return { ok: false, reason: 'assistant_archived' }

    dropExpiredProposals(now)
    if (!sameScope(scope, deps.scope())) return { ok: false, reason: 'signed-out' }
    const preview: RoutinePreview = {
      assistantId: input.assistantId,
      purpose: input.purpose,
      title: input.title.trim(),
      consentKind: input.consentKind,
      schedule,
      tools: tools as RoutinePreview['tools'],
      copy: compiled.compiled.copy,
      nextRuns: compiled.compiled.nextRuns
    }
    // The hash binds what the owner consents to; the next-run times drift with the clock and are left out of it.
    const previewHash = sha(
      'metis.routine.preview.v1',
      preview.assistantId,
      preview.purpose,
      preview.title,
      preview.consentKind,
      preview.schedule,
      preview.tools,
      action?.argsHash ?? null
    )
    const proposalId = sha('metis.routine.proposal.v1', scope.tenantKey, scope.ownerKey, previewHash).slice(0, 32)
    proposals.set(proposalId, {
      scopeKey: scopeKeyOf(scope),
      preview,
      previewHash,
      expiresAt: now + ROUTINE_PROPOSAL_TTL_MS,
      ...(action ? { action } : {})
    })
    while (proposals.size > MAX_PENDING_PROPOSALS) proposals.delete(proposals.keys().next().value as string)
    audit('compiled')
    return { ok: true, proposalId, previewHash, expiresAt: now + ROUTINE_PROPOSAL_TTL_MS, preview }
  }

  const consent = async (raw: unknown): Promise<ConsentResult> => {
    const scope = deps.scope()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    const parsed = ConsentRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid' }
    const now = deps.now()
    const proposal = proposals.get(parsed.data.proposalId)
    if (!proposal || proposal.scopeKey !== scopeKeyOf(scope)) return { ok: false, reason: 'unknown-proposal' }
    if (proposal.expiresAt <= now) {
      proposals.delete(parsed.data.proposalId)
      return { ok: false, reason: 'expired' }
    }
    if (proposal.previewHash !== parsed.data.previewHash) return { ok: false, reason: 'preview-mismatch' }
    const archived = await archivedSet()
    const preview = proposal.preview
    if (archived?.has(preview.assistantId)) return { ok: false, reason: 'assistant_archived' }
    const routineId = `r_${sha('metis.routine.id.v1', scope.tenantKey, scope.ownerKey, proposal.previewHash).slice(0, 24)}`
    const result = await deps.store.transact<{ routine: RoutineRecord; created: boolean } | 'limit'>((view) => {
      const existing = view.own.find((r) => r.routineId === routineId)
      if (existing) return { commit: false as const, value: { routine: existing, created: false } }
      if (view.own.length >= ROUTINE_LIMIT_PER_OWNER) return { commit: false as const, value: 'limit' as const }
      const record = newRoutineRecord({
        routineId,
        assistantId: preview.assistantId,
        purpose: preview.purpose,
        title: preview.title,
        consentKind: preview.consentKind,
        schedule: preview.schedule,
        tools: preview.tools,
        ownerKey: scope.ownerKey,
        tenantKey: scope.tenantKey,
        idempotencyKey: sha('metis.routine.idempotency.v1', scope.tenantKey, scope.ownerKey, proposal.previewHash),
        previewHash: proposal.previewHash,
        now,
        nextDueAt: nextOccurrence(preview.schedule, now)?.dueAt ?? null,
        ...(proposal.action ? { action: proposal.action } : {})
      })
      return {
        commit: true as const,
        routines: [...view.own, record],
        journal: [...view.journal],
        value: { routine: record, created: true }
      }
    }, scope)
    if (!result.ok) return { ok: false, reason: result.reason === 'signed-out' ? 'signed-out' : result.reason }
    if (result.value === 'limit') return { ok: false, reason: 'limit' }
    audit(result.value.created ? 'consented' : 'replayed')
    if (result.value.created) emit({ type: 'changed' })
    return { ok: true, routine: viewOf(result.value.routine), created: result.value.created }
  }

  const list = async (): Promise<ListResult> => {
    const result = await deps.store.transact((view) => ({ commit: false as const, value: view.own.map(viewOf) }))
    if (!result.ok) return { ok: false, reason: result.reason === 'stale' ? 'unavailable' : result.reason }
    return { ok: true, routines: result.value }
  }

  // ----------------------------------------------------------------------------------------------------- mutations

  type Mutate = (
    r: RoutineRecord,
    view: { journal: readonly JournalEntry[] },
    now: number
  ) =>
    | { ok: true; record: RoutineRecord | null; journal?: JournalEntry[] }
    | { ok: false; reason: Extract<MutationResult, { ok: false }>['reason'] }

  const mutate = async (
    raw: unknown,
    schema: typeof RoutineTargetSchema | typeof ResumeRequestSchema,
    fn: Mutate
  ): Promise<MutationResult> => {
    const scope = deps.scope()
    if (scope === null) return { ok: false, reason: 'signed-out' }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid' }
    const now = deps.now()
    type Out = ReturnType<Mutate>
    const result = await deps.store.transact<Out>((view) => {
      const found = view.own.find((r) => r.routineId === parsed.data.routineId)
      if (!found) return { commit: false as const, value: { ok: false as const, reason: 'not-found' as const } }
      const out = fn(found, view, now)
      if (!out.ok) return { commit: false as const, value: out }
      return {
        commit: true as const,
        routines: view.own.flatMap((r) => (r.routineId !== found.routineId ? [r] : out.record ? [out.record] : [])),
        journal:
          out.journal ?? (out.record ? [...view.journal] : view.journal.filter((e) => e.routineId !== found.routineId)),
        value: out
      }
    }, scope)
    if (!result.ok) return { ok: false, reason: result.reason }
    if (!result.value.ok) return { ok: false, reason: result.value.reason }
    emit({ type: 'changed' })
    return { ok: true, routine: result.value.record ? viewOf(result.value.record) : null }
  }

  const pause = (raw: unknown): Promise<MutationResult> =>
    mutate(raw, RoutineTargetSchema, (r, _view, now) => {
      audit('paused', { reason: 'user' })
      const { waiting: _waiting, ...rest } = r
      void _waiting
      return { ok: true, record: { ...addPause(rest, 'user'), updatedAt: now } }
    })

  const resume = async (raw: unknown): Promise<MutationResult> => {
    const archived = await archivedSet()
    const reconciled = (raw as { reconciled?: unknown } | null)?.reconciled === true
    return mutate(raw, ResumeRequestSchema, (r, view, now) => {
      const mine = view.journal.filter((e) => e.routineId === r.routineId)
      const out = resumeRoutine(r, {
        assistantArchived: archived?.has(r.assistantId) ?? false,
        openJournal: mine.some((e) => e.status === 'running' || (e.status === 'uncertain' && !reconciled))
      })
      if (!out.ok) {
        audit('refused', { reason: out.reason })
        return out
      }
      audit('resumed')
      // Missed occurrences while paused are not replayed.
      const record: RoutineRecord = {
        ...out.record,
        lastEvaluatedAt: now,
        nextDueAt: out.record.status === 'active' ? (nextOccurrence(out.record.schedule, now)?.dueAt ?? null) : null,
        updatedAt: now
      }
      const journal = view.journal.map((e) =>
        e.routineId === r.routineId && e.status === 'uncertain'
          ? { ...e, status: 'cancelled' as const, settledAt: now }
          : e
      )
      return { ok: true, record, journal }
    })
  }

  const remove = (raw: unknown): Promise<MutationResult> =>
    mutate(raw, RoutineTargetSchema, () => {
      audit('deleted')
      return { ok: true, record: null }
    })

  const runNow = async (raw: unknown): Promise<MutationResult> => {
    const scope = deps.scope()
    const archived = await archivedSet()
    const started: { job: Job | null } = { job: null }
    const out = await mutate(raw, RoutineTargetSchema, (r, view, now) => {
      if (archived?.has(r.assistantId)) return { ok: false, reason: 'assistant_archived' }
      if (r.pauseReasons.length > 0) return { ok: false, reason: 'paused' }
      if (r.status !== 'active') return { ok: false, reason: 'not_runnable' }
      if (r.purpose === 'read_only_suggestion' && !deps.research) return { ok: false, reason: 'not_runnable' }
      if (r.purpose === 'scheduled_task' && !deps.proposeAction) return { ok: false, reason: 'not_runnable' }
      if (view.journal.some((e) => e.routineId === r.routineId && isOpen(e)))
        return { ok: false, reason: 'not_runnable' }
      const occurrenceKey = `now:${newId()}`
      const key = leaseKey(r.routineId, r.revision, occurrenceKey)
      const entry: JournalEntry = {
        key,
        routineId: r.routineId,
        ownerKey: r.ownerKey,
        tenantKey: r.tenantKey,
        status: 'running',
        dueAt: now,
        expiresAt: now + DAY,
        startedAt: now
      }
      started.job = {
        scope: scope!,
        routineId: r.routineId,
        journalKey: key,
        occurrenceKey,
        expiresAt: now + DAY,
        purpose: r.purpose,
        title: r.title,
        tools: r.tools,
        ...(r.action ? { action: r.action } : {})
      }
      audit('claimed', { reason: 'run_now' })
      // The next scheduled start (nextDueAt) and the evaluation cursor stay exactly as they were.
      return { ok: true, record: r, journal: prune([...view.journal, entry], now) }
    })
    if (out.ok && started.job) launch(started.job)
    return out
  }

  // ---------------------------------------------------------------------------------------------------------- tick

  const runTick = async (): Promise<void> => {
    const scope = deps.scope()
    if (scope === null) return
    stopped = false
    const archived = (await archivedSet()) ?? new Set<string>()
    const gates: Gates = {
      now: deps.now(),
      archived,
      online: deps.isOnline(),
      quiet: deps.quietAction(),
      idle: deps.commandIdle(),
      allowance: deps.allowance()
    }
    const out = { jobs: [] as Job[], notices: [] as Array<number | null>, scope }
    const result = await deps.store.transact((view) => {
      out.jobs.length = 0
      out.notices.length = 0
      const journal = [...view.journal]
      const routines = view.own.map((r) => evaluateRoutine(r, journal, gates, out, { audit, noticed }))
      const changed =
        view.recovered > 0 || journal.length !== view.journal.length || routines.some((r, i) => r !== view.own[i])
      if (!changed) return { commit: false as const, value: 0 }
      return { commit: true as const, routines, journal: prune(journal, gates.now), value: view.recovered }
    }, scope)
    if (!result.ok) {
      out.jobs.length = 0
      return
    }
    if (result.value > 0) audit('recovered', { count: result.value })
    for (const resetAt of out.notices) {
      audit('quota_notice')
      publish({ kind: 'allowance', resetAt })
    }
    emit({ type: 'changed' })
    for (const job of out.jobs) launch(job)
  }

  const tick = async (): Promise<void> => {
    if (ticking) {
      again = true
      return
    }
    ticking = true
    try {
      do {
        again = false
        try {
          await runTick()
        } catch {
          audit('refused', { reason: 'tick_failed' })
        }
      } while (again)
    } finally {
      ticking = false
    }
  }

  // ------------------------------------------------------------------------------------------------------- runs

  type Exec = { outcome: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; errorClass?: ErrorClass }

  const execute = async (job: Job, signal: AbortSignal): Promise<Exec> => {
    try {
      if (job.purpose === 'reminder') return { outcome: 'succeeded' }
      if (job.purpose === 'read_only_suggestion') {
        if (!deps.research) return { outcome: 'failed', errorClass: 'internal' }
        const res = await deps.research({ title: job.title, tools: job.tools }, signal)
        if (signal.aborted) return { outcome: 'cancelled' }
        if (res.ok) return { outcome: 'succeeded' }
        return res.uncertain ? { outcome: 'uncertain' } : { outcome: 'failed', errorClass: res.errorClass }
      }
      if (!deps.proposeAction || !job.action) return { outcome: 'failed', errorClass: 'internal' }
      const shown = await deps.proposeAction(job.action, { routineId: job.routineId })
      return shown.shown ? { outcome: 'succeeded' } : { outcome: 'failed', errorClass: 'internal' }
    } catch {
      return signal.aborted ? { outcome: 'cancelled' } : { outcome: 'failed', errorClass: 'internal' }
    }
  }

  const settle = async (job: Job, exec: Exec, startedGeneration: number): Promise<void> => {
    if (startedGeneration !== generation || !sameScope(job.scope, deps.scope())) {
      audit('withheld', { reason: 'owner_changed' })
      return
    }
    const now = deps.now()
    const result = await deps.store.transact((view) => {
      const entry = view.journal.find((e) => e.key === job.journalKey)
      const routine = view.own.find((r) => r.routineId === job.routineId)
      const journal = view.journal.map((e) =>
        e.key === job.journalKey ? { ...e, status: exec.outcome, settledAt: now } : e
      )
      if (!routine || !entry) return { commit: true as const, routines: [...view.own], journal, value: null }
      const settled = settleRun(routine, {
        outcome: exec.outcome,
        ...(exec.errorClass ? { errorClass: exec.errorClass } : {}),
        at: now,
        occurrenceKey: job.occurrenceKey
      })
      // Recomputed here, never stored: the result may be shown only if nothing changed under it.
      const publishable =
        exec.outcome === 'succeeded' &&
        startedGeneration === generation &&
        sameScope(job.scope, deps.scope()) &&
        settled.pauseReasons.length === 0 &&
        now < job.expiresAt
      return {
        commit: true as const,
        routines: view.own.map((r) => (r.routineId === job.routineId ? settled : r)),
        journal,
        value: { publishable }
      }
    }, job.scope)
    if (!result.ok) {
      audit('withheld', { reason: result.reason })
      return
    }
    audit('settled', { reason: exec.outcome })
    emit({ type: 'result', routineId: job.routineId, outcome: exec.outcome, at: now })
    emit({ type: 'changed' })
    if (result.value?.publishable && job.purpose !== 'scheduled_task') {
      const action = publish({ kind: 'routine', purpose: job.purpose, title: job.title })
      if (action === 'drop') {
        await deps.store.transact(
          (view) => ({
            commit: true as const,
            routines: view.own.map((r) =>
              r.routineId === job.routineId
                ? pushHistory(r, { outcome: 'suppressed', at: deps.now(), occurrenceKey: job.occurrenceKey })
                : r
            ),
            journal: [...view.journal],
            value: 0
          }),
          job.scope
        )
        emit({ type: 'changed' })
      }
    }
  }

  function launch(job: Job): void {
    const startedGeneration = generation
    const work = (async () => {
      let res: SchedulerResult<Exec>
      try {
        res = await deps.scheduler.submit<Exec>({
          key: job.journalKey,
          owner: job.scope.ownerKey,
          effect: 'read-only',
          resources: [`routine:${job.routineId}`],
          run: (signal) => execute(job, signal)
        })
      } catch {
        res = { status: 'rejected', reason: 'invalid_job' }
      }
      // A queue timeout, a full queue or a Stop is not the routine's fault: it is cancelled, never a failure.
      await settle(job, res.status === 'ran' ? res.value : { outcome: 'cancelled' }, startedGeneration)
    })().catch(() => audit('refused', { reason: 'settle_failed' }))
    inflight.add(work)
    void work.finally(() => inflight.delete(work))
  }

  const onOwnerChange = (): void => {
    generation += 1
    stopped = true
    proposals.clear()
    noticed.clear()
    try {
      deps.scheduler.stop()
    } catch {
      // stopping an idle scheduler cannot fail in a way that matters
    }
    deps.store.rearm()
  }

  const idle = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }

  return { compile, consent, list, pause, resume, runNow, remove, tick, onOwnerChange, idle }
}
