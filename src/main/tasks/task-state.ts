import type {
  DispatchGrant,
  DispatchGrantScope,
  TaskDefinition,
  TaskOwner,
  TaskPolicy,
  TaskRecord,
  TaskAttempt,
  TaskRuntimeState,
  TaskScope,
  TaskTransitionDenial,
  TransitionResult
} from './task-contract'
import {
  allow,
  budgetFits,
  cancelDescendants,
  chargeFits,
  chargeLineage,
  childScopeStrictlyNarrower,
  deny,
  descendants,
  grantScopeFits,
  invalidateSubtree,
  isMetered,
  lineage,
  lineageHasActiveStep,
  remainingBudget,
  revokeGrants,
  sameGrantScope,
  sameOwner,
  snapshotAttempt,
  snapshotGrant,
  snapshotTask,
  validOwner,
  validPolicy,
  validScope
} from './task-state-internal'

export { completeTask, pauseTaskForQuota, resumeAfterQuota, steerTask } from './task-session'
export { TaskStepLeases, type StepLease, type StepLeaseCheck } from './task-step-lease'

export function createTaskRuntimeState(): TaskRuntimeState {
  return {
    tasks: new Map(),
    attempts: new Map(),
    grants: new Map(),
    consumedGrantIds: new Set(),
    ownerRebindRequired: false
  }
}

export function createTask(
  state: TaskRuntimeState,
  definition: TaskDefinition,
  policy: TaskPolicy,
  options?: { readonly initialStatus?: 'ready' | 'planning' }
): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const initialStatus = options?.initialStatus ?? 'ready'
  if (
    !validPolicy(policy) ||
    !definition ||
    typeof definition.taskId !== 'string' ||
    !definition.taskId ||
    !Number.isSafeInteger(definition.revision) ||
    definition.revision < 1 ||
    typeof definition.taskType !== 'string' ||
    !definition.taskType ||
    !validOwner(definition.owner) ||
    typeof definition.argumentsDigest !== 'string' ||
    !definition.argumentsDigest ||
    !validScope(definition.scope) ||
    !Number.isFinite(definition.createdAt) ||
    !Number.isFinite(definition.retentionMs) ||
    definition.retentionMs < 0 ||
    (initialStatus !== 'ready' && initialStatus !== 'planning') ||
    (definition.multiStep !== undefined && typeof definition.multiStep !== 'boolean') ||
    // A helper is created under an approved parent, so it cannot start unapproved.
    (initialStatus === 'planning' && definition.parentTaskId !== undefined)
  ) {
    return deny(state, 'invalid_input')
  }
  if (state.tasks.has(definition.taskId)) return deny(state, 'duplicate_task')
  if (!policy.allowedTaskTypes.includes(definition.taskType)) return deny(state, 'task_type_not_allowed')
  if (definition.retentionMs > policy.maxRetentionMs) return deny(state, 'retention_exceeded')
  if (!definition.scope.capabilities.every((capability) => policy.allowedCapabilities.includes(capability))) {
    return deny(state, 'capability_not_allowed')
  }
  if (!budgetFits(definition.scope.resources, policy.resourceBudgets)) return deny(state, 'budget_exceeded')
  const expiresAt = definition.createdAt + definition.retentionMs
  if (!Number.isFinite(expiresAt) || expiresAt < definition.createdAt) return deny(state, 'invalid_input')

  if (definition.parentTaskId) {
    const parent = state.tasks.get(definition.parentTaskId)
    if (
      !parent ||
      !sameOwner(parent.owner, definition.owner) ||
      (parent.status !== 'ready' && parent.status !== 'dispatching')
    ) {
      return deny(state, 'parent_inactive')
    }
    if (!Number.isSafeInteger(definition.parentTaskRevision) || definition.parentTaskRevision !== parent.revision) {
      return deny(state, 'stale_task_revision')
    }
    if (expiresAt > parent.expiresAt) return deny(state, 'retention_exceeded')
    if (!childScopeStrictlyNarrower(definition.scope, parent.scope)) return deny(state, 'scope_not_subset')
    // Delegation draws on the parent's shared budget, so a helper cannot ask for more than the parent has left.
    if (isMetered(lineage(state, parent)) && !budgetFits(definition.scope.resources, remainingBudget(parent))) {
      return deny(state, 'budget_exceeded')
    }
  } else if (definition.parentTaskRevision !== undefined) return deny(state, 'invalid_input')

  const task = snapshotTask({ ...definition, expiresAt, status: initialStatus })
  const tasks = new Map(state.tasks)
  tasks.set(task.taskId, task)
  return allow({ ...state, tasks })
}

export function reviseTask(
  state: TaskRuntimeState,
  input: { taskId: string; revision: number; argumentsDigest: string; scope: TaskScope; policy: TaskPolicy }
): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const task = state.tasks.get(input.taskId)
  if (!task) return deny(state, 'unknown_task')
  // Approving a plan (planning -> ready) and re-approving a ready task both replace scope and arguments.
  if (task.status !== 'ready' && task.status !== 'planning') return deny(state, 'task_not_ready')
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision <= task.revision ||
    !input.argumentsDigest ||
    !validScope(input.scope) ||
    !validPolicy(input.policy)
  )
    return deny(state, 'invalid_input')
  if (!input.scope.capabilities.every((capability) => input.policy.allowedCapabilities.includes(capability))) {
    return deny(state, 'capability_not_allowed')
  }
  if (!budgetFits(input.scope.resources, input.policy.resourceBudgets)) return deny(state, 'budget_exceeded')
  if (!input.policy.allowedTaskTypes.includes(task.taskType)) return deny(state, 'task_type_not_allowed')
  if (task.parentTaskId) {
    const parent = state.tasks.get(task.parentTaskId)
    if (!parent || !childScopeStrictlyNarrower(input.scope, parent.scope)) return deny(state, 'scope_not_subset')
  }
  const ids = descendants(state.tasks, task.taskId)
  const next = revokeGrants(state, ids)
  const tasks = new Map(next.tasks)
  const attempts = new Map(next.attempts)
  for (const id of ids) {
    if (id === task.taskId) {
      tasks.set(
        id,
        snapshotTask({
          ...task,
          revision: input.revision,
          argumentsDigest: input.argumentsDigest,
          scope: input.scope,
          status: 'ready',
          effectOutcome: undefined,
          // A new approval opens a new budget. A quota resume never reaches this path.
          usedResources: undefined
        })
      )
    } else {
      const child = tasks.get(id)
      if (child && child.status !== 'completed' && child.status !== 'cancelled') {
        if (child.status === 'dispatching' && child.activeAttemptId) {
          const attempt = attempts.get(child.activeAttemptId)
          if (attempt?.status === 'authorized') {
            attempts.set(attempt.attemptId, snapshotAttempt({ ...attempt, status: 'uncertain', outcome: 'uncertain' }))
          }
          tasks.set(
            id,
            snapshotTask({ ...child, status: 'cancelled', effectOutcome: 'uncertain', activeAttemptId: undefined })
          )
        } else {
          tasks.set(id, snapshotTask({ ...child, status: 'cancelled' }))
        }
      }
    }
  }
  return allow({ ...next, tasks, attempts })
}

export function issueDispatchGrant(
  state: TaskRuntimeState,
  input: { taskId: string; grantId: string; scope: DispatchGrantScope; now: number; ttlMs: number; policy: TaskPolicy }
): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const task = state.tasks.get(input.taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status !== 'ready') return deny(state, 'task_not_ready')
  if (
    !validPolicy(input.policy) ||
    typeof input.grantId !== 'string' ||
    !input.grantId ||
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.ttlMs) ||
    input.ttlMs <= 0 ||
    input.ttlMs > input.policy.maxGrantTtlMs ||
    !input.scope ||
    typeof input.scope.capability !== 'string' ||
    !validScope({ capabilities: [input.scope.capability], resources: input.scope.resources })
  )
    return deny(state, 'invalid_input')
  if (input.now >= task.expiresAt) return deny(state, 'task_expired')
  if (state.grants.has(input.grantId) || state.consumedGrantIds.has(input.grantId))
    return deny(state, 'grant_id_reused')
  if (
    [...state.grants.values()].some((grant) => grant.taskId === task.taskId && grant.taskRevision === task.revision)
  ) {
    return deny(state, 'grant_already_exists')
  }
  if (!grantScopeFits(input.scope, task.scope, input.policy)) return deny(state, 'scope_not_subset')
  if (!chargeFits(lineage(state, task), input.scope.resources)) return deny(state, 'budget_exceeded')
  if (task.parentTaskId) {
    const parent = state.tasks.get(task.parentTaskId)
    if (!parent || (parent.status !== 'ready' && parent.status !== 'dispatching') || input.now >= parent.expiresAt) {
      return deny(state, 'parent_inactive')
    }
    if (parent.revision !== task.parentTaskRevision || !sameOwner(parent.owner, task.owner))
      return deny(state, 'stale_task_revision')
  }
  const expiresAt = input.now + input.ttlMs
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now) return deny(state, 'invalid_input')
  if (expiresAt > task.expiresAt) return deny(state, 'retention_exceeded')
  const grant = snapshotGrant({
    grantId: input.grantId,
    taskId: task.taskId,
    taskRevision: task.revision,
    owner: task.owner,
    argumentsDigest: task.argumentsDigest,
    scope: input.scope,
    issuedAt: input.now,
    expiresAt
  })
  const grants = new Map(state.grants)
  grants.set(grant.grantId, grant)
  return allow({ ...state, grants })
}

export function authorizeDispatch(
  state: TaskRuntimeState,
  input: {
    grantId: string
    attemptId: string
    taskId: string
    taskRevision: number
    owner: TaskOwner
    argumentsDigest: string
    scope: DispatchGrantScope
    now: number
  }
): {
  readonly state: TaskRuntimeState
  readonly decision:
    | { allowed: true; task: TaskRecord; leaseExpiresAt: number }
    | { allowed: false; reason: TaskTransitionDenial }
} {
  const grant = state.grants.get(input.grantId)
  if (!grant) {
    return {
      state,
      decision: {
        allowed: false,
        reason: state.consumedGrantIds.has(input.grantId) ? 'grant_replayed' : 'grant_missing'
      }
    }
  }
  // Any presented grant is single-use. Even a mismatch consumes it, preventing altered-scope retries.
  const grants = new Map(state.grants)
  grants.delete(grant.grantId)
  const consumedGrantIds = new Set(state.consumedGrantIds)
  consumedGrantIds.add(grant.grantId)
  const consumedState = { ...state, grants, consumedGrantIds }
  const task = state.tasks.get(grant.taskId)
  if (typeof input.attemptId !== 'string' || input.attemptId.length === 0) {
    return { state: consumedState, decision: { allowed: false, reason: 'invalid_input' } }
  }
  if (state.ownerRebindRequired) {
    return { state: consumedState, decision: { allowed: false, reason: 'owner_rebind_required' } }
  }
  if (state.attempts.has(input.attemptId))
    return { state: consumedState, decision: { allowed: false, reason: 'attempt_id_reused' } }
  if (!Number.isFinite(input.now))
    return { state: consumedState, decision: { allowed: false, reason: 'invalid_input' } }
  if (input.now < grant.issuedAt)
    return { state: consumedState, decision: { allowed: false, reason: 'grant_not_yet_valid' } }
  if (input.now >= grant.expiresAt)
    return { state: consumedState, decision: { allowed: false, reason: 'grant_expired' } }
  if (grant.taskId !== input.taskId || !task)
    return { state: consumedState, decision: { allowed: false, reason: 'unknown_task' } }
  if (input.now >= task.expiresAt) return { state: consumedState, decision: { allowed: false, reason: 'task_expired' } }
  if (task.parentTaskId) {
    const parent = state.tasks.get(task.parentTaskId)
    if (!parent || (parent.status !== 'ready' && parent.status !== 'dispatching') || input.now >= parent.expiresAt) {
      return { state: consumedState, decision: { allowed: false, reason: 'parent_inactive' } }
    }
    if (parent.revision !== task.parentTaskRevision) {
      return { state: consumedState, decision: { allowed: false, reason: 'stale_task_revision' } }
    }
  }
  if (task.revision !== grant.taskRevision || input.taskRevision !== task.revision) {
    return { state: consumedState, decision: { allowed: false, reason: 'stale_task_revision' } }
  }
  if (!validOwner(input.owner) || !sameOwner(grant.owner, input.owner) || !sameOwner(task.owner, input.owner)) {
    return { state: consumedState, decision: { allowed: false, reason: 'wrong_owner' } }
  }
  if (input.argumentsDigest !== grant.argumentsDigest || task.argumentsDigest !== grant.argumentsDigest) {
    return { state: consumedState, decision: { allowed: false, reason: 'arguments_changed' } }
  }
  if (!input.scope || !sameGrantScope(grant.scope, input.scope)) {
    return { state: consumedState, decision: { allowed: false, reason: 'wrong_scope' } }
  }
  if (task.status === 'uncertain')
    return { state: consumedState, decision: { allowed: false, reason: 'uncertain_requires_reconciliation' } }
  if (task.status !== 'ready') return { state: consumedState, decision: { allowed: false, reason: 'task_not_ready' } }
  const chain = lineage(state, task)
  // One active step per lineage: a helper never runs beside its parent or a sibling.
  if (lineageHasActiveStep(state, chain, task.taskId)) {
    return { state: consumedState, decision: { allowed: false, reason: 'step_active' } }
  }
  // The call budget is charged at admission, so a failed attempt can never refill it.
  if (!chargeFits(chain, grant.scope.resources)) {
    return { state: consumedState, decision: { allowed: false, reason: 'budget_exceeded' } }
  }
  const dispatching = snapshotTask({
    ...task,
    status: 'dispatching' as const,
    activeAttemptId: input.attemptId,
    lastAttemptId: input.attemptId,
    effectOutcome: undefined
  })
  const tasks = new Map(consumedState.tasks)
  tasks.set(task.taskId, dispatching)
  chargeLineage(tasks, chain, grant.scope.resources)
  const attempts = new Map(consumedState.attempts)
  const attempt = snapshotAttempt({
    attemptId: input.attemptId,
    taskId: task.taskId,
    taskRevision: task.revision,
    grantId: grant.grantId,
    owner: grant.owner,
    argumentsDigest: grant.argumentsDigest,
    scope: grant.scope,
    authorizedAt: input.now,
    status: 'authorized'
  })
  attempts.set(attempt.attemptId, attempt)
  return {
    state: { ...consumedState, tasks, attempts },
    decision: {
      allowed: true,
      task: tasks.get(task.taskId) ?? dispatching,
      leaseExpiresAt: Math.min(grant.expiresAt, task.expiresAt)
    }
  }
}

export function pauseTask(state: TaskRuntimeState, taskId: string): TransitionResult {
  const task = state.tasks.get(taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status === 'cancelled' || task.status === 'completed') return deny(state, 'invalid_transition')
  return allow(invalidateSubtree(state, taskId, 'paused'))
}

export function resumeTask(state: TaskRuntimeState, taskId: string): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const task = state.tasks.get(taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status !== 'paused') return deny(state, 'invalid_transition')
  const tasks = new Map(state.tasks)
  const status = task.effectOutcome === 'uncertain' ? 'uncertain' : 'ready'
  tasks.set(taskId, snapshotTask({ ...task, status }))
  return allow({ ...state, tasks })
}

export function cancelTask(state: TaskRuntimeState, taskId: string): TransitionResult {
  const task = state.tasks.get(taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status === 'completed' || task.status === 'cancelled') return deny(state, 'invalid_transition')
  return allow(invalidateSubtree(state, taskId, 'cancelled'))
}

export function recordEffectOutcome(
  state: TaskRuntimeState,
  taskId: string,
  attemptId: string,
  outcome: 'applied' | 'not-applied' | 'uncertain'
): TransitionResult {
  const task = state.tasks.get(taskId)
  const attempt = state.attempts.get(attemptId)
  if (!task) return deny(state, 'unknown_task')
  if (
    !attempt ||
    attempt.taskId !== taskId ||
    attempt.status !== 'authorized' ||
    task.status !== 'dispatching' ||
    task.activeAttemptId !== attemptId
  )
    return deny(state, 'invalid_transition')
  const tasks = new Map(state.tasks)
  if (outcome === 'not-applied' && !Number.isSafeInteger(task.revision + 1)) return deny(state, 'invalid_input')
  const attempts = new Map(state.attempts)
  attempts.set(
    attemptId,
    snapshotAttempt({ ...attempt, status: outcome === 'uncertain' ? 'uncertain' : 'settled', outcome })
  )
  if (outcome === 'applied' && task.multiStep === true) {
    // A verified step of a multi-step task returns to the boundary. Helpers and the budget carry on.
    tasks.set(
      taskId,
      snapshotTask({
        ...task,
        status: 'ready',
        effectOutcome: undefined,
        activeAttemptId: undefined,
        stepsCompleted: (task.stepsCompleted ?? 0) + 1
      })
    )
    return allow({ ...state, tasks, attempts })
  }
  if (outcome === 'applied')
    tasks.set(
      taskId,
      snapshotTask({ ...task, status: 'completed', effectOutcome: outcome, activeAttemptId: undefined })
    )
  else if (outcome === 'uncertain')
    tasks.set(
      taskId,
      snapshotTask({ ...task, status: 'uncertain', effectOutcome: outcome, activeAttemptId: undefined })
    )
  else
    tasks.set(
      taskId,
      snapshotTask({
        ...task,
        status: 'ready',
        revision: task.revision + 1,
        effectOutcome: outcome,
        activeAttemptId: undefined
      })
    )
  return allow(cancelDescendants({ ...state, tasks, attempts }, taskId))
}

/** An uncertain external effect cannot be retried until a caller supplies an explicit reconciliation. */
export function reconcileUncertainEffect(
  state: TaskRuntimeState,
  taskId: string,
  outcome: 'applied' | 'not-applied'
): TransitionResult {
  const task = state.tasks.get(taskId)
  if (!task) return deny(state, 'unknown_task')
  const cancelled = task.status === 'cancelled'
  const paused = task.status === 'paused'
  if ((task.status !== 'uncertain' && !cancelled && !paused) || task.effectOutcome !== 'uncertain')
    return deny(state, 'invalid_transition')
  const attempt = task.lastAttemptId ? state.attempts.get(task.lastAttemptId) : undefined
  if (!attempt || attempt.taskId !== taskId || attempt.status !== 'uncertain' || attempt.outcome !== 'uncertain') {
    return deny(state, 'invalid_transition')
  }
  const attempts = new Map(state.attempts)
  attempts.set(attempt.attemptId, snapshotAttempt({ ...attempt, status: 'reconciled', outcome }))
  if (outcome === 'applied') {
    const tasks = new Map(state.tasks)
    if (task.multiStep === true && !cancelled) {
      tasks.set(
        taskId,
        snapshotTask({
          ...task,
          status: paused ? 'paused' : 'ready',
          effectOutcome: undefined,
          stepsCompleted: (task.stepsCompleted ?? 0) + 1
        })
      )
      return allow({ ...state, tasks, attempts })
    }
    tasks.set(
      taskId,
      snapshotTask({ ...task, status: cancelled ? 'cancelled' : 'completed', effectOutcome: 'applied' })
    )
    return allow(cancelDescendants({ ...state, tasks, attempts }, taskId))
  }
  if (!cancelled && !Number.isSafeInteger(task.revision + 1)) return deny(state, 'invalid_input')
  const tasks = new Map(state.tasks)
  tasks.set(
    taskId,
    snapshotTask({
      ...task,
      status: cancelled ? 'cancelled' : paused ? 'paused' : 'ready',
      ...(!cancelled ? { revision: task.revision + 1 } : {}),
      effectOutcome: 'not-applied'
    })
  )
  return allow(cancelDescendants({ ...state, tasks, attempts }, taskId))
}
