import type { TaskOwner, TaskRecord, TaskRuntimeState, TransitionResult } from './task-contract'
import {
  allow,
  cancelDescendants,
  deny,
  descendants,
  isMetered,
  lineage,
  remainingBudget,
  revokeGrants,
  sameOwner,
  snapshotTask,
  validOwner
} from './task-state-internal'

/** Steering revises the plan at a safe boundary: revision bump, planning state, every grant and helper revoked. */
export function steerTask(
  state: TaskRuntimeState,
  input: { taskId: string; revision: number; argumentsDigest: string }
): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const task = state.tasks.get(input.taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status === 'completed' || task.status === 'cancelled') return deny(state, 'invalid_transition')
  if (task.status === 'dispatching') return deny(state, 'step_active')
  if (task.status === 'uncertain' || task.effectOutcome === 'uncertain') {
    return deny(state, 'uncertain_requires_reconciliation')
  }
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision <= task.revision ||
    typeof input.argumentsDigest !== 'string' ||
    !input.argumentsDigest
  ) {
    return deny(state, 'invalid_input')
  }
  for (const id of descendants(state.tasks, task.taskId)) {
    if (id !== task.taskId && state.tasks.get(id)?.status === 'dispatching') return deny(state, 'step_active')
  }
  const next = cancelDescendants(revokeGrants(state, new Set([task.taskId])), task.taskId)
  const tasks = new Map(next.tasks)
  tasks.set(
    task.taskId,
    snapshotTask({
      ...task,
      status: 'planning',
      revision: input.revision,
      argumentsDigest: input.argumentsDigest,
      effectOutcome: undefined
    })
  )
  return allow({ ...next, tasks })
}

/** Billing suspension at a step boundary. Grants, revision and consumed budget are kept as they are. */
export function pauseTaskForQuota(state: TaskRuntimeState, taskId: string): TransitionResult {
  const task = state.tasks.get(taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status === 'dispatching') return deny(state, 'step_active')
  if (task.status !== 'ready') return deny(state, 'invalid_transition')
  const tasks = new Map(state.tasks)
  tasks.set(taskId, snapshotTask({ ...task, status: 'quota_paused' }))
  return allow({ ...state, tasks })
}

/**
 * Only the trusted quota controller calls this, after its own billing and entitlement checks. It resumes the
 * exact task: the revision and consumed budget are untouched, and a revoked or expired authority stays revoked.
 */
export function resumeAfterQuota(
  state: TaskRuntimeState,
  input: { taskId: string; owner: TaskOwner; now: number }
): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const task = state.tasks.get(input.taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.status !== 'quota_paused') return deny(state, 'invalid_transition')
  if (!Number.isFinite(input.now) || !validOwner(input.owner)) return deny(state, 'invalid_input')
  if (!sameOwner(task.owner, input.owner)) return deny(state, 'wrong_owner')
  if (input.now >= task.expiresAt) return deny(state, 'task_expired')
  const chain = lineage(state, task)
  const parent = chain[1]
  if (
    parent &&
    (!['ready', 'dispatching'].includes(parent.status) ||
      parent.revision !== task.parentTaskRevision ||
      input.now >= parent.expiresAt)
  ) {
    return deny(state, 'parent_inactive')
  }
  // A resume never refills a budget: an exhausted lineage stays exhausted.
  const exhausted = chain.some((member) => {
    const left = Object.values(remainingBudget(member))
    return left.length > 0 && left.every((amount) => amount <= 0)
  })
  if (isMetered(chain) && exhausted) return deny(state, 'budget_exceeded')
  const tasks = new Map(state.tasks)
  tasks.set(task.taskId, snapshotTask({ ...task, status: 'ready' }))
  return allow({ ...state, tasks })
}

/** Explicit completion of a multi-step task at a step boundary. */
export function completeTask(state: TaskRuntimeState, taskId: string): TransitionResult {
  if (state.ownerRebindRequired) return deny(state, 'owner_rebind_required')
  const task = state.tasks.get(taskId)
  if (!task) return deny(state, 'unknown_task')
  if (task.multiStep !== true || task.status !== 'ready') return deny(state, 'invalid_transition')
  const next = cancelDescendants(revokeGrants(state, new Set([taskId])), taskId)
  const tasks = new Map(next.tasks)
  tasks.set(taskId, snapshotTask({ ...task, status: 'completed', effectOutcome: undefined }))
  return allow({ ...next, tasks })
}
