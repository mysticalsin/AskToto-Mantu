import { describe, expect, it } from 'vitest'
import type { DispatchGrantScope, TaskDefinition, TaskOwner, TaskPolicy, TaskScope } from './task-contract'
import {
  authorizeDispatch,
  cancelTask,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  pauseTask,
  reviseTask,
  reconcileUncertainEffect,
  recordEffectOutcome,
  resumeTask
} from './task-state'

const owner: TaskOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 4,
  contextRevision: 9
}

const policy: TaskPolicy = {
  allowedTaskTypes: ['connector-read', 'connector-write'],
  allowedCapabilities: ['read', 'write'],
  resourceBudgets: { calls: 8, bytes: 2_000 },
  maxRetentionMs: 60_000,
  maxGrantTtlMs: 5_000
}

const parentScope: TaskScope = { capabilities: ['read', 'write'], resources: { calls: 4, bytes: 1_000 } }
const exactScope: DispatchGrantScope = { capability: 'read', resources: { calls: 1, bytes: 100 } }

function createReadyTask(taskId = 'task-a', scope: TaskScope = parentScope) {
  const definition: TaskDefinition = {
    taskId,
    revision: 1,
    taskType: 'connector-read',
    owner,
    argumentsDigest: 'sha256:args-a',
    scope,
    createdAt: 100,
    retentionMs: 10_000
  }
  const result = createTask(createTaskRuntimeState(), definition, policy)
  expect(result.ok).toBe(true)
  return result.state
}

function grant(
  state: ReturnType<typeof createTaskRuntimeState>,
  overrides: Partial<{
    grantId: string
    now: number
    ttlMs: number
    scope: DispatchGrantScope
  }> = {}
) {
  return issueDispatchGrant(state, {
    taskId: 'task-a',
    grantId: overrides.grantId ?? 'grant-a',
    scope: overrides.scope ?? exactScope,
    now: overrides.now ?? 200,
    ttlMs: overrides.ttlMs ?? 1_000,
    policy
  })
}

function consumeGrant(
  state: ReturnType<typeof createTaskRuntimeState>,
  overrides: Partial<{
    grantId: string
    attemptId: string
    taskRevision: number
    owner: typeof owner
    argumentsDigest: string
    scope: DispatchGrantScope
    now: number
  }> = {}
) {
  return authorizeDispatch(state, {
    grantId: overrides.grantId ?? 'grant-a',
    attemptId: overrides.attemptId ?? 'attempt-a',
    taskId: 'task-a',
    taskRevision: overrides.taskRevision ?? 1,
    owner: overrides.owner ?? owner,
    argumentsDigest: overrides.argumentsDigest ?? 'sha256:args-a',
    scope: overrides.scope ?? exactScope,
    now: overrides.now ?? 201
  })
}

describe('main-only task and attempt transitions', () => {
  it('issues and consumes an exact single-use grant, then rejects replay', () => {
    const issued = grant(createReadyTask())
    expect(issued.ok).toBe(true)
    const consumed = consumeGrant(issued.state)
    expect(consumed.decision).toMatchObject({
      allowed: true,
      task: { status: 'dispatching', activeAttemptId: 'attempt-a' }
    })
    expect(consumed.state.attempts.get('attempt-a')).toMatchObject({ status: 'authorized', taskRevision: 1 })
    expect(consumeGrant(consumed.state).decision).toEqual({ allowed: false, reason: 'grant_replayed' })
  })

  it('rejects an empty attempt id after consuming the presented grant', () => {
    const issued = grant(createReadyTask())
    const invalid = authorizeDispatch(issued.state, {
      grantId: 'grant-a',
      attemptId: '',
      taskId: 'task-a',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:args-a',
      scope: exactScope,
      now: 201
    })
    expect(invalid.decision).toEqual({ allowed: false, reason: 'invalid_input' })
    expect(invalid.state.consumedGrantIds.has('grant-a')).toBe(true)
    expect(
      authorizeDispatch(invalid.state, {
        grantId: 'grant-a',
        attemptId: 'attempt-a',
        taskId: 'task-a',
        taskRevision: 1,
        owner,
        argumentsDigest: 'sha256:args-a',
        scope: exactScope,
        now: 202
      }).decision
    ).toEqual({ allowed: false, reason: 'grant_replayed' })
  })

  it('rejects expired grant/task, stale revision, changed args, wrong owner and altered scope before authorization', () => {
    const issued = grant(createReadyTask())
    expect(consumeGrant(issued.state, { now: 199 }).decision).toEqual({ allowed: false, reason: 'grant_not_yet_valid' })
    expect(consumeGrant(issued.state, { now: 1_200 }).decision).toEqual({ allowed: false, reason: 'grant_expired' })
    expect(consumeGrant(issued.state, { taskRevision: 2 }).decision).toEqual({
      allowed: false,
      reason: 'stale_task_revision'
    })
    expect(consumeGrant(issued.state, { argumentsDigest: 'sha256:changed' }).decision).toEqual({
      allowed: false,
      reason: 'arguments_changed'
    })
    expect(consumeGrant(issued.state, { owner: { ...owner, authSessionGeneration: 5 } }).decision).toEqual({
      allowed: false,
      reason: 'wrong_owner'
    })
    expect(
      consumeGrant(issued.state, { scope: { capability: 'write', resources: { calls: 1, bytes: 100 } } }).decision
    ).toEqual({ allowed: false, reason: 'wrong_scope' })

    const late = grant(createReadyTask(), { now: 10_050, ttlMs: 200 })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.reason).toBe('retention_exceeded')
  })

  it('requires explicit policy to admit a task and rejects task, capability, budget and retention excess', () => {
    const state = createTaskRuntimeState()
    const base: TaskDefinition = {
      taskId: 'task-a',
      revision: 1,
      taskType: 'connector-read',
      owner,
      argumentsDigest: 'sha256:args-a',
      scope: parentScope,
      createdAt: 100,
      retentionMs: 10_000
    }
    expect(createTask(state, { ...base, taskType: 'unlisted' }, policy)).toMatchObject({
      ok: false,
      reason: 'task_type_not_allowed'
    })
    expect(
      createTask(state, { ...base, scope: { capabilities: ['admin'], resources: { calls: 1 } } }, policy)
    ).toMatchObject({ ok: false, reason: 'capability_not_allowed' })
    expect(
      createTask(state, { ...base, scope: { capabilities: ['read'], resources: { calls: 9 } } }, policy)
    ).toMatchObject({ ok: false, reason: 'budget_exceeded' })
    expect(createTask(state, { ...base, retentionMs: 60_001 }, policy)).toMatchObject({
      ok: false,
      reason: 'retention_exceeded'
    })
  })

  it('requires child grants to narrow capability/resource scope and never exceed parent budgets', () => {
    const state = createReadyTask()
    const child: TaskDefinition = {
      taskId: 'child-a',
      revision: 1,
      taskType: 'connector-read',
      owner,
      argumentsDigest: 'sha256:child',
      scope: { capabilities: ['read'], resources: { calls: 2 } },
      createdAt: 110,
      retentionMs: 1_000,
      parentTaskId: 'task-a',
      parentTaskRevision: 1
    }
    const admitted = createTask(state, child, policy)
    expect(admitted.ok).toBe(true)
    expect(createTask(state, { ...child, taskId: 'child-equal', scope: parentScope }, policy)).toMatchObject({
      ok: false,
      reason: 'scope_not_subset'
    })
    expect(
      createTask(
        state,
        { ...child, taskId: 'child-wide', scope: { capabilities: ['read'], resources: { calls: 5 } } },
        policy
      )
    ).toMatchObject({ ok: false, reason: 'scope_not_subset' })
  })

  it('pause and cancel revoke unused grants and invalidate descendants', () => {
    let state = createReadyTask()
    const child: TaskDefinition = {
      taskId: 'child-a',
      revision: 1,
      taskType: 'connector-read',
      owner,
      argumentsDigest: 'sha256:child',
      scope: { capabilities: ['read'], resources: { calls: 2 } },
      createdAt: 110,
      retentionMs: 1_000,
      parentTaskId: 'task-a',
      parentTaskRevision: 1
    }
    const childCreated = createTask(state, child, policy)
    expect(childCreated.ok).toBe(true)
    state = childCreated.state
    const issued = grant(state)
    expect(issued.ok).toBe(true)
    state = issued.state
    const paused = pauseTask(state, 'task-a')
    expect(paused.state.grants.size).toBe(0)
    expect(paused.state.tasks.get('task-a')?.status).toBe('paused')
    expect(paused.state.tasks.get('child-a')?.status).toBe('paused')
    const resumed = resumeTask(paused.state, 'task-a')
    expect(resumed.state.tasks.get('task-a')?.status).toBe('ready')
    expect(resumed.state.tasks.get('child-a')?.status).toBe('paused')
    const cancelled = cancelTask(resumed.state, 'task-a')
    expect(cancelled.state.tasks.get('task-a')?.status).toBe('cancelled')
    expect(cancelled.state.tasks.get('child-a')?.status).toBe('cancelled')
  })

  it('settling a parent cancels descendants and removes their unused grants', () => {
    let state = createReadyTask()
    const child = createTask(
      state,
      {
        taskId: 'child-a',
        revision: 1,
        taskType: 'connector-read',
        owner,
        argumentsDigest: 'sha256:child',
        scope: { capabilities: ['read'], resources: { calls: 2 } },
        createdAt: 110,
        retentionMs: 1_000,
        parentTaskId: 'task-a',
        parentTaskRevision: 1
      },
      policy
    )
    expect(child.ok).toBe(true)
    state = child.state
    const childGrant = issueDispatchGrant(state, {
      taskId: 'child-a',
      grantId: 'child-grant',
      scope: { capability: 'read', resources: { calls: 1 } },
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(childGrant.ok).toBe(true)
    const parentGrant = grant(childGrant.state)
    const parentAttempt = consumeGrant(parentGrant.state)
    expect(parentAttempt.decision.allowed).toBe(true)

    const settled = recordEffectOutcome(parentAttempt.state, 'task-a', 'attempt-a', 'applied')
    expect(settled.state.tasks.get('task-a')?.status).toBe('completed')
    expect(settled.state.tasks.get('child-a')?.status).toBe('cancelled')
    expect(settled.state.grants.has('child-grant')).toBe(false)
    expect(
      issueDispatchGrant(settled.state, {
        taskId: 'child-a',
        grantId: 'child-grant-2',
        scope: { capability: 'read', resources: { calls: 1 } },
        now: 201,
        ttlMs: 100,
        policy
      })
    ).toMatchObject({ ok: false, reason: 'task_not_ready' })
  })

  it('settling a parent makes an in-flight child uncertain, then reconciliation leaves it canceled', () => {
    const childCreated = createTask(
      createReadyTask(),
      {
        taskId: 'child-a',
        revision: 1,
        taskType: 'connector-read',
        owner,
        argumentsDigest: 'sha256:child',
        scope: { capabilities: ['read'], resources: { calls: 2 } },
        createdAt: 110,
        retentionMs: 1_000,
        parentTaskId: 'task-a',
        parentTaskRevision: 1
      },
      policy
    )
    expect(childCreated.ok).toBe(true)
    const childGrant = issueDispatchGrant(childCreated.state, {
      taskId: 'child-a',
      grantId: 'child-grant',
      scope: { capability: 'read', resources: { calls: 1 } },
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(childGrant.ok).toBe(true)
    const childAttempt = authorizeDispatch(childGrant.state, {
      grantId: 'child-grant',
      attemptId: 'child-attempt',
      taskId: 'child-a',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:child',
      scope: { capability: 'read', resources: { calls: 1 } },
      now: 201
    })
    expect(childAttempt.decision.allowed).toBe(true)

    const parentGrant = grant(childAttempt.state)
    const parentAttempt = consumeGrant(parentGrant.state)
    expect(parentAttempt.decision.allowed).toBe(true)
    const settled = recordEffectOutcome(parentAttempt.state, 'task-a', 'attempt-a', 'applied')
    expect(settled.state.tasks.get('child-a')).toMatchObject({ status: 'cancelled', effectOutcome: 'uncertain' })
    expect(settled.state.attempts.get('child-attempt')).toMatchObject({ status: 'uncertain', outcome: 'uncertain' })

    const reconciled = reconcileUncertainEffect(settled.state, 'child-a', 'not-applied')
    expect(reconciled.state.tasks.get('child-a')).toMatchObject({ status: 'cancelled', effectOutcome: 'not-applied' })
    expect(reconciled.state.attempts.get('child-attempt')).toMatchObject({
      status: 'reconciled',
      outcome: 'not-applied'
    })
    expect(
      issueDispatchGrant(reconciled.state, {
        taskId: 'child-a',
        grantId: 'child-grant-after-reconcile',
        scope: { capability: 'read', resources: { calls: 1 } },
        now: 202,
        ttlMs: 100,
        policy
      })
    ).toMatchObject({ ok: false, reason: 'task_not_ready' })
  })

  it('revising a parent cancels an in-flight child as uncertain and leaves it reconcilable', () => {
    const childCreated = createTask(
      createReadyTask(),
      {
        taskId: 'child-a',
        revision: 1,
        taskType: 'connector-read',
        owner,
        argumentsDigest: 'sha256:child',
        scope: { capabilities: ['read'], resources: { calls: 2 } },
        createdAt: 110,
        retentionMs: 1_000,
        parentTaskId: 'task-a',
        parentTaskRevision: 1
      },
      policy
    )
    expect(childCreated.ok).toBe(true)
    const childGrant = issueDispatchGrant(childCreated.state, {
      taskId: 'child-a',
      grantId: 'child-grant',
      scope: { capability: 'read', resources: { calls: 1 } },
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(childGrant.ok).toBe(true)
    const childAttempt = authorizeDispatch(childGrant.state, {
      grantId: 'child-grant',
      attemptId: 'child-attempt',
      taskId: 'child-a',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:child',
      scope: { capability: 'read', resources: { calls: 1 } },
      now: 201
    })
    expect(childAttempt.decision.allowed).toBe(true)

    const revised = reviseTask(childAttempt.state, {
      taskId: 'task-a',
      revision: 2,
      argumentsDigest: 'sha256:parent-revised',
      scope: parentScope,
      policy
    })
    expect(revised.ok).toBe(true)
    expect(revised.state.tasks.get('child-a')).toMatchObject({ status: 'cancelled', effectOutcome: 'uncertain' })
    expect(revised.state.attempts.get('child-attempt')).toMatchObject({ status: 'uncertain', outcome: 'uncertain' })
    expect(revised.state.grants.has('child-grant')).toBe(false)

    const reconciled = reconcileUncertainEffect(revised.state, 'child-a', 'applied')
    expect(reconciled.state.tasks.get('child-a')).toMatchObject({ status: 'cancelled', effectOutcome: 'applied' })
    expect(reconciled.state.attempts.get('child-attempt')).toMatchObject({ status: 'reconciled', outcome: 'applied' })
    expect(
      issueDispatchGrant(reconciled.state, {
        taskId: 'child-a',
        grantId: 'child-grant-after-reconcile',
        scope: { capability: 'read', resources: { calls: 1 } },
        now: 202,
        ttlMs: 100,
        policy
      })
    ).toMatchObject({ ok: false, reason: 'task_not_ready' })
  })

  it('snapshots owner and scope on create and revise', () => {
    const callerOwner = { ...owner }
    const createCapabilities = ['read']
    const createResources = { calls: 2 }
    const created = createTask(
      createTaskRuntimeState(),
      {
        taskId: 'mutable-task',
        revision: 1,
        taskType: 'connector-read',
        owner: callerOwner,
        argumentsDigest: 'sha256:mutable',
        scope: { capabilities: createCapabilities, resources: createResources },
        createdAt: 100,
        retentionMs: 1_000
      },
      policy
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    callerOwner.contextRevision = 99
    createCapabilities.push('write')
    createResources.calls = 99
    const createdTask = created.state.tasks.get('mutable-task')!
    expect(createdTask.owner.contextRevision).toBe(9)
    expect(createdTask.scope).toEqual({ capabilities: ['read'], resources: { calls: 2 } })
    expect(Object.isFrozen(createdTask)).toBe(true)
    expect(Object.isFrozen(createdTask.owner)).toBe(true)
    expect(Object.isFrozen(createdTask.scope.capabilities)).toBe(true)
    expect(Object.isFrozen(createdTask.scope.resources)).toBe(true)

    const reviseCapabilities = ['read']
    const reviseResources = { calls: 3 }
    const revised = reviseTask(created.state, {
      taskId: 'mutable-task',
      revision: 2,
      argumentsDigest: 'sha256:revised',
      scope: { capabilities: reviseCapabilities, resources: reviseResources },
      policy
    })
    expect(revised.ok).toBe(true)
    if (!revised.ok) return
    reviseCapabilities.push('write')
    reviseResources.calls = 88
    const revisedTask = revised.state.tasks.get('mutable-task')!
    expect(revisedTask.scope).toEqual({ capabilities: ['read'], resources: { calls: 3 } })
    expect(Object.isFrozen(revisedTask)).toBe(true)
    expect(Object.isFrozen(revisedTask.scope.resources)).toBe(true)

    const grantResources = { calls: 1 }
    const grantInput: DispatchGrantScope = { capability: 'read', resources: grantResources }
    const issued = issueDispatchGrant(createReadyTask(), {
      taskId: 'task-a',
      grantId: 'mutable-grant',
      scope: grantInput,
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    grantResources.calls = 77
    const storedGrant = issued.state.grants.get('mutable-grant')!
    expect(storedGrant.scope.resources.calls).toBe(1)
    expect(Object.isFrozen(storedGrant)).toBe(true)
    expect(Object.isFrozen(storedGrant.scope.resources)).toBe(true)

    const authorized = authorizeDispatch(issued.state, {
      grantId: 'mutable-grant',
      attemptId: 'mutable-attempt',
      taskId: 'task-a',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:args-a',
      scope: { capability: 'read', resources: { calls: 1 } },
      now: 201
    })
    expect(authorized.decision.allowed).toBe(true)
    const storedAttempt = authorized.state.attempts.get('mutable-attempt')!
    expect(storedAttempt.scope.resources.calls).toBe(1)
    expect(Object.isFrozen(storedAttempt)).toBe(true)
    expect(Object.isFrozen(storedAttempt.owner)).toBe(true)
    expect(Object.isFrozen(storedAttempt.scope.resources)).toBe(true)
  })

  it('marks uncertain effects non-retriable until explicit reconciliation', () => {
    const authorized = consumeGrant(grant(createReadyTask()).state)
    expect(authorized.decision.allowed).toBe(true)
    const uncertain = recordEffectOutcome(authorized.state, 'task-a', 'attempt-a', 'uncertain')
    expect(uncertain.state.tasks.get('task-a')?.status).toBe('uncertain')
    const newGrant = grant(uncertain.state, { grantId: 'grant-b' })
    expect(newGrant).toMatchObject({ ok: false, reason: 'task_not_ready' })
    expect(reconcileUncertainEffect(uncertain.state, 'task-a', 'not-applied').state.tasks.get('task-a')).toMatchObject({
      status: 'ready',
      revision: 2,
      effectOutcome: 'not-applied'
    })
    expect(uncertain.state.attempts.get('attempt-a')).toMatchObject({ status: 'uncertain', outcome: 'uncertain' })
    expect(
      reconcileUncertainEffect(uncertain.state, 'task-a', 'applied').state.attempts.get('attempt-a')
    ).toMatchObject({ status: 'reconciled', outcome: 'applied' })
  })

  it('moves a paused in-flight effect to uncertain and leaves it blocked after resume', () => {
    const authorized = consumeGrant(grant(createReadyTask()).state)
    const paused = pauseTask(authorized.state, 'task-a')
    expect(paused.state.tasks.get('task-a')).toMatchObject({ status: 'paused', effectOutcome: 'uncertain' })
    const resumed = resumeTask(paused.state, 'task-a')
    expect(resumed.state.tasks.get('task-a')?.status).toBe('uncertain')
    expect(grant(resumed.state, { grantId: 'grant-b' })).toMatchObject({ ok: false, reason: 'task_not_ready' })
  })

  it('reconciles canceled in-flight work as applied or not-applied without reopening it', () => {
    const inFlight = consumeGrant(grant(createReadyTask()).state).state
    const cancelled = cancelTask(inFlight, 'task-a').state
    expect(cancelled.tasks.get('task-a')).toMatchObject({ status: 'cancelled', effectOutcome: 'uncertain' })

    const applied = reconcileUncertainEffect(cancelled, 'task-a', 'applied')
    expect(applied.state.tasks.get('task-a')).toMatchObject({ status: 'cancelled', effectOutcome: 'applied' })
    expect(applied.state.attempts.get('attempt-a')).toMatchObject({ status: 'reconciled', outcome: 'applied' })
    expect(grant(applied.state, { grantId: 'grant-applied' })).toMatchObject({ ok: false, reason: 'task_not_ready' })

    const notApplied = reconcileUncertainEffect(cancelled, 'task-a', 'not-applied')
    expect(notApplied.state.tasks.get('task-a')).toMatchObject({
      status: 'cancelled',
      effectOutcome: 'not-applied',
      revision: 1
    })
    expect(notApplied.state.attempts.get('attempt-a')).toMatchObject({ status: 'reconciled', outcome: 'not-applied' })
    expect(grant(notApplied.state, { grantId: 'grant-not-applied' })).toMatchObject({
      ok: false,
      reason: 'task_not_ready'
    })
  })
})
