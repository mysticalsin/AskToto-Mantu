import { describe, expect, it } from 'vitest'
import type { DispatchGrantScope, TaskDefinition, TaskOwner, TaskPolicy, TaskScope } from './task-contract'
import {
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  recordEffectOutcome,
  authorizeDispatch,
  resumeTask,
  reconcileUncertainEffect,
  cancelTask,
  pauseTask,
  reviseTask
} from './task-state'
import { decodeTaskRuntimeState, encodeTaskRuntimeState, type TaskStateCodecLimits } from './task-persistence'

const owner: TaskOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 4,
  contextRevision: 9
}

const policy: TaskPolicy = {
  allowedTaskTypes: ['connector-read'],
  allowedCapabilities: ['read'],
  resourceBudgets: { calls: 8 },
  maxRetentionMs: 60_000,
  maxGrantTtlMs: 5_000
}

const scope: TaskScope = { capabilities: ['read'], resources: { calls: 4 } }
const grantScope: DispatchGrantScope = { capability: 'read', resources: { calls: 1 } }
const limits: TaskStateCodecLimits = {
  maxBytes: 64_000,
  maxTasks: 100,
  maxAttempts: 200,
  maxConsumedGrantIds: 300,
  maxCapabilitiesPerScope: 32,
  maxResourcesPerScope: 32
}

function encode(state: ReturnType<typeof createTaskRuntimeState>) {
  return encodeTaskRuntimeState(state, limits)
}

function decode(serialized: string) {
  return decodeTaskRuntimeState({ kind: 'found', serialized }, limits)
}

interface MutableArchive {
  version: number
  tasks: Array<Record<string, any>>
  attempts: Array<Record<string, any>>
  consumedGrantIds: string[]
}

function parseArchive(serialized: string): MutableArchive {
  return JSON.parse(serialized) as MutableArchive
}

function addTask(state: ReturnType<typeof createTaskRuntimeState>, taskId: string) {
  const definition: TaskDefinition = {
    taskId,
    revision: 1,
    taskType: 'connector-read',
    owner,
    argumentsDigest: `sha256:${taskId}`,
    scope,
    createdAt: 100,
    retentionMs: 10_000
  }
  return createTask(state, definition, policy)
}

function authorize(
  state: ReturnType<typeof createTaskRuntimeState>,
  taskId: string,
  grantId: string,
  attemptId: string
) {
  const issued = issueDispatchGrant(state, { taskId, grantId, scope: grantScope, now: 200, ttlMs: 500, policy })
  expect(issued.ok).toBe(true)
  return authorizeDispatch(issued.state, {
    grantId,
    attemptId,
    taskId,
    taskRevision: 1,
    owner,
    argumentsDigest: `sha256:${taskId}`,
    scope: grantScope,
    now: 201
  })
}

describe('WP07 task state persistence codec and recovery projection', () => {
  it('serializes only task/attempt history and loads it fenced without live grants', () => {
    const created = addTask(createTaskRuntimeState(), 'task-a')
    expect(created.ok).toBe(true)
    const issued = issueDispatchGrant(created.state, {
      taskId: 'task-a',
      grantId: 'grant-a',
      scope: grantScope,
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(issued.ok).toBe(true)

    const serialized = encode(issued.state)
    expect(serialized).not.toContain('"grants"')
    expect(serialized).not.toContain('grant-a')

    const loaded = decode(serialized)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.state.grants.size).toBe(0)
    expect(loaded.state.ownerRebindRequired).toBe(true)
    expect(resumeTask(loaded.state, 'task-a')).toMatchObject({ ok: false, reason: 'owner_rebind_required' })
    expect(
      issueDispatchGrant(loaded.state, {
        taskId: 'task-a',
        grantId: 'new-grant',
        scope: grantScope,
        now: 202,
        ttlMs: 100,
        policy
      })
    ).toMatchObject({ ok: false, reason: 'owner_rebind_required' })
    const staleGrant = issued.state.grants.get('grant-a')!
    const withStaleGrant = { ...loaded.state, grants: new Map([[staleGrant.grantId, staleGrant]]) }
    expect(
      authorizeDispatch(withStaleGrant, {
        grantId: 'grant-a',
        attemptId: 'stale-attempt',
        taskId: 'task-a',
        taskRevision: 1,
        owner,
        argumentsDigest: 'sha256:task-a',
        scope: grantScope,
        now: 201
      }).decision
    ).toEqual({ allowed: false, reason: 'owner_rebind_required' })
  })

  it('recovers interrupted dispatch as uncertain, preserves reconciliation, and keeps the owner fence', () => {
    const created = addTask(createTaskRuntimeState(), 'task-a')
    expect(created.ok).toBe(true)
    const inFlight = authorize(created.state, 'task-a', 'grant-a', 'attempt-a')
    expect(inFlight.decision).toMatchObject({ allowed: true })

    const loaded = decode(encode(inFlight.state))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.state.grants.size).toBe(0)
    expect(loaded.state.tasks.get('task-a')).toMatchObject({ status: 'uncertain', effectOutcome: 'uncertain' })
    expect(loaded.state.attempts.get('attempt-a')).toMatchObject({ status: 'uncertain', outcome: 'uncertain' })
    expect(loaded.state.consumedGrantIds.has('grant-a')).toBe(true)

    const reconciled = reconcileUncertainEffect(loaded.state, 'task-a', 'not-applied')
    expect(reconciled.state.tasks.get('task-a')).toMatchObject({ status: 'ready', effectOutcome: 'not-applied' })
    expect(reconciled.state.ownerRebindRequired).toBe(true)
    expect(
      issueDispatchGrant(reconciled.state, {
        taskId: 'task-a',
        grantId: 'grant-after-recovery',
        scope: grantScope,
        now: 202,
        ttlMs: 100,
        policy
      })
    ).toMatchObject({ ok: false, reason: 'owner_rebind_required' })
  })

  it('preserves canceled and completed terminal tasks without requiring owner rebind', () => {
    const first = addTask(createTaskRuntimeState(), 'completed-task')
    expect(first.ok).toBe(true)
    const completedInFlight = authorize(first.state, 'completed-task', 'grant-completed', 'attempt-completed')
    expect(completedInFlight.decision.allowed).toBe(true)
    const completed = recordEffectOutcome(completedInFlight.state, 'completed-task', 'attempt-completed', 'applied')
    expect(completed.ok).toBe(true)

    const second = addTask(completed.state, 'cancelled-task')
    expect(second.ok).toBe(true)
    const cancelled = cancelTask(second.state, 'cancelled-task')
    expect(cancelled.ok).toBe(true)

    const loaded = decode(encode(cancelled.state))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.state.tasks.get('completed-task')?.status).toBe('completed')
    expect(loaded.state.tasks.get('cancelled-task')?.status).toBe('cancelled')
    expect(loaded.state.ownerRebindRequired).toBe(false)
  })

  it('distinguishes not-found, unavailable, and corrupt reads', () => {
    expect(decodeTaskRuntimeState({ kind: 'not-found' }, limits)).toEqual({ kind: 'not-found' })
    expect(decodeTaskRuntimeState({ kind: 'unavailable', reason: 'storage-locked' }, limits)).toEqual({
      kind: 'unavailable',
      reason: 'storage-locked'
    })
    expect(decodeTaskRuntimeState({ kind: 'found', serialized: '{' }, limits)).toEqual({
      kind: 'corrupt',
      reason: 'invalid-json'
    })
    expect(
      decodeTaskRuntimeState(
        { kind: 'found', serialized: JSON.stringify({ version: 99, tasks: [], attempts: [], consumedGrantIds: [] }) },
        limits
      )
    ).toEqual({ kind: 'corrupt', reason: 'unsupported-version' })
    expect(
      decodeTaskRuntimeState(
        {
          kind: 'found',
          serialized: JSON.stringify({ version: 1, tasks: [], attempts: [], consumedGrantIds: [], grants: [] })
        },
        limits
      )
    ).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })
  })

  it('rejects cross-task or missing uncertain last-attempt links and duplicate single-use grant IDs', () => {
    const first = addTask(createTaskRuntimeState(), 'task-a')
    expect(first.ok).toBe(true)
    const second = addTask(first.state, 'task-b')
    expect(second.ok).toBe(true)
    const third = addTask(second.state, 'task-c')
    expect(third.ok).toBe(true)
    const b = authorize(third.state, 'task-b', 'grant-b', 'attempt-b')
    expect(b.decision.allowed).toBe(true)
    const c = authorize(b.state, 'task-c', 'grant-c', 'attempt-c')
    expect(c.decision.allowed).toBe(true)
    const bUncertain = recordEffectOutcome(c.state, 'task-b', 'attempt-b', 'uncertain')
    expect(bUncertain.ok).toBe(true)
    const bothUncertain = recordEffectOutcome(bUncertain.state, 'task-c', 'attempt-c', 'uncertain')
    expect(bothUncertain.ok).toBe(true)

    const wronglyLinkedTaskA = {
      ...bothUncertain.state.tasks.get('task-a')!,
      status: 'uncertain' as const,
      effectOutcome: 'uncertain' as const,
      activeAttemptId: undefined,
      lastAttemptId: 'attempt-b'
    }
    const forgedState = {
      ...bothUncertain.state,
      tasks: new Map(bothUncertain.state.tasks).set('task-a', wronglyLinkedTaskA)
    }
    expect(reconcileUncertainEffect(forgedState, 'task-a', 'applied')).toMatchObject({
      ok: false,
      reason: 'invalid_transition'
    })
    expect(forgedState.attempts.get('attempt-b')).toMatchObject({ taskId: 'task-b', status: 'uncertain' })

    const crossTask = parseArchive(encode(bothUncertain.state))
    crossTask.tasks.find((task) => task.taskId === 'task-a')!.lastAttemptId = 'attempt-b'
    expect(decode(JSON.stringify(crossTask))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })

    const missingUncertainLink = parseArchive(encode(bothUncertain.state))
    delete missingUncertainLink.tasks.find((task) => task.taskId === 'task-b')!.lastAttemptId
    expect(decode(JSON.stringify(missingUncertainLink))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })

    const duplicateGrant = parseArchive(encode(bothUncertain.state))
    duplicateGrant.attempts.find((attempt) => attempt.attemptId === 'attempt-c')!.grantId = 'grant-b'
    expect(decode(JSON.stringify(duplicateGrant))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })
  })

  it('validates dispatch snapshots and preserves consumed rejected-grant tombstones', () => {
    const created = addTask(createTaskRuntimeState(), 'task-a')
    expect(created.ok).toBe(true)
    const issued = issueDispatchGrant(created.state, {
      taskId: 'task-a',
      grantId: 'grant-a',
      scope: grantScope,
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(issued.ok).toBe(true)
    const rejected = authorizeDispatch(issued.state, {
      grantId: 'grant-a',
      attemptId: 'attempt-a',
      taskId: 'task-a',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:task-a',
      scope: { capability: 'read', resources: { calls: 2 } },
      now: 201
    })
    expect(rejected.decision).toMatchObject({ allowed: false, reason: 'wrong_scope' })
    expect(rejected.state.consumedGrantIds.has('grant-a')).toBe(true)
    const loaded = decode(encode(rejected.state))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded') expect(loaded.state.consumedGrantIds.has('grant-a')).toBe(true)

    const activeGrant = issueDispatchGrant(created.state, {
      taskId: 'task-a',
      grantId: 'grant-b',
      scope: grantScope,
      now: 200,
      ttlMs: 500,
      policy
    })
    expect(activeGrant.ok).toBe(true)
    const active = authorizeDispatch(activeGrant.state, {
      grantId: 'grant-b',
      attemptId: 'attempt-b',
      taskId: 'task-a',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:task-a',
      scope: grantScope,
      now: 201
    })
    expect(active.decision.allowed).toBe(true)
    const mismatched = parseArchive(encode(active.state))
    mismatched.attempts[0]!.argumentsDigest = 'sha256:altered'
    expect(decode(JSON.stringify(mismatched))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })
  })

  it('binds applied and not-applied outcomes to the matching attempt history', () => {
    const created = addTask(createTaskRuntimeState(), 'task-a')
    expect(created.ok).toBe(true)
    const inFlight = authorize(created.state, 'task-a', 'grant-a', 'attempt-a')
    expect(inFlight.decision.allowed).toBe(true)

    const applied = recordEffectOutcome(inFlight.state, 'task-a', 'attempt-a', 'applied')
    expect(applied.ok).toBe(true)
    expect(decode(encode(applied.state)).kind).toBe('loaded')

    const missingAppliedLink = parseArchive(encode(applied.state))
    delete missingAppliedLink.tasks.find((task) => task.taskId === 'task-a')!.lastAttemptId
    expect(decode(JSON.stringify(missingAppliedLink))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })

    const reopenedAppliedTask = parseArchive(encode(applied.state))
    const reopened = reopenedAppliedTask.tasks.find((task) => task.taskId === 'task-a')!
    reopened.status = 'ready'
    delete reopened.effectOutcome
    expect(decode(JSON.stringify(reopenedAppliedTask))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })

    const notAppliedInFlight = authorize(created.state, 'task-a', 'grant-not-applied', 'attempt-not-applied')
    expect(notAppliedInFlight.decision.allowed).toBe(true)
    const notApplied = recordEffectOutcome(notAppliedInFlight.state, 'task-a', 'attempt-not-applied', 'not-applied')
    expect(notApplied.ok).toBe(true)
    expect(decode(encode(notApplied.state)).kind).toBe('loaded')

    const missingNotAppliedLink = parseArchive(encode(notApplied.state))
    delete missingNotAppliedLink.tasks.find((task) => task.taskId === 'task-a')!.lastAttemptId
    expect(decode(JSON.stringify(missingNotAppliedLink))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })

    const mismatchedNotAppliedOutcome = parseArchive(encode(notApplied.state))
    mismatchedNotAppliedOutcome.attempts[0]!.outcome = 'applied'
    expect(decode(JSON.stringify(mismatchedNotAppliedOutcome))).toEqual({
      kind: 'corrupt',
      reason: 'inconsistent-history'
    })

    const invalidNotAppliedRevision = parseArchive(encode(notApplied.state))
    invalidNotAppliedRevision.tasks.find((task) => task.taskId === 'task-a')!.revision = 9
    expect(decode(JSON.stringify(invalidNotAppliedRevision))).toEqual({
      kind: 'corrupt',
      reason: 'inconsistent-history'
    })

    const retryGrant = issueDispatchGrant(notApplied.state, {
      taskId: 'task-a',
      grantId: 'grant-retry',
      scope: grantScope,
      now: 202,
      ttlMs: 500,
      policy
    })
    expect(retryGrant.ok).toBe(true)
    const retry = authorizeDispatch(retryGrant.state, {
      grantId: 'grant-retry',
      attemptId: 'attempt-retry',
      taskId: 'task-a',
      taskRevision: 2,
      owner,
      argumentsDigest: 'sha256:task-a',
      scope: grantScope,
      now: 203
    })
    expect(retry.decision.allowed).toBe(true)
    if (!retry.decision.allowed) return
    expect(retry.decision.task.effectOutcome).toBeUndefined()
    expect(decode(encode(retry.state)).kind).toBe('loaded')
  })

  it('allows reconciliation of recovered paused uncertainty without making it dispatchable', () => {
    const created = addTask(createTaskRuntimeState(), 'task-a')
    expect(created.ok).toBe(true)
    const inFlight = authorize(created.state, 'task-a', 'grant-paused', 'attempt-paused')
    expect(inFlight.decision.allowed).toBe(true)
    const paused = pauseTask(inFlight.state, 'task-a')
    expect(paused.ok).toBe(true)
    const loaded = decode(encode(paused.state))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    const reconciled = reconcileUncertainEffect(loaded.state, 'task-a', 'not-applied')
    expect(reconciled.state.tasks.get('task-a')).toMatchObject({ status: 'paused', effectOutcome: 'not-applied' })
    expect(reconciled.state.ownerRebindRequired).toBe(true)
    expect(resumeTask(reconciled.state, 'task-a')).toMatchObject({ ok: false, reason: 'owner_rebind_required' })
  })

  it('validates active parent snapshots while retaining canceled child history after parent revision', () => {
    const expandedPolicy: TaskPolicy = {
      ...policy,
      allowedCapabilities: ['read', 'write'],
      resourceBudgets: { calls: 8, items: 4 }
    }
    const parentScope: TaskScope = { capabilities: ['read', 'write'], resources: { calls: 4, items: 2 } }
    const childScope: TaskScope = { capabilities: ['read'], resources: { calls: 1 } }
    const parent = createTask(
      createTaskRuntimeState(),
      {
        taskId: 'parent',
        revision: 1,
        taskType: 'connector-read',
        owner,
        argumentsDigest: 'sha256:parent',
        scope: parentScope,
        createdAt: 100,
        retentionMs: 10_000
      },
      expandedPolicy
    )
    expect(parent.ok).toBe(true)
    const child = createTask(
      parent.state,
      {
        taskId: 'child',
        revision: 1,
        taskType: 'connector-read',
        owner,
        argumentsDigest: 'sha256:child',
        scope: childScope,
        createdAt: 100,
        retentionMs: 5_000,
        parentTaskId: 'parent',
        parentTaskRevision: 1
      },
      expandedPolicy
    )
    expect(child.ok).toBe(true)
    const badParentSnapshot = parseArchive(encode(child.state))
    badParentSnapshot.tasks.find((task) => task.taskId === 'child')!.parentTaskRevision = 2
    expect(decode(JSON.stringify(badParentSnapshot))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })

    const childNotPausedWithParent = parseArchive(encode(child.state))
    childNotPausedWithParent.tasks.find((task) => task.taskId === 'parent')!.status = 'paused'
    expect(decode(JSON.stringify(childNotPausedWithParent))).toEqual({
      kind: 'corrupt',
      reason: 'inconsistent-history'
    })

    const revised = reviseTask(child.state, {
      taskId: 'parent',
      revision: 2,
      argumentsDigest: 'sha256:parent-revised',
      scope: { capabilities: ['read'], resources: { calls: 2 } },
      policy: expandedPolicy
    })
    expect(revised.ok).toBe(true)
    expect(revised.state.tasks.get('child')?.status).toBe('cancelled')
    expect(decode(encode(revised.state)).kind).toBe('loaded')
  })

  it('rejects archives beyond explicit byte, record, or nested-scope limits before recovery', () => {
    expect(decodeTaskRuntimeState({ kind: 'found', serialized: ' '.repeat(limits.maxBytes + 1) }, limits)).toEqual({
      kind: 'corrupt',
      reason: 'limit-exceeded'
    })
    const created = addTask(createTaskRuntimeState(), 'task-a')
    expect(created.ok).toBe(true)
    expect(() => encodeTaskRuntimeState(created.state, { ...limits, maxTasks: 1 })).not.toThrow()
    const second = addTask(created.state, 'task-b')
    expect(second.ok).toBe(true)
    expect(() => encodeTaskRuntimeState(second.state, { ...limits, maxTasks: 1 })).toThrow(RangeError)
    expect(
      decodeTaskRuntimeState({ kind: 'found', serialized: encode(second.state) }, { ...limits, maxTasks: 1 })
    ).toEqual({ kind: 'corrupt', reason: 'limit-exceeded' })
    expect(() => encodeTaskRuntimeState(created.state, { ...limits, maxTasks: 1, maxBytes: 8 })).toThrow(RangeError)
    const oversized = parseArchive(encode(created.state))
    oversized.tasks[0]!.scope = {
      capabilities: Array.from({ length: limits.maxCapabilitiesPerScope + 1 }, (_, i) => `cap-${i}`),
      resources: {}
    }
    expect(decode(JSON.stringify(oversized))).toEqual({ kind: 'corrupt', reason: 'limit-exceeded' })
  })
})
