import { isErasureFenced } from '../memory-partition/erasure-fence'
import type { TaskRuntimeState } from './task-contract'

/**
 * G82 no-resurrection: true when a recovered task archive holds a task created before the owner erased their data. Such
 * an archive is erased data (a late writer or a restored copy) and is treated as absent, never recovered. The archive is
 * judged whole because its attempts and grants refer to its tasks; dropping tasks one by one would break that history.
 */
export function archivePredatesErasure(state: TaskRuntimeState): boolean {
  for (const task of state.tasks.values()) if (isErasureFenced(task.createdAt)) return true
  return false
}
