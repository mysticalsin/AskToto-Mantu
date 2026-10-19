import type { TaskOwner, TaskRecord } from './task-contract'

/** Limits come from the embedding owner; this progress contract defines no implicit budget. */
export interface TaskProgressLimits {
  readonly maxTrackedTasks: number
  readonly maxLabelBytes: number
  readonly maxDetailBytes: number
  readonly maxWorkUnits: number
}

/** Progress is an ephemeral, latest-value projection. It is not a dispatch receipt or durable output. */
export interface TaskProgressUpdate {
  readonly taskId: string
  readonly taskRevision: number
  readonly owner: TaskOwner
  /** Starts at 1 for each task revision and must advance exactly once per accepted update. */
  readonly sequence: number
  readonly completedUnits: number
  readonly totalUnits: number
  /** Opaque bounded text; callers must choose its meaning and render it as untrusted content. */
  readonly label: string
  readonly detail?: string
}

export type TaskProgressRecord = TaskProgressUpdate

export interface TaskProgressState {
  readonly latestByTask: ReadonlyMap<string, TaskProgressRecord>
}

export type TaskProgressRejection =
  | 'invalid-input'
  | 'unknown-task'
  | 'owner-rebind-required'
  | 'stale-task-revision'
  | 'wrong-owner'
  | 'task-not-dispatching'
  | 'sequence-conflict'
  | 'limit-exceeded'

export type TaskProgressResult =
  | { readonly accepted: true; readonly state: TaskProgressState; readonly record: TaskProgressRecord }
  | { readonly accepted: false; readonly state: TaskProgressState; readonly reason: TaskProgressRejection }

export function createTaskProgressState(): TaskProgressState {
  return { latestByTask: new Map() }
}

/** Drop an ephemeral latest-value record when its embedding owner no longer tracks the task. */
export function forgetTaskProgress(state: TaskProgressState, taskId: string): TaskProgressState {
  if (!state.latestByTask.has(taskId)) return state
  const latestByTask = new Map(state.latestByTask)
  latestByTask.delete(taskId)
  return { latestByTask }
}

/**
 * Read progress only while its task, owner, revision, and lifecycle are still current.
 * The requesting owner is checked independently so the projection cannot be used cross-owner.
 */
export function readTaskProgress(
  state: TaskProgressState,
  task: TaskRecord | undefined,
  ownerRebindRequired: boolean,
  requestingOwner: TaskOwner
): TaskProgressRecord | undefined {
  if (!task || ownerRebindRequired || task.status !== 'dispatching' || !validOwner(requestingOwner)) return undefined
  const record = state.latestByTask.get(task.taskId)
  if (!record || record.taskId !== task.taskId || !validOwner(record.owner) || record.taskRevision !== task.revision || !sameOwner(record.owner, task.owner) ||
      !sameOwner(record.owner, requestingOwner)) return undefined
  return record
}

function validLimits(limits: TaskProgressLimits): boolean {
  return !!limits && Number.isSafeInteger(limits.maxTrackedTasks) && limits.maxTrackedTasks > 0 &&
    Number.isSafeInteger(limits.maxLabelBytes) && limits.maxLabelBytes > 0 &&
    Number.isSafeInteger(limits.maxDetailBytes) && limits.maxDetailBytes > 0 &&
    Number.isFinite(limits.maxWorkUnits) && limits.maxWorkUnits > 0
}

function utf8LengthWithin(value: string, maximum: number): boolean {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3
    if (bytes > maximum) return false
  }
  return true
}

function validOwner(owner: TaskOwner): boolean {
  return !!owner && Number.isSafeInteger(owner.webContentsId) && owner.webContentsId > 0 &&
    typeof owner.frameId === 'string' && owner.frameId.length > 0 && owner.frameId.length <= 256 &&
    owner.isTopFrame === true && Number.isSafeInteger(owner.authSessionGeneration) && owner.authSessionGeneration >= 0 &&
    Number.isSafeInteger(owner.contextRevision) && owner.contextRevision >= 0
}

function sameOwner(left: TaskOwner, right: TaskOwner): boolean {
  return left.webContentsId === right.webContentsId && left.frameId === right.frameId && left.isTopFrame === right.isTopFrame &&
    left.authSessionGeneration === right.authSessionGeneration && left.contextRevision === right.contextRevision
}

function reject(state: TaskProgressState, reason: TaskProgressRejection): TaskProgressResult {
  return { accepted: false, state, reason }
}

/**
 * Accept one bounded progress update for the currently dispatching owner/revision.
 * This standalone projection has no persistence, IPC, renderer caller, or steering authority.
 */
export function recordTaskProgress(
  state: TaskProgressState,
  task: TaskRecord | undefined,
  ownerRebindRequired: boolean,
  update: TaskProgressUpdate,
  limits: TaskProgressLimits
): TaskProgressResult {
  if (!validLimits(limits) || !update || typeof update.taskId !== 'string' || update.taskId.length === 0 ||
      !Number.isSafeInteger(update.taskRevision) || update.taskRevision <= 0 || !Number.isSafeInteger(update.sequence) || update.sequence <= 0 ||
      !Number.isFinite(update.completedUnits) || update.completedUnits < 0 || !Number.isFinite(update.totalUnits) ||
      update.totalUnits <= 0 || update.completedUnits > update.totalUnits || typeof update.label !== 'string' || !update.label ||
      (update.detail !== undefined && typeof update.detail !== 'string')) return reject(state, 'invalid-input')
  if (update.totalUnits > limits.maxWorkUnits || !utf8LengthWithin(update.label, limits.maxLabelBytes) ||
      (update.detail !== undefined && !utf8LengthWithin(update.detail, limits.maxDetailBytes))) return reject(state, 'limit-exceeded')
  if (!task || update.taskId !== task.taskId) return reject(state, 'unknown-task')
  if (ownerRebindRequired) return reject(state, 'owner-rebind-required')
  if (update.taskRevision !== task.revision) return reject(state, 'stale-task-revision')
  if (!validOwner(update.owner) || !sameOwner(update.owner, task.owner)) return reject(state, 'wrong-owner')
  if (task.status !== 'dispatching') return reject(state, 'task-not-dispatching')

  const previous = state.latestByTask.get(task.taskId)
  const expectedSequence = previous?.taskRevision === task.revision && sameOwner(previous.owner, task.owner)
    ? previous.sequence + 1
    : 1
  if (update.sequence !== expectedSequence) return reject(state, 'sequence-conflict')
  if (!previous && state.latestByTask.size >= limits.maxTrackedTasks) return reject(state, 'limit-exceeded')

  const record = Object.freeze({
    ...update,
    owner: Object.freeze({ ...update.owner })
  })
  const latestByTask = new Map(state.latestByTask)
  latestByTask.set(task.taskId, record)
  return { accepted: true, state: { latestByTask }, record }
}
