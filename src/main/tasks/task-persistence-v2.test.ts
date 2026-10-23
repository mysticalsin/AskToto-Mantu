import { describe, expect, it } from 'vitest'
import type { DispatchGrantScope, TaskDefinition, TaskOwner, TaskPolicy, TaskRuntimeState } from './task-contract'
import { decodeTaskRuntimeState, encodeTaskRuntimeState, type TaskStateCodecLimits } from './task-persistence'
import {
  authorizeDispatch,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  pauseTaskForQuota,
  recordEffectOutcome,
  steerTask
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
const limits: TaskStateCodecLimits = {
  maxBytes: 64_000,
  maxTasks: 100,
  maxAttempts: 200,
  maxConsumedGrantIds: 300,
  maxCapabilitiesPerScope: 32,
  maxResourcesPerScope: 32
}
const readStep: DispatchGrantScope = { capability: 'read', resources: { calls: 1 } }

const decode = (serialized: string) => decodeTaskRuntimeState({ kind: 'found', serialized }, limits)
const encode = (state: TaskRuntimeState) => encodeTaskRuntimeState(state, limits)

function must(result: { ok: boolean; state: TaskRuntimeState; reason?: string }): TaskRuntimeState {
  expect(result.reason).toBeUndefined()
  return result.state
}

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

function step(state: TaskRuntimeState, taskId: string, id: string, outcome: 'applied' | 'not-applied' | 'uncertain') {
  const issued = must(
    issueDispatchGrant(state, { taskId, grantId: `grant-${id}`, scope: readStep, now: 200, ttlMs: 1_000, policy })
  )
  const task = issued.tasks.get(taskId)!
  const authorized = authorizeDispatch(issued, {
    grantId: `grant-${id}`,
    attemptId: `attempt-${id}`,
    taskId,
    taskRevision: task.revision,
    owner,
    argumentsDigest: task.argumentsDigest,
    scope: readStep,
    now: 201
  })
  expect(authorized.decision.allowed).toBe(true)
  return must(recordEffectOutcome(authorized.state, taskId, `attempt-${id}`, outcome))
}

/**
 * A frozen copy of the v1 reader's contract (exact key sets, six statuses, version 1 only). It stands for the
 * build a user rolls back to. It is deliberately independent of the production decoder.
 */
function previousBuildReads(serialized: string): 'ok' | 'unsupported-version' | 'invalid-shape' {
  const archive = JSON.parse(serialized) as Record<string, unknown>
  if (archive.version !== 1) return 'unsupported-version'
  const allowed = new Set([
    'taskId',
    'revision',
    'taskType',
    'owner',
    'argumentsDigest',
    'scope',
    'createdAt',
    'retentionMs',
    'status',
    'expiresAt',
    'parentTaskId',
    'parentTaskRevision',
    'effectOutcome',
    'activeAttemptId',
    'lastAttemptId'
  ])
  const statuses = new Set(['ready', 'dispatching', 'paused', 'cancelled', 'completed', 'uncertain'])
  for (const task of archive.tasks as Array<Record<string, unknown>>) {
    if (!statuses.has(task.status as string) || Object.keys(task).some((key) => !allowed.has(key))) {
      return 'invalid-shape'
    }
  }
  return 'ok'
}

/** A v1 archive exactly as the previous build wrote it: one finished single-action task. */
const LEGACY_V1 = JSON.stringify({
  version: 1,
  tasks: [
    {
      taskId: 'desktop-action:old',
      revision: 1,
      taskType: 'desktop-action',
      owner,
      argumentsDigest: 'sha256:old',
      scope: { capabilities: ['notes.append'], resources: { actions: 1 } },
      createdAt: 1_000,
      retentionMs: 5_000,
      status: 'completed',
      expiresAt: 6_000,
      effectOutcome: 'applied',
      lastAttemptId: 'attempt-old'
    }
  ],
  attempts: [
    {
      attemptId: 'attempt-old',
      taskId: 'desktop-action:old',
      taskRevision: 1,
      grantId: 'grant-old',
      owner,
      argumentsDigest: 'sha256:old',
      scope: { capability: 'notes.append', resources: { actions: 1 } },
      authorizedAt: 1_100,
      status: 'settled',
      outcome: 'applied'
    }
  ],
  consumedGrantIds: ['grant-old']
})

function v2State(): TaskRuntimeState {
  let state = must(createTask(createTaskRuntimeState(), def('multi', { multiStep: true }), policy))
  state = step(state, 'multi', '1', 'applied')
  state = step(state, 'multi', '2', 'applied')
  state = must(pauseTaskForQuota(state, 'multi'))
  return must(createTask(state, def('plan'), policy, { initialStatus: 'planning' }))
}

describe('task codec v2: backward read', () => {
  it('reads an archive written by the previous build and keeps it stable on re-encode', () => {
    const loaded = decode(LEGACY_V1)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.state.ownerRebindRequired).toBe(false)
    expect(loaded.state.tasks.get('desktop-action:old')).toMatchObject({
      status: 'completed',
      effectOutcome: 'applied',
      revision: 1
    })
    expect(loaded.state.tasks.get('desktop-action:old')?.multiStep).toBeUndefined()
    expect(JSON.parse(encode(loaded.state))).toEqual(JSON.parse(LEGACY_V1))
  })

  it('never lets a v1 label carry a v2 status or field', () => {
    const quota = JSON.parse(encode(v2State())) as { version: number }
    expect(quota.version).toBe(2)
    expect(decode(JSON.stringify({ ...quota, version: 1 }))).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })

    const v3 = JSON.parse(JSON.stringify(quota)) as {
      version: number
      tasks: Array<Record<string, unknown> & { taskId?: string }>
    }
    v3.version = 3
    const multi = v3.tasks.find((task) => task.taskId === 'multi')
    expect(multi).toBeDefined()
    if (!multi) return
    multi.recoveryOwner = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
    const loaded = decode(JSON.stringify(v3))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded') {
      expect(loaded.state.tasks.get('multi')).toMatchObject({ status: 'quota_paused', multiStep: true })
      expect(loaded.state.tasks.get('multi')?.recoveryOwner).toEqual({
        ownerKey: 'a'.repeat(64),
        tenantKey: 'b'.repeat(64)
      })
    }

    expect(decode(JSON.stringify({ ...quota, version: 4 }))).toEqual({
      kind: 'corrupt',
      reason: 'unsupported-version'
    })
  })
})

describe('task codec v2: write and round trip', () => {
  it('round-trips planning, quota_paused, multi-step and metered usage behind the owner fence', () => {
    const encoded = encode(v2State())
    const loaded = decode(encoded)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') return
    expect(loaded.state.ownerRebindRequired).toBe(true)
    expect(loaded.state.tasks.get('multi')).toMatchObject({
      status: 'quota_paused',
      multiStep: true,
      stepsCompleted: 2,
      usedResources: { calls: 2 }
    })
    expect(loaded.state.tasks.get('plan')?.status).toBe('planning')
    expect(loaded.state.attempts.size).toBe(2)
    expect(JSON.parse(encode(loaded.state))).toEqual(JSON.parse(encoded))
  })

  it('keeps every verified step of a multi-step task loadable', () => {
    let state = must(createTask(createTaskRuntimeState(), def('multi', { multiStep: true }), policy))
    state = step(state, 'multi', '1', 'applied')
    state = step(state, 'multi', '2', 'not-applied')
    state = step(state, 'multi', '3', 'applied')
    expect(decode(encode(state)).kind).toBe('loaded')
  })

  it('survives a steer back to planning', () => {
    let state = must(createTask(createTaskRuntimeState(), def('multi', { multiStep: true }), policy))
    state = step(state, 'multi', '1', 'applied')
    state = must(steerTask(state, { taskId: 'multi', revision: 2, argumentsDigest: 'sha256:steered' }))
    const loaded = decode(encode(state))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded')
      expect(loaded.state.tasks.get('multi')).toMatchObject({ status: 'planning', revision: 2 })
  })

  it('a v2-recovered dispatching step becomes uncertain like before', () => {
    let state = must(createTask(createTaskRuntimeState(), def('multi', { multiStep: true }), policy))
    state = step(state, 'multi', '1', 'applied')
    const issued = must(
      issueDispatchGrant(state, {
        taskId: 'multi',
        grantId: 'grant-2',
        scope: readStep,
        now: 200,
        ttlMs: 1_000,
        policy
      })
    )
    const active = authorizeDispatch(issued, {
      grantId: 'grant-2',
      attemptId: 'attempt-2',
      taskId: 'multi',
      taskRevision: 1,
      owner,
      argumentsDigest: 'sha256:multi',
      scope: readStep,
      now: 201
    }).state
    const loaded = decode(encode(active))
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded') {
      expect(loaded.state.tasks.get('multi')).toMatchObject({ status: 'uncertain', effectOutcome: 'uncertain' })
      expect(loaded.state.attempts.get('attempt-2')).toMatchObject({ status: 'uncertain' })
    }
  })
})

describe('task codec v2: rollback', () => {
  it('writes v1 while no task uses a v2 feature, so the previous build still reads it', () => {
    let state = must(createTask(createTaskRuntimeState(), def('single'), policy))
    state = step(state, 'single', '1', 'applied')
    state = must(createTask(state, def('pending'), policy))
    const encoded = encode(state)
    expect(JSON.parse(encoded).version).toBe(1)
    expect(previousBuildReads(encoded)).toBe('ok')
    // A task that is loaded from v1 and written again stays at v1.
    const loaded = decode(encoded)
    expect(loaded.kind === 'loaded' && JSON.parse(encode(loaded.state)).version).toBe(1)
  })

  it('fails closed on the previous build once v2 data exists: unsupported, never partly misread', () => {
    const encoded = encode(v2State())
    expect(previousBuildReads(encoded)).toBe('unsupported-version')
    // The new build keeps reading a v1 archive after the user rolls back and forward again.
    expect(decode(LEGACY_V1).kind).toBe('loaded')
  })

  it('stays v1 when a quota or planning task has since been cancelled and removed', () => {
    const state = v2State()
    const tasks = new Map(state.tasks)
    tasks.delete('plan')
    tasks.delete('multi')
    const attempts = new Map([...state.attempts].filter(([, attempt]) => attempt.taskId !== 'multi'))
    expect(JSON.parse(encode({ ...state, tasks, attempts, consumedGrantIds: new Set() })).version).toBe(1)
  })
})

describe('task codec v2: validation', () => {
  function mutate(change: (archive: { tasks: Array<Record<string, any>> }) => void): string {
    const archive = JSON.parse(encode(v2State()))
    change(archive)
    return JSON.stringify(archive)
  }

  it('rejects metered usage above the approved budget or for an unbudgeted resource', () => {
    expect(decode(mutate((a) => (a.tasks.find((t) => t.taskId === 'multi')!.usedResources = { calls: 4 })))).toEqual({
      kind: 'corrupt',
      reason: 'invalid-shape'
    })
    expect(decode(mutate((a) => (a.tasks.find((t) => t.taskId === 'multi')!.usedResources = { bytes: 1 })))).toEqual({
      kind: 'corrupt',
      reason: 'invalid-shape'
    })
  })

  it('rejects a step count on a single-action task and a non-boolean flag', () => {
    expect(decode(mutate((a) => (a.tasks.find((t) => t.taskId === 'plan')!.stepsCompleted = 1)))).toEqual({
      kind: 'corrupt',
      reason: 'invalid-shape'
    })
    expect(decode(mutate((a) => (a.tasks.find((t) => t.taskId === 'plan')!.multiStep = 'yes')))).toEqual({
      kind: 'corrupt',
      reason: 'invalid-shape'
    })
  })

  it('rejects a suspended or planning task that claims an unresolved or applied effect', () => {
    for (const taskId of ['multi', 'plan']) {
      for (const effectOutcome of ['uncertain', 'applied']) {
        expect(
          decode(mutate((a) => (a.tasks.find((t) => t.taskId === taskId)!.effectOutcome = effectOutcome)))
        ).toEqual({
          kind: 'corrupt',
          reason: 'inconsistent-history'
        })
      }
    }
  })

  it('rejects a helper in planning and a live helper under a planning parent', () => {
    let state = must(createTask(createTaskRuntimeState(), def('parent', { multiStep: true }), policy))
    state = must(
      createTask(
        state,
        def('helper', {
          parentTaskId: 'parent',
          parentTaskRevision: 1,
          scope: { capabilities: ['read'], resources: { calls: 1 } }
        }),
        policy
      )
    )
    const base = JSON.parse(encode(state))
    base.version = 2
    base.tasks.find((t: any) => t.taskId === 'helper').status = 'planning'
    expect(decode(JSON.stringify(base))).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })
    const planningParent = JSON.parse(encode(state))
    planningParent.version = 2
    planningParent.tasks.find((t: any) => t.taskId === 'parent').status = 'planning'
    expect(decode(JSON.stringify(planningParent))).toEqual({ kind: 'corrupt', reason: 'inconsistent-history' })
  })

  it('accepts a live helper under a quota_paused parent', () => {
    let state = must(createTask(createTaskRuntimeState(), def('parent', { multiStep: true }), policy))
    state = must(
      createTask(
        state,
        def('helper', {
          parentTaskId: 'parent',
          parentTaskRevision: 1,
          scope: { capabilities: ['read'], resources: { calls: 1 } }
        }),
        policy
      )
    )
    state = must(pauseTaskForQuota(state, 'parent'))
    expect(decode(encode(state)).kind).toBe('loaded')
  })
})
