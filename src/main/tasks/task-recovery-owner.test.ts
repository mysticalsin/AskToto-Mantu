import { describe, expect, it } from 'vitest'
import type { TaskDefinition, TaskOwner, TaskPolicy, TaskRuntimeState } from './task-contract'
import { cloneTaskRecoveryOwner, isTaskRecoveryOwner, sameTaskRecoveryOwner } from './task-recovery-owner'
import { createTask, createTaskRuntimeState, pauseTask, resumeTask, reviseTask } from './task-state'

const OWNER: TaskOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 1,
  contextRevision: 1
}
const POLICY: TaskPolicy = {
  allowedTaskTypes: ['research'],
  allowedCapabilities: ['read'],
  resourceBudgets: { calls: 3 },
  maxRetentionMs: 10_000,
  maxGrantTtlMs: 1_000
}
const OWNER_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) } as const
const OWNER_B = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) } as const

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

function must<T extends { ok: boolean; state: TaskRuntimeState; reason?: string }>(result: T): TaskRuntimeState {
  expect(result.ok, result.reason).toBe(true)
  return result.state
}

describe('stable task recovery owner metadata', () => {
  it('accepts only an exact pair of 64-character lowercase hex keys', () => {
    expect(isTaskRecoveryOwner(OWNER_A)).toBe(true)
    expect(isTaskRecoveryOwner({ ...OWNER_A, extra: 'x' })).toBe(false)
    expect(isTaskRecoveryOwner({ ...OWNER_A, extra: undefined })).toBe(false)
    expect(isTaskRecoveryOwner({ ownerKey: 'A'.repeat(64), tenantKey: 'b'.repeat(64) })).toBe(false)
    expect(isTaskRecoveryOwner({ ownerKey: 'a'.repeat(63), tenantKey: 'b'.repeat(64) })).toBe(false)
    expect(isTaskRecoveryOwner({ ownerKey: 'a'.repeat(64), tenantKey: null })).toBe(false)
    expect(isTaskRecoveryOwner(null)).toBe(false)
  })

  it('clones and freezes pairs and compares both owner and tenant dimensions', () => {
    const source = { ...OWNER_A }
    const snapshot = cloneTaskRecoveryOwner(source)
    expect(snapshot).not.toBe(source)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(sameTaskRecoveryOwner(snapshot, OWNER_A)).toBe(true)
    expect(sameTaskRecoveryOwner(OWNER_A, { ...OWNER_A, tenantKey: 'c'.repeat(64) })).toBe(false)
    expect(sameTaskRecoveryOwner(OWNER_A, { ...OWNER_A, ownerKey: 'c'.repeat(64) })).toBe(false)
  })

  it('freezes attribution at task creation and preserves it on revision', () => {
    let state = must(
      createTask(createTaskRuntimeState(), definition('owner-bound', { recoveryOwner: OWNER_A }), POLICY)
    )
    const created = state.tasks.get('owner-bound')!
    expect(created.recoveryOwner).toEqual(OWNER_A)
    expect(created.recoveryOwner).not.toBe(OWNER_A)
    expect(Object.isFrozen(created.recoveryOwner)).toBe(true)

    state = must(
      reviseTask(state, {
        taskId: 'owner-bound',
        revision: 2,
        argumentsDigest: 'sha256:revised',
        scope: { capabilities: ['read'], resources: { calls: 1 } },
        policy: POLICY
      })
    )
    expect(state.tasks.get('owner-bound')?.recoveryOwner).toEqual(OWNER_A)
  })

  it('preserves attribution through pause and resume session transitions', () => {
    const created = must(
      createTask(createTaskRuntimeState(), definition('owner-session', { recoveryOwner: OWNER_A }), POLICY)
    )
    const paused = must(pauseTask(created, 'owner-session'))
    const resumed = must(resumeTask(paused, 'owner-session'))
    expect(resumed.tasks.get('owner-session')?.recoveryOwner).toEqual(OWNER_A)
  })

  it('rejects malformed metadata but does not inherit or equate recovery attribution across a lineage', () => {
    expect(
      createTask(
        createTaskRuntimeState(),
        definition('bad-owner', { recoveryOwner: { ownerKey: 'x' } as never }),
        POLICY
      )
    ).toMatchObject({ ok: false, reason: 'invalid_input' })

    let state = must(createTask(createTaskRuntimeState(), definition('parent', { recoveryOwner: OWNER_A }), POLICY))
    state = must(
      createTask(
        state,
        definition('child-different-recovery-owner', {
          parentTaskId: 'parent',
          parentTaskRevision: 1,
          recoveryOwner: OWNER_B,
          scope: { capabilities: ['read'], resources: { calls: 1 } }
        }),
        POLICY
      )
    )
    state = must(
      createTask(
        state,
        definition('child-unattributed', {
          parentTaskId: 'parent',
          parentTaskRevision: 1,
          scope: { capabilities: ['read'], resources: { calls: 1 } }
        }),
        POLICY
      )
    )
    expect(state.tasks.get('child-different-recovery-owner')?.recoveryOwner).toEqual(OWNER_B)
    expect(state.tasks.get('child-unattributed')?.recoveryOwner).toBeUndefined()
  })
})
