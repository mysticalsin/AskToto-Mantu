import type { TaskRecord, TaskRuntimeState, TaskStatus } from './task-contract'
import type { TaskStateCodecLimits } from './task-persistence'

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

/** Drop expired history and, when near the archive cap, the oldest finished tasks. Uncertain work is kept until it expires. */
export function pruneState(state: TaskRuntimeState, now: number, limits: TaskStateCodecLimits): TaskRuntimeState {
  const tasks = new Map<string, TaskRecord>()
  for (const task of state.tasks.values()) {
    if (task.status === 'dispatching' || task.expiresAt > now) tasks.set(task.taskId, task)
  }
  if (tasks.size >= limits.maxTasks) {
    const finished = [...tasks.values()]
      .filter((task) => isTerminal(task.status))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const task of finished) {
      if (tasks.size < limits.maxTasks) break
      tasks.delete(task.taskId)
    }
  }
  const attempts = new Map([...state.attempts].filter(([, attempt]) => tasks.has(attempt.taskId)))
  const retainedGrantIds = new Set([...attempts.values()].map((attempt) => attempt.grantId))
  // After a restart no live grant exists, so a tombstone only matters while its attempt is still recorded.
  const consumedGrantIds =
    state.consumedGrantIds.size >= limits.maxConsumedGrantIds - 8 ? retainedGrantIds : state.consumedGrantIds
  return { ...state, tasks, attempts, consumedGrantIds }
}

export function archiveHasRoom(state: TaskRuntimeState, limits: TaskStateCodecLimits): boolean {
  return state.tasks.size < limits.maxTasks && state.attempts.size < limits.maxAttempts
}
