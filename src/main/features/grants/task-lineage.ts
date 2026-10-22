/**
 * Grant scope from G06 task lineage. A task grant is bound to the ROOT of a lineage, so a helper delegated from
 * the approved task inherits it and an unrelated task never does. Pausing for usage (`quota_paused`) keeps the
 * lineage alive and therefore keeps the grant; only a completed or cancelled root ends it.
 */
import type { TaskRuntimeState } from '../../tasks/task-contract'
import { lineage } from '../../tasks/task-state-internal'

/** The id a task grant binds to, or null for a task main does not know. */
export function taskLineageRootId(state: TaskRuntimeState, taskId: string): string | null {
  const task = state.tasks.get(taskId)
  if (!task) return null
  const chain = lineage(state, task)
  return chain[chain.length - 1]?.taskId ?? null
}

/** Lineage roots whose task is over. The caller revokes the grants bound to each. */
export function endedTaskLineageRoots(state: TaskRuntimeState): string[] {
  const ended: string[] = []
  for (const task of state.tasks.values()) {
    if (task.parentTaskId === undefined && (task.status === 'completed' || task.status === 'cancelled')) {
      ended.push(task.taskId)
    }
  }
  return ended
}
