import { randomBytes } from 'node:crypto'
import { recoveredUncertainCopy } from '@shared/command-copy'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import {
  TASK_CARD_DONE_LINGER_MS,
  TASK_CARD_LIMIT,
  TASK_CARD_NOT_DONE_LINGER_MS,
  type TaskCardPhase,
  type TaskCardView
} from '@shared/task-card'
import type { MetisCommandRecoveryNotice } from '@shared/metis-command-contract'
import { checkGestureTarget, type GestureBinding, type GestureTarget } from '@shared/gesture-binding'
import { recipientFieldsIn, recipientsMatchResolution, type ResolvedRecipient } from '@shared/recipient-resolution'
import { DESKTOP_ADAPTER_IDS } from '@shared/desktop-actions'
import {
  ACTION_DEPENDENCY_LIMIT,
  actionArgsHash,
  actionIdempotencyKey,
  isObservedVerified,
  type ActionEnvelope
} from '../action-guard'
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
import { TaskScheduler, type SchedulerJob, type SchedulerLimits, type SchedulerResult } from './task-scheduler'
import { TaskSteeringInbox, type PendingSteer } from './task-steering'
import { TaskStepLeases, type StepLease } from './task-step-lease'
import {
  authorizeDispatch,
  cancelTask,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  recordEffectOutcome,
  steerTask
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
  // A dispatch grant is issued after confirmation and used at once, so a grant that outlives 10 s is a bug, not a slow
  // user. The card's own lifetime (12 s, 30 s with assistive technology) is a different clock.
  maxGrantTtlMs: 10_000
}
const GRANT_TTL_MS = 10_000

/**
 * Owner-approved 2026-10-22: one desktop-effect task per owner, four read-only, and a 10 s queue wait (no longer
 * than a confirmation lives), so a confirmed action never fires long after it was approved.
 */
export const DESKTOP_ACTION_SCHEDULER_LIMITS: SchedulerLimits = {
  maxEffectPerOwner: 1,
  maxReadOnlyPerOwner: 4,
  maxQueuedPerOwner: 8,
  maxQueueWaitMs: GRANT_TTL_MS
}

/**
 * The named resources an action touches, so two tasks never act on the same app or device at once. Every desktop
 * adapter launches or drives an app, so each is an effect job; the resource is the app it acts on.
 */
export function desktopActionResources(request: DesktopActionRequest): string[] {
  switch (request.id) {
    case 'desktop.open_notes':
    case 'desktop.create_note':
      return ['app:notes']
    case 'desktop.open_arc':
      return ['app:arc']
    case 'desktop.google_search':
    case 'desktop.open_x':
      return [request.args.browser === 'arc' ? 'app:arc' : 'app:default-browser']
    case 'desktop.photo_booth_capture':
      return ['app:photo-booth', 'device:camera']
  }
}

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
export type DesktopActionTaskAuditEvent =
  | 'task.recovered'
  | 'task.effect_uncertain'
  | 'task.dispatch_denied'
  | 'task.stopped'

/**
 * G34: the gesture the task came from. `bindingFor` is read when the command is submitted (the binding that was live
 * when the owner decided), and `currentTarget` is read again at dispatch. A different app in front refuses the task.
 */
export interface DesktopActionGestureGate {
  bindingFor(webContentsId: number): GestureBinding | null
  currentTarget(): GestureTarget | null
  ownPid: number
}

/**
 * G34: the recipient main resolved from trusted UI state for the live gesture. Arguments that address someone may
 * name only that recipient; without a resolver any recipient-bearing request is refused.
 */
export interface DesktopActionRecipientGate {
  resolved(request: DesktopActionRequest, context: CommandExecutionContext): ResolvedRecipient | null
}

export interface DesktopActionTaskBridgeDeps {
  /** The envelope is the args hash and idempotency key main derived. A verified result must echo both in its receipt. */
  execute: (
    request: DesktopActionRequest,
    envelope: ActionEnvelope,
    /** Aborts when Stop reaches the step. It cannot take back an effect already underway: classify by receipt. */
    signal?: AbortSignal
  ) => Promise<DesktopActionResult>
  scheduler?: TaskScheduler
  gesture?: DesktopActionGestureGate
  recipient?: DesktopActionRecipientGate
  store: TaskStateStore
  authSessionGeneration: () => number
  /**
   * Which uncertain tasks the person has already been told about. Without it a recovered uncertain task is
   * reported again at every boot until it expires.
   */
  acknowledgements?: {
    read(): Promise<readonly string[]>
    write(ids: readonly string[]): Promise<void>
  }
  audit?: (event: DesktopActionTaskAuditEvent, metadata: Record<string, string>) => void
  log?: { warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void }
  now?: () => number
  newId?: () => string
  /** Opaque card ids for the renderer (32 hex). Never derived from a task id; defaults to 16 random bytes. */
  newCardId?: () => string
}

/** One card per scheduled desktop task. Lives in main only; the renderer gets TaskCardView. */
interface CardRecord {
  readonly cardId: string
  /** The proposal id: also the scheduler key and the suffix of the task id. Never leaves main. */
  readonly key: string
  readonly owner: string
  readonly actionId: string
  phase: TaskCardPhase
  reason?: 'stopped_before_start' | 'refused'
  finishedAt?: number
}

const LIVE_PHASES: readonly TaskCardPhase[] = ['queued', 'running', 'stopping']
/** Finished records kept in main beyond what is shown; the oldest go first. */
const CARD_RECORD_CAP = TASK_CARD_LIMIT * 2

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

type Begun =
  | { ok: true; taskId: string; attemptId: string; owner: TaskOwner; envelope: ActionEnvelope; lease: StepLease }
  | { ok: false; reason: string }

/** The task's arguments digest is the ActionGuard args hash: one identity for approval, task and receipt. */
export function desktopActionArgumentsDigest(request: DesktopActionRequest): string {
  return actionArgsHash(request)
}

function taskIdFor(proposalId: string): string {
  return `${DESKTOP_ACTION_TASK_TYPE}:${proposalId}`
}

function failedResult(id: DesktopActionRequest['id'], detail: string): DesktopActionResult {
  return { id, ok: false, outcome: 'failed', detail }
}

function unknownResult(id: DesktopActionRequest['id'], detail: string): DesktopActionResult {
  return { id, ok: false, outcome: 'unknown', detail }
}

/**
 * Only a verified result with an observed receipt bound to this dispatch proves the effect. A verified claim
 * without one, and anything else that may have launched something, stays uncertain.
 */
function classifyEffect(
  request: DesktopActionRequest,
  result: DesktopActionResult,
  envelope: ActionEnvelope
): EffectOutcome {
  if (result.id !== request.id) return 'uncertain'
  if (result.outcome === 'verified') return isObservedVerified(request, result, envelope) ? 'applied' : 'uncertain'
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
  private acknowledged: Set<string> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private readonly scheduler: TaskScheduler
  private readonly leases = new TaskStepLeases()
  private readonly steering = new TaskSteeringInbox()
  private stopGeneration = 0
  private readonly cardRecords = new Map<string, CardRecord>()
  private readonly cardsByKey = new Map<string, CardRecord>()
  private readonly cardListeners = new Set<() => void>()
  private readonly newCardId: () => string
  private readonly now: () => number
  private readonly newId: () => string

  /** Bound executor handed to CommandControl. */
  readonly execute: CommandExecutor

  /** Bound recovery hook handed to the boot sequence. Idempotent. */
  readonly recover: () => Promise<DesktopActionTaskRecovery>

  /** Bound Stop: invalidates queued work, aborts running step leases, drops pending steers. */
  readonly stop: () => void

  constructor(private readonly deps: DesktopActionTaskBridgeDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => randomBytes(16).toString('hex'))
    this.newCardId = deps.newCardId ?? (() => randomBytes(16).toString('hex'))
    // Bound in the constructor, not as arrow class properties: the main bundle's bytecode step cannot
    // compile arrow functions inside class property initializers.
    this.scheduler = deps.scheduler ?? new TaskScheduler(DESKTOP_ACTION_SCHEDULER_LIMITS)
    this.execute = this.schedule.bind(this)
    this.stop = this.stopAll.bind(this)
    this.recover = this.recoverState.bind(this)
  }

  /**
   * Uncertain tasks the person has not been told about yet, as copy for the Reader details. Each one is returned
   * once and then counts as acknowledged (persisted). It names the action and never its arguments (privacy), and
   * it never replays anything. Empty until recovery has run.
   */
  async takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]> {
    if (!this.loaded) return []
    return this.locked(async () => {
      const acknowledged = await this.loadAcknowledgements()
      const fresh = [...this.state.tasks.values()].filter(
        (task) => task.effectOutcome === 'uncertain' && !acknowledged.has(task.taskId)
      )
      if (fresh.length === 0) return []
      for (const task of fresh) acknowledged.add(task.taskId)
      await this.persistAcknowledgements()
      return fresh.map((task) => {
        const actionId = task.scope.capabilities[0] ?? ''
        return { taskId: task.taskId, actionId, copy: recoveredUncertainCopy(actionId) }
      })
    })
  }

  private async loadAcknowledgements(): Promise<Set<string>> {
    if (this.acknowledged) return this.acknowledged
    let ids: readonly string[] = []
    try {
      ids = (await this.deps.acknowledgements?.read()) ?? []
    } catch (error) {
      this.deps.log?.warn('[desktop-action-task] could not read acknowledgements; notices may repeat once:', error)
    }
    this.acknowledged = new Set(ids)
    return this.acknowledged
  }

  /** Forget acknowledgements for tasks that no longer exist, then write. Best effort: a notice may repeat once. */
  private async persistAcknowledgements(): Promise<void> {
    if (!this.acknowledged || !this.deps.acknowledgements) return
    const live = [...this.acknowledged].filter((id) => this.state.tasks.has(id))
    this.acknowledged = new Set(live)
    try {
      await this.deps.acknowledgements.write(live)
    } catch (error) {
      this.deps.log?.warn('[desktop-action-task] could not persist acknowledgements:', error)
    }
  }

  snapshot(): DesktopActionTaskSnapshot[] {
    return [...this.state.tasks.values()].map((task) => ({
      taskId: task.taskId,
      actionId: task.scope.capabilities[0] ?? '',
      status: task.status,
      ...(task.effectOutcome ? { effectOutcome: task.effectOutcome } : {}),
      ...optionalProgress(readTaskProgress(this.progress, task, this.state.ownerRebindRequired, task.owner))
    }))
  }

  /** Queues the confirmed command behind its owner's active task and the resources it names. */
  private async schedule(
    request: DesktopActionRequest,
    context: CommandExecutionContext
  ): Promise<DesktopActionResult> {
    const bound = this.deps.gesture?.bindingFor(context.owner.webContentsId) ?? null
    const owner = `webContents:${context.owner.webContentsId}`
    const job: SchedulerJob<DesktopActionResult> = {
      key: context.proposalId,
      owner,
      effect: 'effect',
      resources: desktopActionResources(request),
      run: (signal) => this.run(request, context, signal, bound)
    }
    const card = this.openCard(context.proposalId, owner, request.id)
    let queued: SchedulerResult<DesktopActionResult>
    try {
      queued = await this.scheduler.submit(job)
    } catch (error) {
      // The job ran and threw out of the bridge: run() settles every dispatch, so this is a defect, not an effect.
      if (card) this.finishCard(card, 'uncertain')
      throw error
    }
    if (queued.status === 'ran') return queued.value
    // Never dispatched: a clean refusal, not an unknown effect.
    if (card) {
      if (queued.reason === 'invalid_job') this.dropCard(card)
      else this.finishCard(card, 'not_done', queued.reason === 'stopped' ? 'stopped_before_start' : 'refused')
    }
    this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: `queue_${queued.reason}` })
    return queued.reason === 'stopped'
      ? { id: request.id, ok: false, outcome: 'cancelled', detail: 'stopped' }
      : failedResult(request.id, `task_denied:queue_${queued.reason}`)
  }

  /**
   * The cards the owner window may show, oldest first. A card id from another owner is simply absent. Views carry
   * the action id and phase only: never a task id, grant, args hash, owner or argument.
   */
  cards(owner: string): TaskCardView[] {
    const now = this.now()
    const views: TaskCardView[] = []
    for (const record of this.cardRecords.values()) {
      if (record.owner !== owner || this.cardExpired(record, now)) continue
      views.push({
        cardId: record.cardId,
        actionId: record.actionId,
        phase: record.phase,
        ...(record.reason ? { reason: record.reason } : {}),
        stoppable: record.phase === 'queued' || record.phase === 'running',
        dismissible: record.phase === 'not_done' || record.phase === 'uncertain'
      })
    }
    return views.slice(-TASK_CARD_LIMIT)
  }

  onCardsChanged(listener: () => void): () => void {
    this.cardListeners.add(listener)
    return () => {
      this.cardListeners.delete(listener)
    }
  }

  /** Stop one card: cancels a queued task outright, or aborts the running step. Uncertain stays uncertain. */
  stopCard(owner: string, cardId: string): boolean {
    const record = this.cardFor(owner, cardId)
    if (!record || (record.phase !== 'queued' && record.phase !== 'running')) return false
    if (record.phase === 'running') {
      record.phase = 'stopping'
      this.leases.abortTask(taskIdFor(record.key), 'revoked')
    }
    this.scheduler.cancel(record.key)
    this.deps.audit?.('task.stopped', { actionId: record.actionId, queued: '0', running: '1', steers: '0' })
    this.emitCards()
    return true
  }

  /** Dismiss a card that needs no more decisions (not done, or uncertain and acknowledged). */
  dismissCard(owner: string, cardId: string): boolean {
    const record = this.cardFor(owner, cardId)
    if (!record || (record.phase !== 'not_done' && record.phase !== 'uncertain')) return false
    this.dropCard(record)
    return true
  }

  private cardFor(owner: string, cardId: string): CardRecord | undefined {
    const record = this.cardRecords.get(cardId)
    if (!record || record.owner !== owner || this.cardExpired(record, this.now())) return undefined
    return record
  }

  private cardExpired(record: CardRecord, now: number): boolean {
    if (record.finishedAt === undefined) return false
    if (record.phase === 'done') return now - record.finishedAt >= TASK_CARD_DONE_LINGER_MS
    if (record.phase === 'not_done') return now - record.finishedAt >= TASK_CARD_NOT_DONE_LINGER_MS
    return false
  }

  /** A card for a newly submitted job. Returns undefined when the key already has a live card (a duplicate submit). */
  private openCard(key: string, owner: string, actionId: string): CardRecord | undefined {
    const existing = this.cardsByKey.get(key)
    if (existing && LIVE_PHASES.includes(existing.phase)) return undefined
    if (existing) this.dropCard(existing, false)
    const record: CardRecord = { cardId: this.newCardId(), key, owner, actionId, phase: 'queued' }
    this.cardRecords.set(record.cardId, record)
    this.cardsByKey.set(key, record)
    this.trimCards()
    this.emitCards()
    return record
  }

  private cardForKey(key: string): CardRecord | undefined {
    return this.cardsByKey.get(key)
  }

  private setCardPhase(record: CardRecord, phase: TaskCardPhase): void {
    if (record.phase === phase) return
    record.phase = phase
    this.emitCards()
  }

  private finishCard(
    record: CardRecord,
    phase: 'done' | 'not_done' | 'uncertain',
    reason?: CardRecord['reason']
  ): void {
    record.phase = phase
    if (reason) record.reason = reason
    else delete record.reason
    record.finishedAt = this.now()
    const linger =
      phase === 'done' ? TASK_CARD_DONE_LINGER_MS : phase === 'not_done' ? TASK_CARD_NOT_DONE_LINGER_MS : undefined
    if (linger !== undefined) {
      // Pushes the shrunken list once the linger passes. cards() filters by the injected clock either way.
      const timer = setTimeout(() => {
        if (this.cardRecords.get(record.cardId) === record && this.cardExpired(record, this.now())) {
          this.dropCard(record)
        }
      }, linger + 1)
      timer.unref?.()
    }
    this.emitCards()
  }

  private dropCard(record: CardRecord, emit = true): void {
    this.cardRecords.delete(record.cardId)
    if (this.cardsByKey.get(record.key) === record) this.cardsByKey.delete(record.key)
    if (emit) this.emitCards()
  }

  /** Bounded memory: past the cap the oldest finished records go first. */
  private trimCards(): void {
    if (this.cardRecords.size <= CARD_RECORD_CAP) return
    for (const record of [...this.cardRecords.values()]) {
      if (this.cardRecords.size <= CARD_RECORD_CAP) break
      if (record.finishedAt !== undefined) this.dropCard(record, false)
    }
  }

  private emitCards(): void {
    for (const listener of [...this.cardListeners]) {
      try {
        listener()
      } catch (error) {
        this.deps.log?.warn('[desktop-action-task] a task card listener threw:', error)
      }
    }
  }

  /** Stop. Running steps finish settling on their own: an abort cannot prove the effect did not happen. */
  private stopAll(): void {
    this.stopGeneration += 1
    for (const record of this.cardRecords.values()) if (record.phase === 'running') record.phase = 'stopping'
    const summary = this.scheduler.stop()
    this.leases.abortAll('revoked')
    this.emitCards()
    const droppedSteers = this.steering.dropAll()
    if (summary.queued + summary.running + droppedSteers.length > 0) {
      this.deps.audit?.('task.stopped', {
        queued: String(summary.queued),
        running: String(summary.running),
        steers: String(droppedSteers.length)
      })
    }
  }

  /**
   * Steering changes a task only at a safe boundary. A task in a step is not at one, so the steer waits and is
   * applied (G06 steerTask) the moment that step settles.
   */
  steer(steer: PendingSteer): Promise<{ ok: boolean; reason?: string }> {
    return this.locked(async () => {
      const task = this.state.tasks.get(steer.taskId)
      if (!task) return { ok: false, reason: 'unknown_task' }
      if (task.status === 'dispatching') return this.steering.defer(steer)
      return this.applySteer(steer)
    })
  }

  private async applySteer(steer: PendingSteer): Promise<{ ok: boolean; reason?: string }> {
    const steered = steerTask(this.state, {
      taskId: steer.taskId,
      revision: steer.revision,
      argumentsDigest: steer.argumentsDigest
    })
    if (!steered.ok) return { ok: false, reason: steered.reason }
    this.state = steered.state
    this.leases.sync(this.state, this.now())
    await this.persistQuietly()
    return { ok: true }
  }

  private async run(
    request: DesktopActionRequest,
    context: CommandExecutionContext,
    signal: AbortSignal,
    bound: GestureBinding | null
  ): Promise<DesktopActionResult> {
    const generation = this.stopGeneration
    const card = this.cardForKey(context.proposalId)
    const refusal = this.gestureRefusal(request, context, bound)
    if (refusal) {
      // Nothing was created or dispatched: a clean refusal that never retargets.
      this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: refusal })
      if (card) this.finishCard(card, 'not_done', 'refused')
      return failedResult(request.id, `task_denied:${refusal}`)
    }
    if (card && card.phase === 'queued') this.setCardPhase(card, 'running')
    let begun: Begun
    try {
      begun = await this.begin(request, context)
    } catch (error) {
      // Nothing was dispatched: the adapter has not been called, so this is a clean failure.
      this.deps.log?.error('[desktop-action-task] could not start the task:', error)
      if (card) this.finishCard(card, 'not_done', 'refused')
      return failedResult(request.id, 'task_bridge_error')
    }
    if (!begun.ok) {
      this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: begun.reason })
      if (card) this.finishCard(card, 'not_done', 'refused')
      return failedResult(request.id, `task_denied:${begun.reason}`)
    }

    // Stop reached the job between authorization and dispatch: nothing ran, so close the task cleanly.
    if (signal.aborted || begun.lease.signal.aborted || generation !== this.stopGeneration) {
      await this.locked(async () => {
        this.recordNotApplied(begun.taskId, begun.attemptId)
        this.leases.sync(this.state, this.now())
        this.progress = forgetTaskProgress(this.progress, begun.taskId)
        await this.persistQuietly()
      })
      if (card) this.finishCard(card, 'not_done', 'stopped_before_start')
      return { id: request.id, ok: false, outcome: 'cancelled', detail: 'stopped' }
    }

    let result: DesktopActionResult | undefined
    let outcome: EffectOutcome
    try {
      result = await this.deps.execute(request, begun.envelope, begun.lease.signal)
      outcome = classifyEffect(request, result, begun.envelope)
    } catch {
      // Thrown after dispatch began: the effect may have happened. Observe it, never retry it.
      outcome = 'uncertain'
    }
    await this.settle(begun, request, outcome)
    if (card) {
      if (outcome === 'applied') this.finishCard(card, 'done')
      else if (outcome === 'not-applied') this.finishCard(card, 'not_done')
      else this.finishCard(card, 'uncertain')
    }

    if (!result) return unknownResult(request.id, 'dispatch_threw')
    if (outcome === 'uncertain' && result.outcome !== 'unknown') return unknownResult(request.id, 'outcome_unverified')
    return result
  }

  /** G34: the task stays on the app the gesture started in, and a recipient comes only from trusted UI state. */
  private gestureRefusal(
    request: DesktopActionRequest,
    context: CommandExecutionContext,
    bound: GestureBinding | null
  ): 'target_changed' | 'recipient_unresolved' | null {
    const gesture = this.deps.gesture
    if (bound && gesture && !checkGestureTarget(bound, gesture.currentTarget(), gesture.ownPid).ok) {
      return 'target_changed'
    }
    const fields = recipientFieldsIn(request.args)
    if (fields.length === 0) return null
    const resolved = this.deps.recipient?.resolved(request, context) ?? null
    return resolved && recipientsMatchResolution(fields, resolved) ? null : 'recipient_unresolved'
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
        // Nothing but an uncertain or finished record may survive a restart. A stray ready, paused, planning or quota-paused task is cancelled.
        for (const task of next.tasks.values()) {
          if (
            task.status === 'ready' ||
            task.status === 'paused' ||
            task.status === 'planning' ||
            task.status === 'quota_paused'
          ) {
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

  /** Recomputed from the request about to run: the confirmation's hash and key must name exactly this dispatch. */
  private bindEnvelope(request: DesktopActionRequest, context: CommandExecutionContext): ActionEnvelope | null {
    const argsHash = actionArgsHash(request)
    const idempotencyKey = actionIdempotencyKey(context.proposalId, argsHash)
    return context.argsHash === argsHash && context.idempotencyKey === idempotencyKey
      ? { argsHash, idempotencyKey }
      : null
  }

  /** Only an action that was verified by an observed receipt unlocks the actions that depend on it. */
  private dependenciesVerified(context: CommandExecutionContext): boolean {
    const dependsOn = new Set(context.dependsOn)
    if (dependsOn.size > ACTION_DEPENDENCY_LIMIT) return false
    for (const proposalId of dependsOn) {
      if (this.state.tasks.get(taskIdFor(proposalId))?.effectOutcome !== 'applied') return false
    }
    return true
  }

  private async begin(request: DesktopActionRequest, context: CommandExecutionContext): Promise<Begun> {
    const envelope = this.bindEnvelope(request, context)
    if (!envelope) return { ok: false, reason: 'arguments_changed' }
    const recovery = await this.recoverState()
    if (!recovery.available) return { ok: false, reason: 'task_state_unavailable' }
    return this.locked(async (): Promise<Begun> => {
      const taskId = taskIdFor(context.proposalId)
      const attemptId = this.newId()
      const owner = this.ownerFor(context)
      const argumentsDigest = envelope.argsHash
      const scope = { capabilities: [request.id], resources: { [ACTIONS_RESOURCE]: 1 } }
      const grantScope = { capability: request.id, resources: { [ACTIONS_RESOURCE]: 1 } }
      const issuedAt = this.now()

      this.state = pruneState(this.state, issuedAt, DESKTOP_ACTION_TASK_CODEC_LIMITS)
      if (!archiveHasRoom(this.state, DESKTOP_ACTION_TASK_CODEC_LIMITS)) return { ok: false, reason: 'task_state_full' }
      // Check before retry: a proposal that already has an observed outcome is never dispatched a second time.
      const prior = this.state.tasks.get(taskId)
      if (prior?.effectOutcome === 'applied') return { ok: false, reason: 'duplicate_task' }
      if (prior?.effectOutcome === 'uncertain') return { ok: false, reason: 'duplicate_task' }
      if (!this.dependenciesVerified(context)) return { ok: false, reason: 'dependency_not_verified' }
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
      const dispatching = this.state.tasks.get(taskId)
      if (!dispatching) return { ok: false, reason: 'unknown_task' }
      const lease = this.leases.open(dispatching, dispatching.expiresAt)
      return { ok: true, taskId, attemptId, owner, envelope, lease }
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
        this.leases.sync(this.state, this.now())
        if (outcome === 'uncertain') {
          this.deps.audit?.('task.effect_uncertain', { taskId: begun.taskId, actionId: request.id })
          // The person sees this result now, so a later boot does not announce it a second time.
          const acknowledged = await this.loadAcknowledgements()
          acknowledged.add(begun.taskId)
          await this.persistAcknowledgements()
        }
        // The step has settled: a steer that waited for this boundary is handed over now, exactly once.
        const waiting = this.steering.take(begun.taskId)
        if (waiting) {
          const applied = await this.applySteer(waiting)
          if (!applied.ok) this.deps.log?.warn(`[desktop-action-task] steer not applied (${applied.reason})`)
          return
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
