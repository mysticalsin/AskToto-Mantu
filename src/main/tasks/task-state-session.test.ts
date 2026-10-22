import { describe, expect, it } from 'vitest'
import type { DispatchGrantScope, TaskDefinition, TaskOwner, TaskPolicy, TaskRuntimeState } from './task-contract'
import {
  authorizeDispatch,
  cancelTask,
  completeTask,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  pauseTask,
  pauseTaskForQuota,
  recordEffectOutcome,
  reconcileUncertainEffect,
  resumeAfterQuota,
  resumeTask,
  reviseTask,
  steerTask,
  TaskStepLeases
} from './task-state'

const owner: TaskOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 4,
  contextRevision: 9
}

const policy: TaskPolicy = {
  allowedTaskTypes: ['research'],
  allowedCapabilities: ['read', 'write'],
  resourceBudgets: { calls: 8 },
  maxRetentionMs: 60_000,
  maxGrantTtlMs: 5_000
}

const readStep: DispatchGrantScope = { capability: 'read', resources: { calls: 1 } }

function def(taskId: string, overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskId,
    revision: 1,
    taskType: 'research',
    owner,
    argumentsDigest: `sha256:${taskId}`,
    scope: { capabilities: ['read', 'write'], resources: { calls: 3 } },
    createdAt: 100,
    retentionMs: 10_000,
    ...overrides
  }
}

function must(result: { ok: boolean; state: TaskRuntimeState; reason?: string }): TaskRuntimeState {
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  return result.state
}

function create(state: TaskRuntimeState, taskId: string, overrides: Partial<TaskDefinition> = {}, planning = false) {
  return createTask(state, def(taskId, overrides), policy, planning ? { initialStatus: 'planning' } : undefined)
}

function issue(state: TaskRuntimeState, taskId: string, grantId: string, scope = readStep, now = 200) {
  return issueDispatchGrant(state, { taskId, grantId, scope, now, ttlMs: 1_000, policy })
}

function authorize(state: TaskRuntimeState, taskId: string, grantId: string, attemptId: string, scope = readStep) {
  const task = state.tasks.get(taskId)!
  return authorizeDispatch(state, {
    grantId,
    attemptId,
    taskId,
    taskRevision: task.revision,
    owner,
    argumentsDigest: task.argumentsDigest,
    scope,
    now: 201
  })
}

/** Issue and authorize one step, returning the dispatching state. */
function startStep(state: TaskRuntimeState, taskId: string, id: string, scope = readStep): TaskRuntimeState {
  const issued = must(issue(state, taskId, `grant-${id}`, scope))
  const authorized = authorize(issued, taskId, `grant-${id}`, `attempt-${id}`, scope)
  expect(authorized.decision).toMatchObject({ allowed: true })
  return authorized.state
}

describe('planning state', () => {
  it('holds no authority until an approval makes the task ready', () => {
    const state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }, true))
    expect(state.tasks.get('task-a')?.status).toBe('planning')
    expect(issue(state, 'task-a', 'g1')).toMatchObject({ ok: false, reason: 'task_not_ready' })

    const approved = must(
      reviseTask(state, {
        taskId: 'task-a',
        revision: 2,
        argumentsDigest: 'sha256:approved',
        scope: { capabilities: ['read'], resources: { calls: 2 } },
        policy
      })
    )
    expect(approved.tasks.get('task-a')).toMatchObject({ status: 'ready', revision: 2 })
    must(issue(approved, 'task-a', 'g2'))
  })

  it('refuses a helper that starts in planning', () => {
    const parent = must(create(createTaskRuntimeState(), 'parent', { multiStep: true }))
    const child = create(
      parent,
      'child',
      {
        parentTaskId: 'parent',
        parentTaskRevision: 1,
        scope: { capabilities: ['read'], resources: { calls: 1 } }
      },
      true
    )
    expect(child).toMatchObject({ ok: false, reason: 'invalid_input' })
  })

  it('treats pause of a planning task as a no-op that cannot skip approval on resume', () => {
    const planning = must(create(createTaskRuntimeState(), 'task-a', {}, true))
    const paused = must(pauseTask(planning, 'task-a'))
    expect(paused.tasks.get('task-a')?.status).toBe('planning')
    expect(resumeTask(paused, 'task-a')).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })
})

describe('multi-step tasks and the shared call budget', () => {
  it('returns to ready after a verified step and charges the budget at admission', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    state = startStep(state, 'task-a', '1')
    expect(state.tasks.get('task-a')?.usedResources).toEqual({ calls: 1 })
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    expect(state.tasks.get('task-a')).toMatchObject({ status: 'ready', revision: 1, stepsCompleted: 1 })
    state = startStep(state, 'task-a', '2')
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-2', 'applied'))
    expect(state.tasks.get('task-a')).toMatchObject({ status: 'ready', stepsCompleted: 2, usedResources: { calls: 2 } })
  })

  it('never refills the budget after an unsuccessful attempt', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true, scope: scopeCalls(1) }))
    state = startStep(state, 'task-a', '1')
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'not-applied'))
    expect(state.tasks.get('task-a')?.usedResources).toEqual({ calls: 1 })
    expect(issue(state, 'task-a', 'grant-again')).toMatchObject({ ok: false, reason: 'budget_exceeded' })
  })

  it('allows exactly one active step per task and per lineage', () => {
    let state = must(create(createTaskRuntimeState(), 'parent', { multiStep: true }))
    state = must(
      create(state, 'helper', {
        parentTaskId: 'parent',
        parentTaskRevision: 1,
        scope: { capabilities: ['read'], resources: { calls: 2 } }
      })
    )
    const helperGrant = must(issue(state, 'helper', 'grant-helper'))
    const parentStep = startStep(helperGrant, 'parent', 'p')
    const blocked = authorize(parentStep, 'helper', 'grant-helper', 'attempt-helper')
    expect(blocked.decision).toEqual({ allowed: false, reason: 'step_active' })
    expect(authorize(parentStep, 'parent', 'grant-other', 'attempt-other').decision).toMatchObject({ allowed: false })
  })

  it('completes a multi-step task explicitly and only from a ready boundary', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    state = startStep(state, 'task-a', '1')
    expect(completeTask(state, 'task-a')).toMatchObject({ ok: false, reason: 'invalid_transition' })
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    const done = must(completeTask(state, 'task-a'))
    expect(done.tasks.get('task-a')?.status).toBe('completed')
    expect(completeTask(done, 'task-a')).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('keeps single-action behaviour: an applied effect completes the task and meters nothing', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a'))
    state = startStep(state, 'task-a', '1')
    expect(state.tasks.get('task-a')?.usedResources).toBeUndefined()
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    expect(state.tasks.get('task-a')?.status).toBe('completed')
    expect(completeTask(state, 'task-a')).toMatchObject({ ok: false })
  })

  it('returns a reconciled applied step to ready for a multi-step task', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    state = startStep(state, 'task-a', '1')
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'uncertain'))
    expect(issue(state, 'task-a', 'blocked')).toMatchObject({ ok: false })
    state = must(reconcileUncertainEffect(state, 'task-a', 'applied'))
    expect(state.tasks.get('task-a')).toMatchObject({ status: 'ready', stepsCompleted: 1 })
    expect(state.tasks.get('task-a')?.effectOutcome).toBeUndefined()
  })
})

describe('delegation is a subset with a shared budget', () => {
  const helperScope = { capabilities: ['read'], resources: { calls: 2 } }

  function withParent(calls: number): TaskRuntimeState {
    return must(create(createTaskRuntimeState(), 'parent', { multiStep: true, scope: scopeCalls(calls) }))
  }

  function helper(state: TaskRuntimeState, id: string, scope = helperScope) {
    return create(state, id, { parentTaskId: 'parent', parentTaskRevision: 1, scope })
  }

  it('refuses a helper that broadens the parent scope', () => {
    const narrow = must(
      create(createTaskRuntimeState(), 'parent', { scope: { capabilities: ['read'], resources: { calls: 3 } } })
    )
    expect(helper(narrow, 'wide', { capabilities: ['read', 'write'], resources: { calls: 1 } })).toMatchObject({
      ok: false,
      reason: 'scope_not_subset'
    })
  })

  it('refuses a helper budget above what the parent has left', () => {
    let state = withParent(2)
    state = startStep(state, 'parent', 'p')
    state = must(recordEffectOutcome(state, 'parent', 'attempt-p', 'applied'))
    expect(helper(state, 'h1', { capabilities: ['read'], resources: { calls: 2 } })).toMatchObject({
      ok: false,
      reason: 'budget_exceeded'
    })
    must(helper(state, 'h1', { capabilities: ['read'], resources: { calls: 1 } }))
  })

  it('charges every helper against the parent, so separate helpers cannot exceed the total', () => {
    let state = withParent(2)
    state = must(helper(state, 'h1'))
    state = must(helper(state, 'h2'))
    state = must(helper(state, 'h3'))
    for (const id of ['h1', 'h2']) {
      state = startStep(state, id, id)
      state = must(recordEffectOutcome(state, id, `attempt-${id}`, 'applied'))
    }
    expect(state.tasks.get('parent')?.usedResources).toEqual({ calls: 2 })
    expect(state.tasks.get('h1')?.usedResources).toEqual({ calls: 1 })
    expect(issue(state, 'h3', 'grant-h3')).toMatchObject({ ok: false, reason: 'budget_exceeded' })
  })

  it('denies a helper step when the budget was spent after its grant was issued', () => {
    let state = withParent(1)
    state = must(helper(state, 'h1', { capabilities: ['read'], resources: { calls: 1 } }))
    state = must(helper(state, 'h2', { capabilities: ['read'], resources: { calls: 1 } }))
    state = must(issue(state, 'h1', 'grant-h1'))
    state = must(issue(state, 'h2', 'grant-h2'))
    const first = authorize(state, 'h1', 'grant-h1', 'attempt-h1')
    expect(first.decision).toMatchObject({ allowed: true })
    const settled = must(recordEffectOutcome(first.state, 'h1', 'attempt-h1', 'applied'))
    expect(authorize(settled, 'h2', 'grant-h2', 'attempt-h2').decision).toEqual({
      allowed: false,
      reason: 'budget_exceeded'
    })
  })
})

describe('quota_paused', () => {
  function readyMultiStep(calls = 3) {
    return must(create(createTaskRuntimeState(), 'task-a', { multiStep: true, scope: scopeCalls(calls) }))
  }

  it('pauses only at a step boundary and admits no work while paused', () => {
    let state = readyMultiStep()
    state = must(issue(state, 'task-a', 'early'))
    const active = authorize(state, 'task-a', 'early', 'attempt-a').state
    expect(pauseTaskForQuota(active, 'task-a')).toMatchObject({ ok: false, reason: 'step_active' })
    const settled = must(recordEffectOutcome(active, 'task-a', 'attempt-a', 'applied'))
    const paused = must(pauseTaskForQuota(settled, 'task-a'))
    expect(paused.tasks.get('task-a')?.status).toBe('quota_paused')
    expect(issue(paused, 'task-a', 'late')).toMatchObject({ ok: false, reason: 'task_not_ready' })
  })

  it('does not run a grant that was issued before the suspension', () => {
    let state = readyMultiStep()
    state = must(issue(state, 'task-a', 'early'))
    state = must(pauseTaskForQuota(state, 'task-a'))
    expect(authorize(state, 'task-a', 'early', 'attempt-a').decision).toEqual({
      allowed: false,
      reason: 'task_not_ready'
    })
  })

  it('resumes the exact task without refilling the budget or bumping the revision', () => {
    let state = readyMultiStep(2)
    state = startStep(state, 'task-a', '1')
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    state = must(pauseTaskForQuota(state, 'task-a'))
    const before = state.tasks.get('task-a')!
    state = must(resumeAfterQuota(state, { taskId: 'task-a', owner, now: 300 }))
    expect(state.tasks.get('task-a')).toMatchObject({
      status: 'ready',
      revision: before.revision,
      usedResources: { calls: 1 },
      stepsCompleted: 1
    })
  })

  it('cannot replenish an exhausted budget', () => {
    let state = readyMultiStep(1)
    state = startStep(state, 'task-a', '1')
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    state = must(pauseTaskForQuota(state, 'task-a'))
    expect(resumeAfterQuota(state, { taskId: 'task-a', owner, now: 300 })).toMatchObject({
      ok: false,
      reason: 'budget_exceeded'
    })
  })

  it('cannot revive an expired task or a task whose owner changed', () => {
    const paused = must(pauseTaskForQuota(readyMultiStep(), 'task-a'))
    expect(resumeAfterQuota(paused, { taskId: 'task-a', owner, now: 10_100 })).toMatchObject({
      ok: false,
      reason: 'task_expired'
    })
    expect(
      resumeAfterQuota(paused, { taskId: 'task-a', owner: { ...owner, contextRevision: 10 }, now: 300 })
    ).toMatchObject({ ok: false, reason: 'wrong_owner' })
  })

  it('treats a user pause during suspension as a revocation, not a billing suspension', () => {
    let state = readyMultiStep()
    state = must(issue(state, 'task-a', 'early'))
    state = must(pauseTaskForQuota(state, 'task-a'))
    state = must(pauseTask(state, 'task-a'))
    expect(state.tasks.get('task-a')?.status).toBe('paused')
    expect(state.grants.size).toBe(0)
    expect(resumeAfterQuota(state, { taskId: 'task-a', owner, now: 300 })).toMatchObject({
      ok: false,
      reason: 'invalid_transition'
    })
    const resumed = must(resumeTask(state, 'task-a'))
    expect(authorize(resumed, 'task-a', 'early', 'attempt-a').decision).toEqual({
      allowed: false,
      reason: 'grant_missing'
    })
  })

  it('keeps a helper blocked until its parent resumes', () => {
    let state = readyMultiStep()
    state = must(
      create(state, 'helper', {
        parentTaskId: 'task-a',
        parentTaskRevision: 1,
        scope: { capabilities: ['read'], resources: { calls: 1 } }
      })
    )
    state = must(issue(state, 'helper', 'grant-h'))
    state = must(pauseTaskForQuota(state, 'task-a'))
    expect(authorize(state, 'helper', 'grant-h', 'attempt-h').decision).toEqual({
      allowed: false,
      reason: 'parent_inactive'
    })
    expect(resumeAfterQuota(state, { taskId: 'task-a', owner, now: 300 })).toMatchObject({ ok: true })
  })

  it('can be cancelled while suspended', () => {
    const paused = must(pauseTaskForQuota(readyMultiStep(), 'task-a'))
    expect(must(cancelTask(paused, 'task-a')).tasks.get('task-a')?.status).toBe('cancelled')
  })
})

describe('steering', () => {
  const approvedScope = { capabilities: ['read'], resources: { calls: 2 } }

  it('moves to planning, bumps the revision, revokes grants and cancels helpers', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    state = must(create(state, 'helper', { parentTaskId: 'task-a', parentTaskRevision: 1, scope: approvedScope }))
    state = must(issue(state, 'task-a', 'grant-a'))
    state = must(steerTask(state, { taskId: 'task-a', revision: 2, argumentsDigest: 'sha256:steered' }))
    expect(state.tasks.get('task-a')).toMatchObject({
      status: 'planning',
      revision: 2,
      argumentsDigest: 'sha256:steered'
    })
    expect(state.tasks.get('helper')?.status).toBe('cancelled')
    expect(state.grants.size).toBe(0)
    expect(authorize(state, 'task-a', 'grant-a', 'attempt-a').decision).toEqual({
      allowed: false,
      reason: 'grant_missing'
    })
  })

  it('waits for a safe boundary: no steering during an active step or an unresolved effect', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    state = startStep(state, 'task-a', '1')
    const input = { taskId: 'task-a', revision: 2, argumentsDigest: 'sha256:steered' }
    expect(steerTask(state, input)).toMatchObject({ ok: false, reason: 'step_active' })
    const paused = must(pauseTask(state, 'task-a'))
    expect(steerTask(paused, input)).toMatchObject({ ok: false, reason: 'uncertain_requires_reconciliation' })
    const settled = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    expect(steerTask(settled, { ...input, revision: 1 })).toMatchObject({ ok: false, reason: 'invalid_input' })
    expect(steerTask(settled, { ...input, argumentsDigest: '' })).toMatchObject({ ok: false, reason: 'invalid_input' })
    must(steerTask(settled, input))
  })

  it('refuses to steer while a helper holds an active step', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    state = must(create(state, 'helper', { parentTaskId: 'task-a', parentTaskRevision: 1, scope: approvedScope }))
    state = startStep(state, 'helper', 'h')
    expect(steerTask(state, { taskId: 'task-a', revision: 2, argumentsDigest: 'sha256:steered' })).toMatchObject({
      ok: false,
      reason: 'step_active'
    })
  })

  it('needs a fresh approval after steering, and the approval opens a fresh budget', () => {
    let state = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true, scope: scopeCalls(2) }))
    state = startStep(state, 'task-a', '1')
    state = must(recordEffectOutcome(state, 'task-a', 'attempt-1', 'applied'))
    state = must(steerTask(state, { taskId: 'task-a', revision: 2, argumentsDigest: 'sha256:steered' }))
    expect(issue(state, 'task-a', 'grant-x')).toMatchObject({ ok: false, reason: 'task_not_ready' })
    state = must(
      reviseTask(state, {
        taskId: 'task-a',
        revision: 3,
        argumentsDigest: 'sha256:approved',
        scope: scopeCalls(2),
        policy
      })
    )
    expect(state.tasks.get('task-a')).toMatchObject({ status: 'ready', revision: 3, stepsCompleted: 1 })
    expect(state.tasks.get('task-a')?.usedResources).toBeUndefined()
  })

  it('allows steering a suspended or paused task', () => {
    const input = { taskId: 'task-a', revision: 2, argumentsDigest: 'sha256:steered' }
    const base = must(create(createTaskRuntimeState(), 'task-a', { multiStep: true }))
    expect(must(steerTask(must(pauseTaskForQuota(base, 'task-a')), input)).tasks.get('task-a')?.status).toBe('planning')
    expect(must(steerTask(must(pauseTask(base, 'task-a')), input)).tasks.get('task-a')?.status).toBe('planning')
    expect(steerTask(must(cancelTask(base, 'task-a')), input)).toMatchObject({
      ok: false,
      reason: 'invalid_transition'
    })
    expect(steerTask(base, { ...input, taskId: 'missing' })).toMatchObject({ ok: false, reason: 'unknown_task' })
  })
})

describe('step lease with an AbortSignal', () => {
  function dispatching(multiStep = true) {
    const state = must(create(createTaskRuntimeState(), 'task-a', { multiStep }))
    const issued = must(issue(state, 'task-a', 'grant-a'))
    const authorized = authorize(issued, 'task-a', 'grant-a', 'attempt-a')
    if (!authorized.decision.allowed) throw new Error('expected an allowed decision')
    return { state: authorized.state, decision: authorized.decision }
  }

  it('opens a live lease bound to the attempt and expires with the grant', () => {
    const { state, decision } = dispatching()
    expect(decision.leaseExpiresAt).toBe(1_200)
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    expect(lease).toMatchObject({ attemptId: 'attempt-a', taskId: 'task-a', taskRevision: 1, expiresAt: 1_200 })
    expect(lease.signal.aborted).toBe(false)
    expect(leases.assertCurrent(state, lease, 300)).toEqual({ ok: true })
    expect(Object.isFrozen(lease)).toBe(true)
  })

  it('aborts when the task is paused, cancelled or steered out from under the step', () => {
    for (const transition of [pauseTask, cancelTask]) {
      const { state, decision } = dispatching()
      const leases = new TaskStepLeases()
      const lease = leases.open(decision.task, decision.leaseExpiresAt)
      const next = must(transition(state, 'task-a'))
      expect(leases.sync(next, 300)).toEqual(['attempt-a'])
      expect(lease.signal.aborted).toBe(true)
      expect(lease.signal.reason).toBe('revoked')
      expect(leases.assertCurrent(next, lease, 300)).toEqual({ ok: false, reason: 'lease_stale' })
    }
  })

  it('aborts with the expired reason once the deadline passes, without a timer', () => {
    const { state, decision } = dispatching()
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    expect(leases.assertCurrent(state, lease, 1_200)).toEqual({ ok: false, reason: 'lease_stale' })
    expect(lease.signal.aborted).toBe(true)
    expect(lease.signal.reason).toBe('expired')
  })

  it('releases without aborting after a verified settle', () => {
    const { state, decision } = dispatching()
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    const settled = must(recordEffectOutcome(state, 'task-a', 'attempt-a', 'applied'))
    expect(leases.sync(settled, 300)).toEqual([])
    expect(lease.signal.aborted).toBe(false)
    expect(leases.size).toBe(0)
  })

  it('aborts when the effect outcome is uncertain', () => {
    const { state, decision } = dispatching()
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    const settled = must(recordEffectOutcome(state, 'task-a', 'attempt-a', 'uncertain'))
    expect(leases.sync(settled, 300)).toEqual(['attempt-a'])
    expect(lease.signal.aborted).toBe(true)
  })

  it('does not honour a copied or forged lease and opens each attempt only once', () => {
    const { state, decision } = dispatching()
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    expect(leases.assertCurrent(state, { ...lease }, 300)).toEqual({ ok: false, reason: 'lease_stale' })
    expect(() => leases.open(decision.task, decision.leaseExpiresAt)).toThrow(/already open/)
    expect(() => leases.open({ ...decision.task, status: 'ready' }, 500)).toThrow(/dispatching/)
  })

  it('aborts every lease when a recovered state carries the owner fence', () => {
    const { state, decision } = dispatching()
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    expect(leases.sync({ ...state, ownerRebindRequired: true }, 300)).toEqual(['attempt-a'])
    expect(lease.signal.aborted).toBe(true)
  })

  it('aborts all open leases on demand', () => {
    const { decision } = dispatching()
    const leases = new TaskStepLeases()
    const lease = leases.open(decision.task, decision.leaseExpiresAt)
    leases.abortAll()
    expect(lease.signal.aborted).toBe(true)
    expect(leases.size).toBe(0)
  })
})

function scopeCalls(calls: number) {
  return { capabilities: ['read', 'write'], resources: { calls } }
}
