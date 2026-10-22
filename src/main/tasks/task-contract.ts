import type { TrustedInputOwner } from '@shared/input-session'

/** Task ownership is derived by the future main-process caller from the WP02 IPC sender. */
export type TaskOwner = TrustedInputOwner

/**
 * `planning` holds no authority: the plan is being drafted or was steered, and only an approval (`reviseTask`)
 * makes the task `ready`. `quota_paused` is a billing suspension at a step boundary. It keeps the task revision,
 * the consumed budget and the live grants; it never refills budget and it never revives revoked authority.
 */
export type TaskStatus =
  | 'planning'
  | 'ready'
  | 'dispatching'
  | 'paused'
  | 'quota_paused'
  | 'cancelled'
  | 'completed'
  | 'uncertain'
export type EffectOutcome = 'applied' | 'not-applied' | 'uncertain'

export interface TaskScope {
  readonly capabilities: readonly string[]
  /** Resource name -> non-negative finite budget. Resource names are owner policy inputs. */
  readonly resources: Readonly<Record<string, number>>
}

/** Every policy value is required input. This contract defines no task types, capability names, resource
 * budgets, retention period, or grant lifetime by default. */
export interface TaskPolicy {
  readonly allowedTaskTypes: readonly string[]
  readonly allowedCapabilities: readonly string[]
  readonly resourceBudgets: Readonly<Record<string, number>>
  readonly maxRetentionMs: number
  readonly maxGrantTtlMs: number
}

export interface TaskDefinition {
  readonly taskId: string
  readonly revision: number
  readonly taskType: string
  readonly owner: TaskOwner
  /** The future main-process caller must canonicalize and hash task arguments before supplying this value.
   * The transition layer only compares digest strings; it cannot establish argument identity or trust. */
  readonly argumentsDigest: string
  readonly scope: TaskScope
  readonly createdAt: number
  readonly retentionMs: number
  readonly parentTaskId?: string
  readonly parentTaskRevision?: number
  /**
   * A multi-step task survives a verified step: it returns to `ready` and meters its budget across every step
   * and every helper. A task without this flag keeps the single-action behaviour (an applied effect completes it).
   */
  readonly multiStep?: boolean
}

export interface DispatchGrantScope {
  readonly capability: string
  readonly resources: Readonly<Record<string, number>>
}

/** The grant identifier and record remain main-owned. No renderer or provider response receives them. */
export interface DispatchGrant {
  readonly grantId: string
  readonly taskId: string
  readonly taskRevision: number
  readonly owner: TaskOwner
  readonly argumentsDigest: string
  readonly scope: DispatchGrantScope
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface TaskRecord extends TaskDefinition {
  readonly status: TaskStatus
  readonly expiresAt: number
  readonly effectOutcome?: EffectOutcome
  readonly activeAttemptId?: string
  readonly lastAttemptId?: string
  /** Verified steps of a multi-step task. */
  readonly stepsCompleted?: number
  /** Budget charged at step admission, shared by every helper in the lineage. Present only on metered lineages. */
  readonly usedResources?: Readonly<Record<string, number>>
}

export interface TaskAttempt {
  readonly attemptId: string
  readonly taskId: string
  readonly taskRevision: number
  readonly grantId: string
  readonly owner: TaskOwner
  readonly argumentsDigest: string
  readonly scope: DispatchGrantScope
  readonly authorizedAt: number
  readonly status: 'authorized' | 'uncertain' | 'settled' | 'reconciled'
  readonly outcome?: EffectOutcome
}

export interface TaskRuntimeState {
  readonly tasks: ReadonlyMap<string, TaskRecord>
  readonly attempts: ReadonlyMap<string, TaskAttempt>
  readonly grants: ReadonlyMap<string, DispatchGrant>
  readonly consumedGrantIds: ReadonlySet<string>
  /** Recovery fence. Only a future main-owned owner-rebind decision may clear this. */
  readonly ownerRebindRequired: boolean
}

export type TaskTransitionDenial =
  | 'invalid_input'
  | 'duplicate_task'
  | 'unknown_task'
  | 'task_expired'
  | 'task_not_ready'
  | 'task_type_not_allowed'
  | 'capability_not_allowed'
  | 'scope_not_subset'
  | 'budget_exceeded'
  | 'retention_exceeded'
  | 'grant_id_reused'
  | 'attempt_id_reused'
  | 'grant_already_exists'
  | 'grant_missing'
  | 'grant_replayed'
  | 'grant_expired'
  | 'grant_not_yet_valid'
  | 'owner_rebind_required'
  | 'stale_task_revision'
  | 'wrong_owner'
  | 'arguments_changed'
  | 'wrong_scope'
  | 'parent_inactive'
  | 'uncertain_requires_reconciliation'
  | 'invalid_transition'
  | 'step_active'
  | 'lease_stale'

export type TransitionResult<T extends TaskRuntimeState = TaskRuntimeState> =
  | { readonly ok: true; readonly state: T }
  | { readonly ok: false; readonly state: T; readonly reason: TaskTransitionDenial }

export interface DispatchDecision {
  readonly allowed: boolean
  readonly reason?: TaskTransitionDenial
  readonly task?: TaskRecord
}

/** Why a step lease signal was aborted. */
export type StepLeaseAbortReason = 'revoked' | 'expired'
