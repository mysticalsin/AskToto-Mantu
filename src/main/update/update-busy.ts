import type { TaskStatus } from '../tasks/task-contract'
import type { ImportJobState } from '@shared/import-jobs'
import type { UpdateBusyReason } from '@shared/update-lifecycle'

export interface UpdateBusyInput {
  /** A meeting reservation exists (InputSessionAuthority.hasMeetingReservation). */
  meetingReserved: boolean
  /** Any capture flag main tracks: listening, armed audio, legacy listening, cloud speech owner. */
  captureActive: boolean
  /** The active input lease's purpose, or null. */
  leasePurpose: string | null
  taskStatuses: readonly TaskStatus[]
  importStates: readonly ImportJobState[]
}

const LIVE_TASK: ReadonlySet<TaskStatus> = new Set(['planning', 'ready', 'dispatching', 'uncertain'])
const LIVE_IMPORT: ReadonlySet<ImportJobState> = new Set(['queued', 'decoding', 'transcribing', 'saving', 'recapping'])

/**
 * Why an update must not relaunch the app right now. Stable order, no duplicates. `paused` and `quota_paused`
 * tasks are persisted and resumable, so they do not hold an install back.
 */
export function updateBusyReasons(input: UpdateBusyInput): UpdateBusyReason[] {
  const reasons: UpdateBusyReason[] = []
  if (input.meetingReserved || input.captureActive) reasons.push('meeting')
  if (input.leasePurpose === 'dictation') reasons.push('dictation')
  else if (input.leasePurpose !== null) reasons.push('conversation')
  if (input.taskStatuses.some((s) => LIVE_TASK.has(s))) reasons.push('task')
  if (input.importStates.some((s) => LIVE_IMPORT.has(s))) reasons.push('import')
  return reasons
}
