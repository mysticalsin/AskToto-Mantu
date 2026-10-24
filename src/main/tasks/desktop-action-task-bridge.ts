import { randomBytes } from 'node:crypto'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
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
import type {
  EffectOutcome,
  TaskOwner,
  TaskPolicy,
  TaskRecord,
  TaskRecoveryOwner,
  TaskRuntimeState,
  TaskStatus
} from './task-contract'
import { archivePredatesErasure } from './task-erasure-fence'
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
import type { FocusRequestStep } from './focus-request'
import {
  ACTIONS_RESOURCE,
  DESKTOP_ACTION_SCHEDULER_LIMITS,
  DESKTOP_ACTION_TASK_POLICY,
  DESKTOP_ACTION_TASK_TYPE,
  GRANT_TTL_MS,
  desktopActionResources
} from './desktop-action-task-policy'
import { archiveHasRoom, pruneState } from './desktop-action-task-archive'
import { TaskCards, type CardRecord } from './desktop-action-task-cards'
import { TaskScheduler, type SchedulerJob, type SchedulerLimits, type SchedulerResult } from './task-scheduler'
import { TaskSteeringInbox, type PendingSteer } from './task-steering'
import { enterForeground } from './desktop-action-foreground'
import { TaskStepLeases, type StepLease } from './task-step-lease'
import { DesktopActionTaskRecovery as DesktopActionTaskRecoveryManager } from './desktop-action-task-recovery'
import {
  authorizeDispatch,
  cancelTask,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  recordEffectOutcome,
  steerTask
} from './task-state'

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
  | 'task.focus_requested'
  | 'task.escape_release'

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
  /** G40: the separate decision and Escape release for foreground-only adapters. Absent means those are refused. */
  focus?: FocusRequestStep
  platform?: NodeJS.Platform
  gesture?: DesktopActionGestureGate
  recipient?: DesktopActionRecipientGate
  store: TaskStateStore
  authSessionGeneration: () => number
  /** Stable owner/tenant pair for recovery disclosure only. Missing attribution never changes task admission. */
  recoveryPrincipal?: () => TaskRecoveryOwner | null
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

/**
 * Runs every confirmed desktop command as a task: create, grant, authorize, dispatch once, record the effect.
 * A dispatch whose outcome cannot be proven is `uncertain`, is persisted as such, and is never replayed.
 */
export class DesktopActionTaskBridge {
  private state: TaskRuntimeState = createTaskRuntimeState()
  private progress: TaskProgressState = createTaskProgressState()
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly recoveryManager: DesktopActionTaskRecoveryManager
  private readonly scheduler: TaskScheduler
  private readonly leases = new TaskStepLeases()
  private readonly steering = new TaskSteeringInbox()
  private stopGeneration = 0
  private readonly taskCards: TaskCards
  private readonly now: () => number
  private readonly newId: () => string

  /** Bound executor handed to CommandControl. */
  readonly execute: CommandExecutor

  /** Bound recovery hook handed to the boot sequence. Idempotent. */
  readonly recover: () => Promise<DesktopActionTaskRecovery>

  /** Bound Stop: invalidates queued work, aborts running step leases, drops pending steers. */
  readonly stop: (reason?: string) => void
  readonly cards: TaskCards['list']
  readonly onCardsChanged: TaskCards['onChanged']
  readonly stopCard: TaskCards['stopCard']
  readonly dismissCard: TaskCards['dismiss']

  constructor(private readonly deps: DesktopActionTaskBridgeDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => randomBytes(16).toString('hex'))
    this.taskCards = new TaskCards({
      now: this.now,
      newCardId: deps.newCardId ?? (() => randomBytes(16).toString('hex')),
      warn: (message, ...args) => deps.log?.warn(message, ...args),
      authSessionGeneration: deps.authSessionGeneration,
      stopTask: (record, running) => {
        if (running) this.leases.abortTask(taskIdFor(record.key), 'revoked')
        this.scheduler.cancel(record.key)
        deps.audit?.('task.stopped', { actionId: record.actionId, queued: '0', running: '1', steers: '0' })
      }
    })
    // Bound in the constructor, not as arrow class properties: the main bundle's bytecode step cannot
    // compile arrow functions inside class property initializers.
    this.scheduler = deps.scheduler ?? new TaskScheduler(DESKTOP_ACTION_SCHEDULER_LIMITS)
    this.recoveryManager = new DesktopActionTaskRecoveryManager({
      acknowledgements: deps.acknowledgements,
      currentPrincipal: () => deps.recoveryPrincipal?.() ?? null,
      authSessionGeneration: deps.authSessionGeneration,
      withLock: (fn) => this.locked(fn),
      tasks: () => this.state.tasks.values(),
      loaded: () => this.loaded,
      log: deps.log
    })
    this.execute = this.schedule.bind(this)
    this.stop = this.stopAll.bind(this)
    this.cards = this.taskCards.list.bind(this.taskCards)
    this.onCardsChanged = this.taskCards.onChanged.bind(this.taskCards)
    this.stopCard = this.taskCards.stopCard.bind(this.taskCards)
    this.dismissCard = this.taskCards.dismiss.bind(this.taskCards)
    this.recover = this.recoverState.bind(this)
  }

  /**
   * Uncertain tasks the person has not been told about yet, as copy for the Reader details. Each one is returned
   * once and then counts as acknowledged (persisted). It names the action and never its arguments (privacy), and
   * it never replays anything. Empty until recovery has run.
   */
  async takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]> {
    return this.recoveryManager.takeRecoveryNotices()
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
    const authSessionGeneration = this.deps.authSessionGeneration()
    const recoveryOwner = this.recoveryManager.captureRecoveryPrincipal() ?? undefined
    const bound = this.deps.gesture?.bindingFor(context.owner.webContentsId) ?? null
    const owner = `webContents:${context.owner.webContentsId}`
    const card = this.taskCards.open(context.proposalId, owner, authSessionGeneration, request.id)
    const job: SchedulerJob<DesktopActionResult> = {
      key: context.proposalId,
      owner,
      effect: 'effect',
      resources: desktopActionResources(request),
      run: (signal) => this.run(request, context, signal, bound, authSessionGeneration, recoveryOwner, card)
    }
    let queued: SchedulerResult<DesktopActionResult>
    try {
      queued = await this.scheduler.submit(job)
    } catch (error) {
      // The job ran and threw out of the bridge: run() settles every dispatch, so this is a defect, not an effect.
      if (card) this.taskCards.finish(card, 'uncertain')
      throw error
    }
    if (queued.status === 'ran') return queued.value
    // Never dispatched: a clean refusal, not an unknown effect.
    this.taskCards.rejectQueued(card, queued.reason)
    this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: `queue_${queued.reason}` })
    return queued.reason === 'stopped'
      ? { id: request.id, ok: false, outcome: 'cancelled', detail: 'stopped' }
      : failedResult(request.id, `task_denied:queue_${queued.reason}`)
  }

  /** Stop. Running steps finish settling on their own: an abort cannot prove the effect did not happen. */
  private stopAll(reason?: string): void {
    if (!this.taskCards.clearForLifecycle(reason)) this.taskCards.stoppingAllRunning()
    this.stopGeneration += 1
    const summary = this.scheduler.stop()
    this.leases.abortAll('revoked')
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
    bound: GestureBinding | null,
    authSessionGeneration: number,
    recoveryOwner: TaskRecoveryOwner | undefined,
    card: CardRecord | undefined
  ): Promise<DesktopActionResult> {
    const generation = this.stopGeneration
    const settlementRecipientIsCurrent = (): boolean =>
      this.recoveryManager.isSettlementRecipientCurrent(
        recoveryOwner,
        () =>
          this.deps.authSessionGeneration() === authSessionGeneration &&
          card !== undefined &&
          this.taskCards.forKey(card.key) === card
      )
    if (this.deps.authSessionGeneration() !== authSessionGeneration) {
      if (card) this.taskCards.drop(card)
      return { id: request.id, ok: false, outcome: 'cancelled', detail: 'stale_owner' }
    }
    const refusal = this.gestureRefusal(request, context, bound)
    if (refusal) {
      // Nothing was created or dispatched: a clean refusal that never retargets.
      this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: refusal })
      if (card) this.taskCards.finish(card, 'not_done', 'refused')
      return failedResult(request.id, `task_denied:${refusal}`)
    }
    if (card && card.phase === 'queued') this.taskCards.setPhase(card, 'running')
    // G40: a foreground-only adapter needs its own decision and an Escape release before anything is authorized.
    const foreground = await enterForeground(this.deps, request, context, signal, () => {
      if (card) this.taskCards.stopCard(`webContents:${context.owner.webContentsId}`, card.cardId)
      else this.leases.abortTask(taskIdFor(context.proposalId), 'revoked')
    })
    if (!foreground.ok) {
      this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: foreground.reason })
      if (card) this.taskCards.finish(card, 'not_done', foreground.stopped ? 'stopped_before_start' : 'refused')
      return foreground.stopped
        ? { id: request.id, ok: false, outcome: 'cancelled', detail: 'stopped' }
        : failedResult(request.id, `task_denied:${foreground.reason}`)
    }
    const hold = foreground.hold
    try {
      return await this.dispatch(
        request,
        context,
        signal,
        generation,
        authSessionGeneration,
        recoveryOwner,
        card,
        settlementRecipientIsCurrent
      )
    } finally {
      hold?.end()
    }
  }

  private async dispatch(
    request: DesktopActionRequest,
    context: CommandExecutionContext,
    signal: AbortSignal,
    generation: number,
    authSessionGeneration: number,
    recoveryOwner: TaskRecoveryOwner | undefined,
    card: CardRecord | undefined,
    settlementRecipientIsCurrent: () => boolean
  ): Promise<DesktopActionResult> {
    let begun: Begun
    try {
      begun = await this.begin(request, context, authSessionGeneration, recoveryOwner)
    } catch (error) {
      // Nothing was dispatched: the adapter has not been called, so this is a clean failure.
      this.deps.log?.error('[desktop-action-task] could not start the task:', error)
      if (card) this.taskCards.finish(card, 'not_done', 'refused')
      return failedResult(request.id, 'task_bridge_error')
    }
    if (!begun.ok) {
      this.deps.audit?.('task.dispatch_denied', { actionId: request.id, reason: begun.reason })
      if (card) this.taskCards.finish(card, 'not_done', 'refused')
      return failedResult(request.id, `task_denied:${begun.reason}`)
    }

    // Stop reached the job between authorization and dispatch: nothing ran, so close the task cleanly.
    if (
      signal.aborted ||
      begun.lease.signal.aborted ||
      generation !== this.stopGeneration ||
      this.deps.authSessionGeneration() !== authSessionGeneration
    ) {
      await this.locked(async () => {
        this.recordNotApplied(begun.taskId, begun.attemptId)
        this.leases.sync(this.state, this.now())
        this.progress = forgetTaskProgress(this.progress, begun.taskId)
        await this.persistQuietly()
      })
      if (card) this.taskCards.finish(card, 'not_done', 'stopped_before_start')
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
    await this.settle(begun, request, outcome, settlementRecipientIsCurrent)
    if (card) this.taskCards.finishEffect(card, outcome)

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

      if (result.kind === 'loaded' && archivePredatesErasure(result.state)) result = { kind: 'not-found' } // G82
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

  private ownerFor(context: CommandExecutionContext, authSessionGeneration: number): TaskOwner {
    // assertMainWindow admits only the main frame before confirm is called, so the top frame is the only owner frame.
    return {
      webContentsId: context.owner.webContentsId,
      frameId: 'main',
      isTopFrame: true,
      authSessionGeneration,
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

  private async begin(
    request: DesktopActionRequest,
    context: CommandExecutionContext,
    authSessionGeneration: number,
    recoveryOwner: TaskRecoveryOwner | undefined
  ): Promise<Begun> {
    const envelope = this.bindEnvelope(request, context)
    if (!envelope) return { ok: false, reason: 'arguments_changed' }
    if (this.deps.authSessionGeneration() !== authSessionGeneration) return { ok: false, reason: 'wrong_owner' }
    const recovery = await this.recoverState()
    if (this.deps.authSessionGeneration() !== authSessionGeneration) return { ok: false, reason: 'wrong_owner' }
    if (!recovery.available) return { ok: false, reason: 'task_state_unavailable' }
    return this.locked(async (): Promise<Begun> => {
      if (this.deps.authSessionGeneration() !== authSessionGeneration) return { ok: false, reason: 'wrong_owner' }
      const taskId = taskIdFor(context.proposalId)
      const attemptId = this.newId()
      const owner = this.ownerFor(context, authSessionGeneration)
      const argumentsDigest = envelope.argsHash
      const scope = { capabilities: [request.id], resources: { [ACTIONS_RESOURCE]: 1 } }
      const grantScope = { capability: request.id, resources: { [ACTIONS_RESOURCE]: 1 } }
      const issuedAt = this.now()
      const boundRecoveryOwner = this.recoveryManager.retainScheduledPrincipal(recoveryOwner, authSessionGeneration)

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
          retentionMs: DESKTOP_ACTION_TASK_POLICY.maxRetentionMs,
          ...(boundRecoveryOwner ? { recoveryOwner: boundRecoveryOwner } : {})
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
        owner: this.ownerFor(context, authSessionGeneration),
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
    outcome: EffectOutcome,
    settlementRecipientIsCurrent: () => boolean
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
          // Keep the historical current-recipient auto-ack and suppress known retirement; this does not prove display.
          await this.recoveryManager.acknowledgeSettled(begun.taskId, settlementRecipientIsCurrent)
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
