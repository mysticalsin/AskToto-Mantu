/** Pure helpers shared by the task transition modules. Nothing here is an entry point. */
import type { TrustedInputOwner } from '@shared/input-session'
import type {
  DispatchGrant,
  DispatchGrantScope,
  TaskAttempt,
  TaskOwner,
  TaskPolicy,
  TaskRecord,
  TaskRuntimeState,
  TaskScope,
  TaskTransitionDenial,
  TransitionResult
} from './task-contract'
import { cloneTaskRecoveryOwner } from './task-recovery-owner'

export const deny = (state: TaskRuntimeState, reason: TaskTransitionDenial): TransitionResult => ({
  ok: false,
  state,
  reason
})
export const allow = (state: TaskRuntimeState): TransitionResult => ({ ok: true, state })

export function snapshotOwner(owner: TaskOwner): TaskOwner {
  return Object.freeze({ ...owner })
}

export function snapshotScope(scope: TaskScope): TaskScope {
  return Object.freeze({
    capabilities: Object.freeze([...scope.capabilities]),
    resources: Object.freeze({ ...scope.resources })
  })
}

export function snapshotGrantScope(scope: DispatchGrantScope): DispatchGrantScope {
  return Object.freeze({ capability: scope.capability, resources: Object.freeze({ ...scope.resources }) })
}

export function snapshotTask(task: TaskRecord): TaskRecord {
  return Object.freeze({
    ...task,
    owner: snapshotOwner(task.owner),
    scope: snapshotScope(task.scope),
    ...(task.recoveryOwner ? { recoveryOwner: cloneTaskRecoveryOwner(task.recoveryOwner)! } : {}),
    ...(task.usedResources ? { usedResources: Object.freeze({ ...task.usedResources }) } : {})
  })
}

export function snapshotAttempt(attempt: TaskAttempt): TaskAttempt {
  return Object.freeze({ ...attempt, owner: snapshotOwner(attempt.owner), scope: snapshotGrantScope(attempt.scope) })
}

export function snapshotGrant(grant: DispatchGrant): DispatchGrant {
  return Object.freeze({ ...grant, owner: snapshotOwner(grant.owner), scope: snapshotGrantScope(grant.scope) })
}

export function validOwner(owner: TaskOwner): boolean {
  return (
    !!owner &&
    owner.isTopFrame === true &&
    Number.isSafeInteger(owner.webContentsId) &&
    owner.webContentsId > 0 &&
    typeof owner.frameId === 'string' &&
    owner.frameId.length > 0 &&
    owner.frameId.length <= 256 &&
    Number.isSafeInteger(owner.authSessionGeneration) &&
    owner.authSessionGeneration >= 0 &&
    Number.isSafeInteger(owner.contextRevision) &&
    owner.contextRevision >= 0
  )
}

export function sameOwner(a: TrustedInputOwner, b: TrustedInputOwner): boolean {
  return (
    a.webContentsId === b.webContentsId &&
    a.frameId === b.frameId &&
    a.isTopFrame === b.isTopFrame &&
    a.authSessionGeneration === b.authSessionGeneration &&
    a.contextRevision === b.contextRevision
  )
}

export function validPolicy(policy: TaskPolicy): boolean {
  return (
    !!policy &&
    Array.isArray(policy.allowedTaskTypes) &&
    Array.isArray(policy.allowedCapabilities) &&
    !!policy.resourceBudgets &&
    typeof policy.resourceBudgets === 'object' &&
    Number.isFinite(policy.maxRetentionMs) &&
    policy.maxRetentionMs >= 0 &&
    Number.isFinite(policy.maxGrantTtlMs) &&
    policy.maxGrantTtlMs > 0 &&
    policy.allowedTaskTypes.every((v) => typeof v === 'string' && v.length > 0) &&
    policy.allowedCapabilities.every((v) => typeof v === 'string' && v.length > 0) &&
    Object.entries(policy.resourceBudgets).every(
      ([key, value]) => key.length > 0 && Number.isFinite(value) && value >= 0
    )
  )
}

export function validScope(scope: TaskScope): boolean {
  return (
    !!scope &&
    Array.isArray(scope.capabilities) &&
    !!scope.resources &&
    typeof scope.resources === 'object' &&
    scope.capabilities.every((v) => typeof v === 'string' && v.length > 0) &&
    new Set(scope.capabilities).size === scope.capabilities.length &&
    Object.entries(scope.resources).every(([key, value]) => key.length > 0 && Number.isFinite(value) && value >= 0)
  )
}

export function budgetFits(
  requested: Readonly<Record<string, number>>,
  ceiling: Readonly<Record<string, number>>
): boolean {
  return Object.entries(requested).every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(ceiling, key) &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= ceiling[key]!
  )
}

export function grantScopeFits(scope: DispatchGrantScope, taskScope: TaskScope, policy: TaskPolicy): boolean {
  return (
    taskScope.capabilities.includes(scope.capability) &&
    policy.allowedCapabilities.includes(scope.capability) &&
    budgetFits(scope.resources, taskScope.resources) &&
    budgetFits(scope.resources, policy.resourceBudgets)
  )
}

export function sameRecord<T>(a: T, b: T): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, i) => key === rightKeys[i] && left[key] === right[key])
  )
}

export function sameGrantScope(a: DispatchGrantScope, b: DispatchGrantScope): boolean {
  return a.capability === b.capability && sameRecord(a.resources, b.resources)
}

export function sameCapabilitySet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((capability) => b.includes(capability))
}

export function childScopeStrictlyNarrower(child: TaskScope, parent: TaskScope): boolean {
  if (
    !validScope(child) ||
    !validScope(parent) ||
    !child.capabilities.every((cap) => parent.capabilities.includes(cap))
  )
    return false
  if (!budgetFits(child.resources, parent.resources)) return false
  const resourceKeys = Object.keys(child.resources)
  const parentKeys = Object.keys(parent.resources)
  const strict =
    !sameCapabilitySet(child.capabilities, parent.capabilities) ||
    resourceKeys.length < parentKeys.length ||
    Object.entries(child.resources).some(([key, value]) => value < parent.resources[key]!)
  return strict
}

export function descendants(tasks: ReadonlyMap<string, TaskRecord>, rootTaskId: string): Set<string> {
  const found = new Set<string>([rootTaskId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks.values()) {
      if (task.parentTaskId && found.has(task.parentTaskId) && !found.has(task.taskId)) {
        found.add(task.taskId)
        changed = true
      }
    }
  }
  return found
}

/** The task followed by each ancestor, nearest first. */
export function lineage(state: TaskRuntimeState, task: TaskRecord): TaskRecord[] {
  const chain = [task]
  const seen = new Set([task.taskId])
  let current = task
  while (current.parentTaskId) {
    const parent = state.tasks.get(current.parentTaskId)
    if (!parent || seen.has(parent.taskId)) break
    chain.push(parent)
    seen.add(parent.taskId)
    current = parent
  }
  return chain
}

export function remainingBudget(task: TaskRecord): Record<string, number> {
  const remaining: Record<string, number> = {}
  for (const [key, ceiling] of Object.entries(task.scope.resources)) {
    remaining[key] = Math.max(0, ceiling - (task.usedResources?.[key] ?? 0))
  }
  return remaining
}

/** Budget is metered only for a lineage that contains a multi-step task. Single-action tasks keep their old rules. */
export function isMetered(chain: readonly TaskRecord[]): boolean {
  return chain.some((task) => task.multiStep === true)
}

export function chargeFits(chain: readonly TaskRecord[], requested: Readonly<Record<string, number>>): boolean {
  return !isMetered(chain) || chain.every((task) => budgetFits(requested, remainingBudget(task)))
}

export function chargeLineage(
  tasks: Map<string, TaskRecord>,
  chain: readonly TaskRecord[],
  requested: Readonly<Record<string, number>>
): void {
  if (!isMetered(chain)) return
  for (const member of chain) {
    const current = tasks.get(member.taskId) ?? member
    const used: Record<string, number> = { ...(current.usedResources ?? {}) }
    for (const [key, amount] of Object.entries(requested)) used[key] = (used[key] ?? 0) + amount
    tasks.set(member.taskId, snapshotTask({ ...current, usedResources: used }))
  }
}

export function lineageHasActiveStep(
  state: TaskRuntimeState,
  chain: readonly TaskRecord[],
  exceptTaskId: string
): boolean {
  // Legacy single-action lineages keep their rules; only a metered (multi-step) lineage is serialised.
  if (!isMetered(chain)) return false
  const root = chain[chain.length - 1]!
  for (const id of descendants(state.tasks, root.taskId)) {
    if (id !== exceptTaskId && state.tasks.get(id)?.status === 'dispatching') return true
  }
  return false
}

export function revokeGrants(state: TaskRuntimeState, taskIds: Set<string>): TaskRuntimeState {
  const grants = new Map(state.grants)
  for (const [id, grant] of grants) if (taskIds.has(grant.taskId)) grants.delete(id)
  return { ...state, grants }
}

export function cancelDescendants(state: TaskRuntimeState, rootTaskId: string): TaskRuntimeState {
  const ids = descendants(state.tasks, rootTaskId)
  ids.delete(rootTaskId)
  const next = revokeGrants(state, ids)
  const tasks = new Map(next.tasks)
  const attempts = new Map(next.attempts)
  for (const id of ids) {
    const child = tasks.get(id)
    if (!child || child.status === 'completed' || child.status === 'cancelled') continue
    if (child.status === 'dispatching' && child.activeAttemptId) {
      const attempt = attempts.get(child.activeAttemptId)
      if (attempt?.status === 'authorized')
        attempts.set(attempt.attemptId, snapshotAttempt({ ...attempt, status: 'uncertain', outcome: 'uncertain' }))
    }
    tasks.set(
      id,
      snapshotTask({
        ...child,
        status: 'cancelled',
        ...(child.status === 'dispatching' ? { effectOutcome: 'uncertain' as const, activeAttemptId: undefined } : {})
      })
    )
  }
  return { ...next, tasks, attempts }
}

export function invalidateSubtree(
  state: TaskRuntimeState,
  rootTaskId: string,
  status: 'paused' | 'cancelled'
): TaskRuntimeState {
  const ids = descendants(state.tasks, rootTaskId)
  const next = revokeGrants(state, ids)
  const tasks = new Map(next.tasks)
  const attempts = new Map(next.attempts)
  for (const id of ids) {
    const task = tasks.get(id)
    if (!task || task.status === 'completed' || task.status === 'cancelled') continue
    if (task.status === 'dispatching' && task.activeAttemptId) {
      const attempt = attempts.get(task.activeAttemptId)
      if (attempt?.status === 'authorized')
        attempts.set(attempt.attemptId, snapshotAttempt({ ...attempt, status: 'uncertain', outcome: 'uncertain' }))
    }
    tasks.set(
      id,
      snapshotTask({
        ...task,
        // A planning task holds no authority, so pausing it must not let a resume skip its approval.
        status: task.status === 'planning' && status === 'paused' ? 'planning' : status,
        // A dispatched effect may already have happened. Pause/cancel never claims to roll it back.
        ...(task.status === 'dispatching' ? { effectOutcome: 'uncertain' as const, activeAttemptId: undefined } : {})
      })
    )
  }
  return { ...next, tasks, attempts }
}
