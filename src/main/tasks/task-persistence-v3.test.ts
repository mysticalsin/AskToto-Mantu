import { describe, expect, it } from 'vitest'
import type { DispatchGrantScope, TaskDefinition, TaskOwner, TaskPolicy, TaskRuntimeState } from './task-contract'
import { decodeTaskRuntimeState, encodeTaskRuntimeState, type TaskStateCodecLimits } from './task-persistence'
import {
  authorizeDispatch,
  createTask,
  createTaskRuntimeState,
  issueDispatchGrant,
  recordEffectOutcome
} from './task-state'

const OWNER: TaskOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 4,
  contextRevision: 9
}
const POLICY: TaskPolicy = {
  allowedTaskTypes: ['research'],
  allowedCapabilities: ['read'],
  resourceBudgets: { calls: 3 },
  maxRetentionMs: 10_000,
  maxGrantTtlMs: 1_000
}
const LIMITS: TaskStateCodecLimits = {
  maxBytes: 64_000,
  maxTasks: 100,
  maxAttempts: 200,
  maxConsumedGrantIds: 300,
  maxCapabilitiesPerScope: 32,
  maxResourcesPerScope: 32
}
const RECOVERY_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) } as const
const READ_STEP: DispatchGrantScope = { capability: 'read', resources: { calls: 1 } }

function definition(taskId: string, extra: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskId,
    revision: 1,
    taskType: 'research',
    owner: OWNER,
    argumentsDigest: `sha256:${taskId}`,
    scope: { capabilities: ['read'], resources: { calls: 2 } },
    createdAt: 100,
    retentionMs: 5_000,
    ...extra
  }
}

function create(taskId: string, extra: Partial<TaskDefinition> = {}): TaskRuntimeState {
  const result = createTask(createTaskRuntimeState(), definition(taskId, extra), POLICY)
  if (!result.ok) throw new Error(`fixture task creation failed: ${result.reason}`)
  return result.state
}

function decode(serialized: string) {
  return decodeTaskRuntimeState({ kind: 'found', serialized }, LIMITS)
}

function multiStepOwnerState(): TaskRuntimeState {
  const created = create('owner', { recoveryOwner: RECOVERY_A, multiStep: true })
  let state = created
  for (let index = 1; index <= 2; index += 1) {
    const task = state.tasks.get('owner')!
    const grantId = `multi-grant-${index}`
    const attemptId = `multi-attempt-${index}`
    const issued = issueDispatchGrant(state, {
      taskId: 'owner',
      grantId,
      scope: READ_STEP,
      now: 200 + index,
      ttlMs: 500,
      policy: POLICY
    })
    if (!issued.ok) throw new Error(`fixture grant failed: ${issued.reason}`)
    const authorized = authorizeDispatch(issued.state, {
      grantId,
      attemptId,
      taskId: 'owner',
      taskRevision: task.revision,
      owner: OWNER,
      argumentsDigest: task.argumentsDigest,
      scope: READ_STEP,
      now: 201 + index
    })
    if (!authorized.decision.allowed) throw new Error(`fixture authorization failed: ${authorized.decision.reason}`)
    const settled = recordEffectOutcome(authorized.state, 'owner', attemptId, 'applied')
    if (!settled.ok) throw new Error(`fixture settlement failed: ${settled.reason}`)
    state = settled.state
  }
  return state
}

describe('task codec v3 recovery metadata', () => {
  it('selects the lowest version needed and writes v3 only when recovery attribution is present', () => {
    expect(JSON.parse(encodeTaskRuntimeState(create('legacy'), LIMITS)).version).toBe(1)
    expect(JSON.parse(encodeTaskRuntimeState(create('multi', { multiStep: true }), LIMITS)).version).toBe(2)
    const archive = JSON.parse(encodeTaskRuntimeState(create('owner', { recoveryOwner: RECOVERY_A }), LIMITS))
    expect(archive.version).toBe(3)
    expect(archive.tasks[0]).toMatchObject({ recoveryOwner: RECOVERY_A })
  })

  it('round-trips and freezes v3 metadata while preserving mixed v2 fields and attempt history', () => {
    const state = multiStepOwnerState()
    const serialized = encodeTaskRuntimeState(state, LIMITS)
    const archive = JSON.parse(serialized) as {
      version: number
      attempts: unknown[]
      consumedGrantIds: string[]
    }
    expect(archive.version).toBe(3)
    expect(archive.attempts).toHaveLength(2)
    expect(archive.consumedGrantIds).toEqual(['multi-grant-1', 'multi-grant-2'])
    const decoded = decode(serialized)
    expect(decoded.kind).toBe('loaded')
    if (decoded.kind !== 'loaded') return
    const task = decoded.state.tasks.get('owner')!
    expect(task).toMatchObject({ recoveryOwner: RECOVERY_A, multiStep: true, stepsCompleted: 2 })
    expect(Object.isFrozen(task.recoveryOwner)).toBe(true)
    expect(encodeTaskRuntimeState(decoded.state, LIMITS)).toBe(serialized)
  })

  it('rejects v1/v2 labels carrying v3 metadata and rejects malformed v3 pairs or unknown nested keys', () => {
    const valid = JSON.parse(encodeTaskRuntimeState(create('owner', { recoveryOwner: RECOVERY_A }), LIMITS))
    const mislabeledV2 = { ...valid, version: 2 }
    const mislabeledV1 = { ...valid, version: 1 }
    expect(decode(JSON.stringify(mislabeledV2))).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })
    expect(decode(JSON.stringify(mislabeledV1))).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })

    const malformed = JSON.parse(JSON.stringify(valid))
    malformed.tasks[0].recoveryOwner.tenantKey = 'B'.repeat(64)
    expect(decode(JSON.stringify(malformed))).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })
    const extra = JSON.parse(JSON.stringify(valid))
    extra.tasks[0].recoveryOwner.extra = true
    expect(decode(JSON.stringify(extra))).toEqual({ kind: 'corrupt', reason: 'invalid-shape' })
  })

  it('permits v3 archives to retain unattributed legacy entries without assigning them an owner', () => {
    const mixed = createTaskRuntimeState()
    const attributed = createTask(mixed, definition('new', { recoveryOwner: RECOVERY_A }), POLICY)
    if (!attributed.ok) throw new Error(attributed.reason)
    const legacy = createTask(attributed.state, definition('legacy'), POLICY)
    if (!legacy.ok) throw new Error(legacy.reason)
    const archive = JSON.parse(encodeTaskRuntimeState(legacy.state, LIMITS))
    expect(archive.version).toBe(3)
    const decoded = decode(JSON.stringify(archive))
    expect(decoded.kind).toBe('loaded')
    if (decoded.kind !== 'loaded') return
    expect(decoded.state.tasks.get('new')?.recoveryOwner).toEqual(RECOVERY_A)
    expect(decoded.state.tasks.get('legacy')?.recoveryOwner).toBeUndefined()
  })
})
