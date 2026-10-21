import { createHash, randomBytes } from 'node:crypto'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { DESKTOP_ADAPTER_IDS } from '@shared/desktop-actions'
import type { CommandExecutionContext, CommandExecutor } from '../command-control'
import type { EffectOutcome, TaskOwner, TaskPolicy, TaskRecord, TaskRuntimeState, TaskStatus } from './task-contract'
import { TASK_STORE_DECRYPT_FAILED, type TaskStateStore } from './encrypted-task-file-store'
import {
  decodeTaskRuntimeState,
  encodeTaskRuntimeState,
  type TaskStateCodecLimits,
  type TaskStateLoadResult
} from './task-persistence'
import {
  createTaskProgressState,
  forgetTaskProgress,
  readTaskProgress,
  recordTaskProgress,
  type TaskProgressLimits,
  type TaskProgressRecord,
  type TaskProgressState
} from './task-progress'
import {
  authorizeDispatch,
  cancelTask,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  recordEffectOutcome
} from './task-state'

/** One confirmed desktop command is one task. The capability is the adapter id, so a grant cannot cross actions. */
export const DESKTOP_ACTION_TASK_TYPE = 'desktop-action'
const ACTIONS_RESOURCE = 'actions'
const DAY_MS = 24 * 60 * 60 * 1000

/** Owner-chosen limits for the desktop command path. The task modules deliberately define none of their own. */
export const DESKTOP_ACTION_TASK_POLICY: TaskPolicy = {
  allowedTaskTypes: [DESKTOP_ACTION_TASK_TYPE],
  allowedCapabilities: DESKTOP_ADAPTER_IDS,
  resourceBudgets: { [ACTIONS_RESOURCE]: 1 },
  maxRetentionMs: DAY_MS,
  // A confirmed proposal lives 10 s, so a grant that outlives that is a bug, not a slow user.
  maxGrantTtlMs: 10_000
}
const GRANT_TTL_MS = 10_000

export const DESKTOP_ACTION_TASK_CODEC_LIMITS: TaskStateCodecLimits = {
  maxBytes: 1_048_576,
  maxTasks: 256,
  maxAttempts: 256,
  maxConsumedGrantIds: 1_024,
  maxCapabilitiesPerScope: 4,
  maxResourcesPerScope: 4
}

const PROGRESS_LIMITS: TaskProgressLimits = {
  maxTrackedTasks: 16,
  maxLabelBytes: 64,
  maxDetailBytes: 128,
  maxWorkUnits: 1
}

/** Contains the action id and a denial or recovery reason only. Never request arguments (note titles, queries). */
export type DesktopActionTaskAuditEvent = 'task.recovered' | 'task.effect_uncertain' | 'task.dispatch_denied'

export interface DesktopActionTaskBridgeDeps {
  execute: (request: DesktopActionRequest) => Promise<DesktopActionResult>
  store: TaskStateStore
  authSessionGeneration: () => number
  audit?: (event: DesktopActionTaskAuditEvent, metadata: Record<string, string>) => void
  log?: { warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void }
  now?: () => number
  newId?: () => string
}

export interface DesktopActionTaskRecovery {
  /** False while the archive cannot be read: dispatch stays closed rather than forgetting uncertain effects. */
  available: boolean
  /** Tasks whose effect is unknown. They are reported, never replayed. */
  uncertain: number
}

export interface DesktopActionTaskSnapshot {
  taskId: string
  actionId: string
  status: TaskStatus
  effectOutcome?: EffectOutcome
  progress?: TaskProgressRecord
}

type Begun = { ok: true; taskId: string; attemptId: string; owner: TaskOwner } | { ok: false; reason: string }

/** Stable text for hashing: key order must not change the identity of the same request. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function desktopActionArgumentsDigest(request: DesktopActionRequest): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex')
}

function failedResult(id: DesktopActionRequest['id'], detail: string): DesktopActionResult {
  return { id, ok: false, outcome: 'failed', detail }
}

function unknownResult(id: DesktopActionRequest['id'], detail: string): DesktopActionResult {
  return { id, ok: false, outcome: 'unknown', detail }
}

/** Only a verified, matching result proves the effect. Anything that may have launched something stays uncertain. */
function classifyEffect(request: DesktopActionRequest, result: DesktopActionResult): EffectOutcome {
  if (result.id !== request.id) return 'uncertain'
  if (result.outcome === 'verified') return result.ok ? 'applied' : 'uncertain'
  if (result.outcome === 'failed' || result.outcome === 'cancelled' || result.outcome === 'unsupported') {
    return 'not-applied'
  }
  return 'uncertain'
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

/** Drop expired history and, when near the archive cap, the oldest finished tasks. Uncertain work is kept until it expires. */
function pruneState(state: TaskRuntimeState, now: number, limits: TaskStateCodecLimits): TaskRuntimeState {
  const tasks = new Map<string, TaskRecord>()
  for (const task of state.tasks.values()) {
    if (task.status === 'dispatching' || task.expiresAt > now) tasks.set(task.taskId, task)
  }
  if (tasks.size >= limits.maxTasks) {
    const finished = [...tasks.values()]
      .filter((task) => isTerminal(task.status))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const task of finished) {
      if (tasks.size < limits.maxTasks) break
      tasks.delete(task.taskId)
    }
  }
  const attempts = new Map([...state.attempts].filter(([, attempt]) => tasks.has(attempt.taskId)))
  const retainedGrantIds = new Set([...attempts.values()].map((attempt) => attempt.grantId))
  // After a restart no live grant exists, so a tombstone only matters while its attempt is still recorded.
  const consumedGrantIds =
    state.consumedGrantIds.size >= limits.maxConsumedGrantIds - 8 ? retainedGrantIds : state.consumedGrantIds
  return { ...state, tasks, attempts, consumedGrantIds }
}

function archiveHasRoom(state: TaskRuntimeState, limits: TaskStateCodecLimits): boolean {
  return state.tasks.size < limits.maxTasks && state.attempts.size < limits.maxAttempts
}

/**
 * Runs every confirmed desktop command as a task: create, grant, authorize, dispatch once, record the effect.
 * A dispatch whose outcome cannot be proven is `uncertain`, is persisted as such, and is never replayed.
 */
export class DesktopActionTaskBridge {
  private state: TaskRuntimeState = createTaskRuntimeState()
  private progress: TaskProgressState = createTaskProgressState()
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: DesktopActionTaskBridgeDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => randomBytes(16).toString('hex'))
  }

  /** Bound executor handed to CommandControl. */
  readonly execute: CommandExecutor = (request, context) => this.run(request, context)

  /** Bound recovery hook handed to the boot sequence. Idempotent. */
  readonly recover = (): Promise<DesktopActionTaskRecovery> => this.recoverState()

  snapshot(): DesktopActionTaskSnapshot[] {
    return [...this.state.tasks.values()].map((task) => ({
      taskId: task.taskId,
      actionId: task.scope.capabilities[0] ?? '',
      status: task.status,
      ...(task.effectOutcome ? { effectOutcome: task.effectOutcome } : {}),
      ...optionalProgress(readTaskProgress(this.progress, task, this.state.ownerRebindRequired, task.owner))
    }))
  }

  private async run(request: DesktopActionRequest, context: CommandExecutionContext): Promise<DesktopActionResult> {
    let begun: Begun
    try {
      begun = await this.begin(request, context)
    } catch (error) {
      // Nothing was dispatched: the adapter has not been called, so this is a clean failure.
      this.deps.log?.error('[desktop-action-task] could not start the task:', error)
      return failedResult(request.id, 'task_bridge_error')
    }
    if (!begun.ok) {
      this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: begun.reason })
      return failedResult(request.id, `task_denied:${begun.reason}`)
    }

    let result: DesktopActionResult | undefined
    let outcome: EffectOutcome
    try {
      result = await this.deps.execute(request)
      outcome = classifyEffect(request, result)
    } catch {
      // Thrown after dispatch began: the effect may have happened. Observe it, never retry it.
      outcome = 'uncertain'
    }
    await this.settle(begun, request, outcome)

    if (!result) return unknownResult(request.id, 'dispatch_threw')
    if (outcome === 'uncertain' && result.outcome !== 'unknown') return unknownResult(request.id, 'outcome_unverified')
    return result
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async persist(): Promise<void> {
    await this.deps.store.write(encodeTaskRuntimeState(this.state, DESKTOP_ACTION_TASK_CODEC_LIMITS))
  }

  private async persistQuietly(): Promise<void> {
    try {
      await this.persist()
    } catch (error) {
      this.deps.log?.error('[desktop-action-task] could not persist task state:', error)
    }
  }

  private async recoverState(): Promise<DesktopActionTaskRecovery> {
    if (this.loaded) return this.recovery()
    return this.locked(async () => {
      if (this.loaded) return this.recovery()
      const limits = DESKTOP_ACTION_TASK_CODEC_LIMITS
      let result: TaskStateLoadResult
      try {
        const read = await this.deps.store.read()
        result =
          read.kind === 'unavailable' && read.reason === TASK_STORE_DECRYPT_FAILED
            ? { kind: 'corrupt', reason: 'invalid-shape' }
            : decodeTaskRuntimeState(read, limits)
      } catch (error) {
        this.deps.log?.error('[desktop-action-task] task archive read failed:', error)
        return { available: false, uncertain: 0 }
      }

      if (result.kind === 'unavailable') {
        this.deps.log?.warn(`[desktop-action-task] task archive unavailable (${result.reason}); dispatch stays closed`)
        return { available: false, uncertain: 0 }
      }
      if (result.kind === 'corrupt') {
        try {
          await this.deps.store.quarantine()
        } catch (error) {
          this.deps.log?.error('[desktop-action-task] could not set a corrupt task archive aside:', error)
          return { available: false, uncertain: 0 }
        }
        this.deps.log?.warn(
          `[desktop-action-task] task archive was corrupt (${result.reason}); set aside, starting fresh`
        )
        this.deps.audit?.('task.recovered', { status: 'quarantined', reason: result.reason })
        this.state = createTaskRuntimeState()
      } else if (result.kind === 'loaded') {
        let next = result.state
        // Nothing but an uncertain or finished record may survive a restart. A stray ready task is cancelled.
        for (const task of next.tasks.values()) {
          if (task.status === 'ready' || task.status === 'paused') {
            const cancelled = cancelTask(next, task.taskId)
            if (cancelled.ok) next = cancelled.state
          }
        }
        this.state = pruneState(next, this.now(), limits)
        for (const task of this.state.tasks.values()) {
          if (task.effectOutcome !== 'uncertain') continue
          this.deps.audit?.('task.recovered', {
            taskId: task.taskId,
            actionId: task.scope.capabilities[0] ?? '',
            status: 'uncertain'
          })
        }
        await this.persistQuietly()
      }
      this.loaded = true
      const summary = this.recovery()
      if (summary.uncertain > 0) {
        this.deps.log?.warn(
          `[desktop-action-task] ${summary.uncertain} desktop action(s) have an unverified outcome; they will not be replayed`
        )
      }
      return summary
    })
  }

  private recovery(): DesktopActionTaskRecovery {
    return {
      available: true,
      uncertain: [...this.state.tasks.values()].filter((task) => task.effectOutcome === 'uncertain').length
    }
  }

  private ownerFor(context: CommandExecutionContext): TaskOwner {
    // assertMainWindow admits only the main frame before confirm is called, so the top frame is the only owner frame.
    return {
      webContentsId: context.owner.webContentsId,
      frameId: 'main',
      isTopFrame: true,
      authSessionGeneration: this.deps.authSessionGeneration(),
      contextRevision: context.owner.revision
    }
  }

  private async begin(request: DesktopActionRequest, context: CommandExecutionContext): Promise<Begun> {
    const recovery = await this.recoverState()
    if (!recovery.available) return { ok: false, reason: 'task_state_unavailable' }
    return this.locked(async (): Promise<Begun> => {
      const taskId = `${DESKTOP_ACTION_TASK_TYPE}:${context.proposalId}`
      const attemptId = this.newId()
      const owner = this.ownerFor(context)
      const argumentsDigest = desktopActionArgumentsDigest(request)
      const scope = { capabilities: [request.id], resources: { [ACTIONS_RESOURCE]: 1 } }
      const grantScope = { capability: request.id, resources: { [ACTIONS_RESOURCE]: 1 } }
      const issuedAt = this.now()

      this.state = pruneState(this.state, issuedAt, DESKTOP_ACTION_TASK_CODEC_LIMITS)
      if (!archiveHasRoom(this.state, DESKTOP_ACTION_TASK_CODEC_LIMITS)) return { ok: false, reason: 'task_state_full' }
      // The recovered owners belong to a previous process. Only a confirmation that already passed the main-process
      // policy gate (authenticated, entitled, focused top-frame owner) can re-establish ownership; recovered
      // uncertain tasks stay uncertain either way.
      if (this.state.ownerRebindRequired) this.state = { ...this.state, ownerRebindRequired: false }

      const created = createTask(
        this.state,
        {
          taskId,
          revision: 1,
          taskType: DESKTOP_ACTION_TASK_TYPE,
          owner,
          argumentsDigest,
          scope,
          createdAt: issuedAt,
          retentionMs: DESKTOP_ACTION_TASK_POLICY.maxRetentionMs
        },
        DESKTOP_ACTION_TASK_POLICY
      )
      if (!created.ok) return { ok: false, reason: created.reason }
      this.state = created.state

      const grantId = this.newId()
      const granted = issueDispatchGrant(this.state, {
        taskId,
        grantId,
        scope: grantScope,
        now: issuedAt,
        ttlMs: GRANT_TTL_MS,
        policy: DESKTOP_ACTION_TASK_POLICY
      })
      if (!granted.ok) {
        await this.abandon(taskId)
        return { ok: false, reason: granted.reason }
      }
      this.state = granted.state

      // Read the clock and the auth generation again: the grant must still be valid for this owner at dispatch.
      const authorized = authorizeDispatch(this.state, {
        grantId,
        attemptId,
        taskId,
        taskRevision: 1,
        owner: this.ownerFor(context),
        argumentsDigest,
        scope: grantScope,
        now: this.now()
      })
      this.state = authorized.state
      if (!authorized.decision.allowed) {
        await this.abandon(taskId)
        return { ok: false, reason: authorized.decision.reason }
      }

      // The dispatching state must be durable before the adapter runs, so a crash is recovered as uncertain.
      try {
        await this.persist()
      } catch (error) {
        this.deps.log?.error('[desktop-action-task] could not persist before dispatch; not dispatching:', error)
        this.recordNotApplied(taskId, attemptId)
        await this.persistQuietly()
        return { ok: false, reason: 'task_state_persist_failed' }
      }
      if (this.deps.authSessionGeneration() !== owner.authSessionGeneration) {
        this.recordNotApplied(taskId, attemptId)
        await this.persistQuietly()
        return { ok: false, reason: 'wrong_owner' }
      }

      this.recordProgress(taskId, owner, 1, 0, 'dispatching')
      return { ok: true, taskId, attemptId, owner }
    })
  }

  /** The adapter was never called: close the task so it cannot be authorized again. */
  private async abandon(taskId: string): Promise<void> {
    const cancelled = cancelTask(this.state, taskId)
    if (cancelled.ok) this.state = cancelled.state
    await this.persistQuietly()
  }

  private recordNotApplied(taskId: string, attemptId: string): void {
    const settled = recordEffectOutcome(this.state, taskId, attemptId, 'not-applied')
    if (!settled.ok) return
    const cancelled = cancelTask(settled.state, taskId)
    this.state = cancelled.ok ? cancelled.state : settled.state
  }

  private recordProgress(
    taskId: string,
    owner: TaskOwner,
    sequence: number,
    completedUnits: number,
    label: string
  ): void {
    const task = this.state.tasks.get(taskId)
    const recorded = recordTaskProgress(
      this.progress,
      task,
      this.state.ownerRebindRequired,
      { taskId, taskRevision: task?.revision ?? 0, owner, sequence, completedUnits, totalUnits: 1, label },
      PROGRESS_LIMITS
    )
    if (recorded.accepted) this.progress = recorded.state
  }

  private settle(
    begun: Extract<Begun, { ok: true }>,
    request: DesktopActionRequest,
    outcome: EffectOutcome
  ): Promise<void> {
    return this.locked(async () => {
      try {
        if (outcome === 'applied') this.recordProgress(begun.taskId, begun.owner, 2, 1, 'done')
        const settled = recordEffectOutcome(this.state, begun.taskId, begun.attemptId, outcome)
        if (!settled.ok) {
          this.deps.log?.error(`[desktop-action-task] could not record the effect outcome (${settled.reason})`)
          return
        }
        this.state = settled.state
        if (outcome === 'not-applied') {
          const cancelled = cancelTask(this.state, begun.taskId)
          if (cancelled.ok) this.state = cancelled.state
        }
        this.progress = forgetTaskProgress(this.progress, begun.taskId)
        if (outcome === 'uncertain') {
          this.deps.audit?.('task.effect_uncertain', { taskId: begun.taskId, actionId: request.id })
        }
        await this.persistQuietly()
      } catch (error) {
        this.deps.log?.error('[desktop-action-task] settle failed:', error)
      }
    })
  }
}

function optionalProgress(progress: TaskProgressRecord | undefined): { progress?: TaskProgressRecord } {
  return progress ? { progress } : {}
}
