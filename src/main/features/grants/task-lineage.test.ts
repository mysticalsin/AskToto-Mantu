import { describe, expect, it } from 'vitest'
import type { TaskDefinition, TaskOwner, TaskPolicy, TaskRuntimeState } from '../../tasks/task-contract'
import { cancelTask, completeTask, createTask, createTaskRuntimeState, pauseTaskForQuota } from '../../tasks/task-state'
import { endedTaskLineageRoots, taskLineageRootId } from './task-lineage'

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
  return result.state
}

function twoLineages(): TaskRuntimeState {
  let state = createTaskRuntimeState()
  state = must(createTask(state, def('A', { multiStep: true }), policy))
  state = must(
    createTask(
      state,
      def('A-helper', {
        parentTaskId: 'A',
        parentTaskRevision: 1,
        scope: { capabilities: ['read'], resources: { calls: 1 } }
      }),
      policy
    )
  )
  state = must(createTask(state, def('B', { multiStep: true }), policy))
  return state
}

describe('task lineage root for grants (G06)', () => {
  it('a helper resolves to the root of the task that delegated it, so it inherits that task grant', () => {
    const state = twoLineages()
    expect(taskLineageRootId(state, 'A')).toBe('A')
    expect(taskLineageRootId(state, 'A-helper')).toBe('A')
    expect(taskLineageRootId(state, 'B')).toBe('B')
    expect(taskLineageRootId(state, 'missing')).toBeNull()
  })

  it('pausing for usage does not end a lineage; completing or cancelling the root does', () => {
    let state = twoLineages()
    state = must(pauseTaskForQuota(state, 'A'))
    expect(state.tasks.get('A')?.status).toBe('quota_paused')
    expect(endedTaskLineageRoots(state)).toEqual([])
    state = must(cancelTask(state, 'A'))
    expect(endedTaskLineageRoots(state)).toEqual(['A'])
    state = must(completeTask(state, 'B'))
    expect(endedTaskLineageRoots(state).sort()).toEqual(['A', 'B'])
  })
})
