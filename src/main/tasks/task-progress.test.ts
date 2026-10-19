import { describe, expect, it } from 'vitest'
import type { TaskOwner, TaskRecord } from './task-contract'
import {
  createTaskProgressState,
  forgetTaskProgress,
  readTaskProgress,
  recordTaskProgress,
  type TaskProgressLimits,
  type TaskProgressRecord,
  type TaskProgressUpdate
} from './task-progress'

const owner: TaskOwner = {
  webContentsId: 4,
  frameId: '7:2',
  isTopFrame: true,
  authSessionGeneration: 8,
  contextRevision: 13
}

const limits: TaskProgressLimits = {
  maxTrackedTasks: 2,
  maxLabelBytes: 32,
  maxDetailBytes: 64,
  maxWorkUnits: 100
}

function task(
  taskId: string,
  revision = 1,
  status: TaskRecord['status'] = 'dispatching',
  taskOwner = owner
): TaskRecord {
  return {
    taskId,
    revision,
    taskType: 'provided-by-owner',
    owner: taskOwner,
    argumentsDigest: `digest:${taskId}`,
    scope: { capabilities: ['provided-by-owner'], resources: {} },
    createdAt: 10,
    retentionMs: 500,
    expiresAt: 510,
    status
  }
}

function update(taskId: string, overrides: Partial<TaskProgressUpdate> = {}): TaskProgressUpdate {
  return {
    taskId,
    taskRevision: 1,
    owner,
    sequence: 1,
    completedUnits: 1,
    totalUnits: 10,
    label: 'Working',
    ...overrides
  }
}

describe('WP07 bounded task progress contract', () => {
  it('accepts ordered updates only for the current dispatching owner and revision', () => {
    const first = recordTaskProgress(createTaskProgressState(), task('task-a'), false, update('task-a'), limits)
    expect(first.accepted).toBe(true)
    if (!first.accepted) return
    expect(
      recordTaskProgress(first.state, task('task-a'), false, update('task-a', { sequence: 1 }), limits)
    ).toMatchObject({ accepted: false, reason: 'sequence-conflict' })
    expect(
      recordTaskProgress(first.state, task('task-a'), false, update('task-a', { sequence: 2, taskRevision: 2 }), limits)
    ).toMatchObject({ accepted: false, reason: 'stale-task-revision' })
    expect(
      recordTaskProgress(
        first.state,
        task('task-a'),
        false,
        update('task-a', { sequence: 2, owner: { ...owner, contextRevision: 14 } }),
        limits
      )
    ).toMatchObject({ accepted: false, reason: 'wrong-owner' })
    expect(
      recordTaskProgress(first.state, task('task-a', 1, 'paused'), false, update('task-a', { sequence: 2 }), limits)
    ).toMatchObject({ accepted: false, reason: 'task-not-dispatching' })
    expect(
      recordTaskProgress(first.state, task('task-a'), true, update('task-a', { sequence: 2 }), limits)
    ).toMatchObject({ accepted: false, reason: 'owner-rebind-required' })
  })

  it('resets sequence only on a new task revision and snapshots the owner', () => {
    const mutableOwner = { ...owner }
    const initial = recordTaskProgress(
      createTaskProgressState(),
      task('task-a'),
      false,
      update('task-a', { owner: mutableOwner }),
      limits
    )
    expect(initial.accepted).toBe(true)
    if (!initial.accepted) return
    mutableOwner.contextRevision = 99
    expect(initial.record.owner.contextRevision).toBe(owner.contextRevision)

    const nextRevision = recordTaskProgress(
      initial.state,
      task('task-a', 2),
      false,
      update('task-a', { taskRevision: 2, sequence: 1 }),
      limits
    )
    expect(nextRevision.accepted).toBe(true)

    const newOwner = { ...owner, authSessionGeneration: owner.authSessionGeneration + 1 }
    const newOwnerUpdate = recordTaskProgress(
      initial.state,
      task('task-a', 1, 'dispatching', newOwner),
      false,
      update('task-a', { owner: newOwner, sequence: 1 }),
      limits
    )
    expect(newOwnerUpdate.accepted).toBe(true)
  })

  it('reads progress only while task status, owner, revision, and rebind fence still match', () => {
    const recorded = recordTaskProgress(createTaskProgressState(), task('task-a'), false, update('task-a'), limits)
    expect(recorded.accepted).toBe(true)
    if (!recorded.accepted) return

    expect(readTaskProgress(recorded.state, task('task-a'), false, owner)).toEqual(recorded.record)
    expect(readTaskProgress(recorded.state, task('task-a', 1, 'paused'), false, owner)).toBeUndefined()
    expect(readTaskProgress(recorded.state, task('task-a', 1, 'cancelled'), false, owner)).toBeUndefined()
    expect(readTaskProgress(recorded.state, task('task-a', 2), false, owner)).toBeUndefined()
    expect(
      readTaskProgress(recorded.state, { ...task('task-a'), owner: { ...owner, contextRevision: 14 } }, false, owner)
    ).toBeUndefined()
    expect(readTaskProgress(recorded.state, task('task-a'), true, owner)).toBeUndefined()
    expect(readTaskProgress(recorded.state, task('task-a'), false, { ...owner, webContentsId: 5 })).toBeUndefined()

    const malformedRecord = { ...recorded.record, taskId: 'task-b' } as TaskProgressRecord
    const malformedState = { latestByTask: new Map([['task-a', malformedRecord]]) }
    expect(readTaskProgress(malformedState, task('task-a'), false, owner)).toBeUndefined()
    const invalidOwnerRecord = {
      ...recorded.record,
      owner: { ...owner, isTopFrame: false }
    } as unknown as TaskProgressRecord
    expect(
      readTaskProgress({ latestByTask: new Map([['task-a', invalidOwnerRecord]]) }, task('task-a'), false, owner)
    ).toBeUndefined()
  })

  it('requires explicit work, text, and tracked-task bounds', () => {
    expect(
      recordTaskProgress(
        createTaskProgressState(),
        task('task-a'),
        false,
        update('task-a', { totalUnits: 101 }),
        limits
      )
    ).toMatchObject({ accepted: false, reason: 'limit-exceeded' })
    expect(
      recordTaskProgress(createTaskProgressState(), task('task-a'), false, update('task-a', { label: '🍋' }), {
        ...limits,
        maxLabelBytes: 3
      })
    ).toMatchObject({ accepted: false, reason: 'limit-exceeded' })

    const first = recordTaskProgress(createTaskProgressState(), task('task-a'), false, update('task-a'), {
      ...limits,
      maxTrackedTasks: 1
    })
    expect(first.accepted).toBe(true)
    if (!first.accepted) return
    expect(
      recordTaskProgress(first.state, task('task-b'), false, update('task-b'), { ...limits, maxTrackedTasks: 1 })
    ).toMatchObject({ accepted: false, reason: 'limit-exceeded' })
    const forgotten = forgetTaskProgress(first.state, 'task-a')
    expect(
      recordTaskProgress(forgotten, task('task-b'), false, update('task-b'), { ...limits, maxTrackedTasks: 1 }).accepted
    ).toBe(true)
  })
})
