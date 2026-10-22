import { randomUUID } from 'node:crypto'
import { canonical, check, copyData, freezeData } from './contract-data'

/**
 * Finite occurrence ownership and read-only research tickets for routines.
 * No clock service, database, provider, OAuth, tool execution or native adapter lives here.
 * The embedding host authenticates every caller and supplies verified schedules.
 *
 * Ported from the 2.12 reference `routine-coordinator.mjs`. One deliberate change: the reference
 * trusted the `publishable` flag stored in a checkpoint. This port recomputes it from current state
 * on restore, so a stale `succeeded` run cannot stay publishable across a restart.
 *
 * In-process only. Production needs a transactional occurrence table with a unique constraint and
 * an execution lease; the in-memory map does not stop duplicates across processes or devices.
 */

const readonlyTools: ReadonlySet<string> = new Set(['connector.read', 'web.search'])
const finalOutcomes = ['succeeded', 'failed', 'cancelled', 'uncertain'] as const
const outcomes: ReadonlySet<string> = new Set(finalOutcomes)
const RULE_STATES = ['enabled', 'paused_user', 'paused_failure', 'paused_review'] as const
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

export type RoutineOutcome = (typeof finalOutcomes)[number]
export type RoutineRuleState = (typeof RULE_STATES)[number]
export type RoutineRunStatus = 'running' | RoutineOutcome
export type RoutinePurpose = 'read_only_suggestion' | 'scheduled_task'

export interface RoutineScope {
  tenantId: string
  userId: string
  sessionId: string
}

/** What the coordinator needs from the session context (the kernel SessionContext satisfies this). */
export interface RoutineContext {
  readonly scope: RoutineScope
  readonly active: boolean
  snapshot(outputKind: 'followup'): RoutineSnapshot
  assertCurrent(snapshot: RoutineSnapshot): void
  isCurrent(snapshot: RoutineSnapshot): boolean
  hasPermissions(required: string[]): boolean
}

export interface RoutineSnapshot {
  readonly scope: RoutineScope
}

export interface RoutineConnection {
  connectionId: string
  accountId: string
  resourceId: string
}

export interface RoutineConfiguration {
  id: string
  assistantId: string
  revision: number
  purpose: RoutinePurpose
  timeZone: string
  enabled: boolean
  tools: string[]
  connections: RoutineConnection[]
}

export interface RoutineRule {
  config: RoutineConfiguration
  state: RoutineRuleState
  failures: number
}

export interface RoutineRun {
  key: string
  routineId: string
  occurrenceKey: string
  runId: string
  status: RoutineRunStatus
  dueAtMs: number
  expiresAtMs: number
  startedAtMs: number
  finishedAtMs?: number
  reconciledAtMs?: number
  publishable?: boolean
}

export interface RoutineTicket {
  readonly key: string
  readonly routineId: string
  readonly runId: string
  readonly scope: RoutineScope
  readonly snapshot: RoutineSnapshot
  readonly purpose: RoutinePurpose
  readonly tools: readonly string[]
  readonly connections: readonly RoutineConnection[]
  readonly authorizesExternalEffects: false
}

export type ReserveStatus =
  | 'already_recorded'
  | RoutineRuleState
  | 'not_due'
  | 'expired'
  | 'app_closed'
  | 'policy_blocked'
  | 'quota_blocked'
  | 'overlap_blocked'

export type ReserveResult = { status: 'reserved'; ticket: RoutineTicket } | { status: ReserveStatus; key: string }

export interface ReserveInput {
  routineId: string
  occurrenceKey: string
  dueAtMs: number
  expiresAtMs: number
  appOpen: boolean
  policyAllowed: boolean
  quotaAvailable: boolean
}

export interface RoutineCheckpoint {
  schema: 1
  owner: string
  rules: RoutineRule[]
  runs: RoutineRun[]
}

export interface RoutineCoordinatorOptions {
  context: RoutineContext
  clock?: () => number
  maxRecords?: number
  checkpoint?: unknown
}

const isId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value)
const isInstant = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const ownerKey = (scope: RoutineScope): string => canonical({ tenantId: scope.tenantId, userId: scope.userId })

interface IssuedTicket {
  key: string
  snapshot: RoutineSnapshot
}

export class RoutineCoordinator {
  private readonly context: RoutineContext
  private readonly clock: () => number
  private readonly maxRecords: number
  private readonly owner: string
  private readonly rules = new Map<string, RoutineRule>()
  private readonly runs = new Map<string, RoutineRun>()
  private readonly tickets = new WeakMap<object, IssuedTicket>()
  private closed = false

  constructor(options: RoutineCoordinatorOptions) {
    const { context, clock = () => Date.now(), maxRecords = 512, checkpoint = null } = options
    check(context && typeof context.snapshot === 'function', 'ROUTINE_CONTEXT')
    check(typeof clock === 'function', 'ROUTINE_CLOCK')
    check(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 1024, 'ROUTINE_RECORD_LIMIT')
    this.context = context
    this.clock = clock
    this.maxRecords = maxRecords
    this.owner = ownerKey(context.scope)
    if (checkpoint !== null) this.restore(checkpoint)
  }

  private nowMs(): number {
    const value = this.clock()
    check(isInstant(value), 'ROUTINE_CLOCK_VALUE')
    return value
  }

  private assertActive(): void {
    check(!this.closed && this.context.active, 'ROUTINE_STOPPED')
  }

  register(configuration: unknown): RoutineRule {
    this.assertActive()
    const c = copyData(configuration) as RoutineConfiguration
    check(isId(c.id) && isId(c.assistantId), 'ROUTINE_ID')
    check(!this.rules.has(c.id), 'ROUTINE_EXISTS')
    check(this.rules.size < this.maxRecords, 'ROUTINE_RULE_LIMIT')
    check(Number.isSafeInteger(c.revision) && c.revision >= 1, 'ROUTINE_REVISION')
    check(c.purpose === 'read_only_suggestion' || c.purpose === 'scheduled_task', 'ROUTINE_PURPOSE')
    check(typeof c.timeZone === 'string', 'ROUTINE_TIMEZONE')
    try {
      new Intl.DateTimeFormat('en', { timeZone: c.timeZone }).format(0)
    } catch {
      check(false, 'ROUTINE_TIMEZONE')
    }
    check(Array.isArray(c.connections) && c.connections.length <= 32, 'ROUTINE_CONNECTIONS')
    for (const connection of c.connections) {
      check(
        connection && Object.keys(connection).sort().join(',') === 'accountId,connectionId,resourceId',
        'ROUTINE_CONNECTION_SHAPE'
      )
      check(Object.values(connection).every(isId), 'ROUTINE_CONNECTION_ID')
    }
    check(Array.isArray(c.tools) && c.tools.length <= 32 && c.tools.every(isId), 'ROUTINE_TOOLS')
    if (c.purpose === 'read_only_suggestion') {
      check(
        c.tools.every((tool) => readonlyTools.has(tool)),
        'SUGGESTION_WRITE_TOOL'
      )
    }
    check(typeof c.enabled === 'boolean', 'ROUTINE_ENABLED')
    this.rules.set(c.id, { config: freezeData(c), state: c.enabled ? 'enabled' : 'paused_user', failures: 0 })
    return this.rule(c.id)
  }

  rule(routineId: string): RoutineRule {
    const rule = this.rules.get(routineId)
    check(rule, 'ROUTINE_UNKNOWN')
    return freezeData(copyData(rule))
  }

  /** The trusted scheduling adapter resolves civil time and DST and supplies a stable occurrence key. */
  reserve(input: ReserveInput): ReserveResult {
    this.assertActive()
    const rule = this.rules.get(input.routineId)
    check(rule, 'ROUTINE_UNKNOWN')
    check(isId(input.occurrenceKey), 'OCCURRENCE_KEY')
    check(
      isInstant(input.dueAtMs) && isInstant(input.expiresAtMs) && input.expiresAtMs > input.dueAtMs,
      'OCCURRENCE_TIME'
    )
    const now = this.nowMs()
    const key = canonical([input.routineId, rule.config.revision, input.occurrenceKey])
    if (this.runs.has(key)) return freezeData({ status: 'already_recorded' as const, key })
    if (rule.state !== 'enabled') return freezeData({ status: rule.state, key })
    if (now < input.dueAtMs) return freezeData({ status: 'not_due' as const, key })
    if (now >= input.expiresAtMs) return freezeData({ status: 'expired' as const, key })
    if (input.appOpen !== true) return freezeData({ status: 'app_closed' as const, key })
    if (input.policyAllowed !== true) return freezeData({ status: 'policy_blocked' as const, key })
    if (input.quotaAvailable !== true) return freezeData({ status: 'quota_blocked' as const, key })
    for (const run of this.runs.values()) {
      if (run.routineId === input.routineId && run.status === 'running') {
        return freezeData({ status: 'overlap_blocked' as const, key })
      }
    }
    check(this.runs.size < this.maxRecords, 'ROUTINE_JOURNAL_FULL')
    const snapshot = this.context.snapshot('followup')
    const run: RoutineRun = {
      key,
      routineId: input.routineId,
      occurrenceKey: input.occurrenceKey,
      runId: randomUUID(),
      status: 'running',
      dueAtMs: input.dueAtMs,
      expiresAtMs: input.expiresAtMs,
      startedAtMs: now
    }
    this.runs.set(key, run)
    const ticket: RoutineTicket = freezeData({
      key,
      routineId: input.routineId,
      runId: run.runId,
      scope: snapshot.scope,
      snapshot,
      purpose: rule.config.purpose,
      tools: rule.config.tools,
      connections: rule.config.connections,
      authorizesExternalEffects: false as const
    })
    this.tickets.set(ticket, { key, snapshot })
    return { status: 'reserved', ticket }
  }

  private ticketRun(ticket: RoutineTicket, requireCurrent = true): RoutineRun {
    const owned = ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined
    check(owned, 'ROUTINE_TICKET_NOT_ISSUED')
    const run = this.runs.get(owned.key)
    check(run?.status === 'running', 'ROUTINE_ALREADY_SETTLED')
    if (requireCurrent) {
      this.assertActive()
      this.context.assertCurrent(owned.snapshot)
      check(this.nowMs() < run.expiresAtMs, 'ROUTINE_TICKET_EXPIRED')
      check(this.rules.get(run.routineId)?.state === 'enabled', 'ROUTINE_PAUSED')
    }
    return run
  }

  /** Metadata-level check only. The real broker must enforce this independently on every call. */
  assertReadCall(ticket: RoutineTicket, call: { tool: string; connection?: RoutineConnection | null }): true {
    this.ticketRun(ticket)
    check(readonlyTools.has(call.tool) && ticket.tools.includes(call.tool), 'ROUTINE_READ_TOOL_DENIED')
    check(this.context.hasPermissions([call.tool]), 'ROUTINE_READ_PERMISSION_DENIED')
    if (call.tool === 'connector.read') {
      const connection = call.connection ?? null
      check(
        connection && ticket.connections.some((allowed) => canonical(allowed) === canonical(connection)),
        'ROUTINE_RESOURCE_DENIED'
      )
    }
    return true
  }

  /** A trusted executor reports its observed outcome. This method does not verify external effects. */
  settle(ticket: RoutineTicket, outcome: string): RoutineRun {
    check(outcomes.has(outcome), 'ROUTINE_OUTCOME')
    const run = this.ticketRun(ticket, false)
    const rule = this.rules.get(run.routineId)
    check(rule, 'ROUTINE_UNKNOWN')
    const now = this.nowMs()
    // Only a successful current result can become a suggestion or completed-result card.
    // Failure, cancellation and review notices use the host's separate status channel.
    const publishable =
      outcome === 'succeeded' &&
      !this.closed &&
      rule.state === 'enabled' &&
      this.context.isCurrent(ticket.snapshot) &&
      now < run.expiresAtMs
    run.status = outcome as RoutineOutcome
    run.finishedAtMs = now
    run.publishable = publishable
    if (outcome === 'failed') {
      rule.failures += 1
      if (rule.failures >= 3) rule.state = 'paused_failure'
    } else if (outcome === 'succeeded') rule.failures = 0
    else if (outcome === 'uncertain') rule.state = 'paused_review'
    return freezeData(copyData(run))
  }

  pause(routineId: string): RoutineRule {
    const rule = this.rules.get(routineId)
    check(rule, 'ROUTINE_UNKNOWN')
    rule.state = 'paused_user'
    return this.rule(routineId)
  }

  /** Explicit host-authorized resume. It does not replay an earlier occurrence. */
  resume(routineId: string): RoutineRule {
    this.assertActive()
    const rule = this.rules.get(routineId)
    check(rule, 'ROUTINE_UNKNOWN')
    for (const run of this.runs.values()) {
      check(
        !(run.routineId === routineId && (run.status === 'running' || run.status === 'uncertain')),
        'ROUTINE_RECONCILIATION_REQUIRED'
      )
    }
    rule.state = 'enabled'
    rule.failures = 0
    return this.rule(routineId)
  }

  /** Call only after the host obtains independent evidence for an uncertain outcome. */
  reconcile(key: string, outcome: string): RoutineRun {
    this.assertActive()
    check(['succeeded', 'failed', 'cancelled'].includes(outcome), 'ROUTINE_RECONCILIATION_OUTCOME')
    const run = this.runs.get(key)
    check(run?.status === 'uncertain', 'ROUTINE_NOT_UNCERTAIN')
    run.status = outcome as RoutineOutcome
    run.reconciledAtMs = this.nowMs()
    run.publishable = false
    return freezeData(copyData(run))
  }

  close(): void {
    this.closed = true
  }

  /** Save atomically in owner-protected storage. This JSON itself is not an authorization token. */
  checkpoint(): RoutineCheckpoint {
    return freezeData(
      copyData({
        schema: 1 as const,
        owner: this.owner,
        rules: [...this.rules.values()],
        runs: [...this.runs.values()]
      })
    )
  }

  /**
   * Restore from an owner-scoped checkpoint. A stored `publishable: true` is never trusted: eligibility
   * is recomputed from the restored rule state, the clock and this coordinator's lifecycle, so a stale
   * `succeeded` run cannot stay publishable. Restored runs have no live context snapshot to prove the
   * settle-time context was current, so a stored `false` is honored and never upgraded; a run is eligible
   * only when it is a `succeeded`, never-reconciled run on a currently enabled rule that has not expired.
   */
  private restore(checkpoint: unknown): void {
    const c = copyData(checkpoint) as RoutineCheckpoint
    check(c.schema === 1 && c.owner === this.owner, 'ROUTINE_CHECKPOINT_OWNER')
    check(
      Array.isArray(c.rules) && Array.isArray(c.runs) && c.runs.length <= this.maxRecords,
      'ROUTINE_CHECKPOINT_SHAPE'
    )
    for (const saved of c.rules) {
      this.register(saved.config)
      check((RULE_STATES as readonly string[]).includes(saved.state), 'ROUTINE_CHECKPOINT_STATE')
      check(Number.isSafeInteger(saved.failures) && saved.failures >= 0, 'ROUTINE_CHECKPOINT_FAILURES')
      const rule = this.rules.get(saved.config.id)
      check(rule, 'ROUTINE_CHECKPOINT_STATE')
      rule.state = saved.state
      rule.failures = saved.failures
    }
    const now = this.nowMs()
    for (const saved of c.runs) {
      const rule = this.rules.get(saved.routineId)
      check(
        rule &&
          isId(saved.runId) &&
          isId(saved.occurrenceKey) &&
          saved.key === canonical([saved.routineId, rule.config.revision, saved.occurrenceKey]),
        'ROUTINE_CHECKPOINT_RUN'
      )
      check(
        !this.runs.has(saved.key) && (saved.status === 'running' || outcomes.has(saved.status)),
        'ROUTINE_CHECKPOINT_DUPLICATE'
      )
      check(
        isInstant(saved.dueAtMs) &&
          isInstant(saved.expiresAtMs) &&
          saved.expiresAtMs > saved.dueAtMs &&
          isInstant(saved.startedAtMs),
        'ROUTINE_CHECKPOINT_TIME'
      )
      check(saved.finishedAtMs === undefined || isInstant(saved.finishedAtMs), 'ROUTINE_CHECKPOINT_TIME')
      check(saved.reconciledAtMs === undefined || isInstant(saved.reconciledAtMs), 'ROUTINE_CHECKPOINT_TIME')
      // Copy only known fields; whatever else the file carried is dropped. `publishable` is recomputed below.
      const run: RoutineRun = {
        key: saved.key,
        routineId: saved.routineId,
        occurrenceKey: saved.occurrenceKey,
        runId: saved.runId,
        status: saved.status,
        dueAtMs: saved.dueAtMs,
        expiresAtMs: saved.expiresAtMs,
        startedAtMs: saved.startedAtMs
      }
      if (saved.finishedAtMs !== undefined) run.finishedAtMs = saved.finishedAtMs
      if (saved.reconciledAtMs !== undefined) run.reconciledAtMs = saved.reconciledAtMs
      if (run.status === 'running') {
        run.status = 'uncertain'
        rule.state = 'paused_review'
      }
      if (run.status === 'uncertain') rule.state = 'paused_review'
      run.publishable =
        saved.publishable === true &&
        run.status === 'succeeded' &&
        run.reconciledAtMs === undefined &&
        !this.closed &&
        rule.state === 'enabled' &&
        now < run.expiresAtMs
      this.runs.set(run.key, run)
    }
  }
}
