import type {
  EffectOutcome,
  TaskAttempt,
  TaskOwner,
  TaskRecord,
  TaskRuntimeState,
  TaskScope,
  TaskStatus
} from './task-contract'
import { cloneTaskRecoveryOwner, isTaskRecoveryOwner } from './task-recovery-owner'

/**
 * Archive versions. The encoder writes the lowest version that can represent the state, so an archive that uses
 * no v2 feature stays readable by a build that only knows v1 (rollback). A v2 archive is only written once a task
 * actually uses a planning or quota_paused state, a multi-step flag, or metered usage. An older build then rejects
 * it as `unsupported-version` and the bridge sets it aside instead of misreading it. V3 adds stable recovery-owner
 * attribution and is written only when that metadata is present; pre-v3 builds reject it as unsupported.
 */
const ARCHIVE_VERSION_V1 = 1
const ARCHIVE_VERSION_V2 = 2
const ARCHIVE_VERSION_V3 = 3
const V1_TASK_STATUSES = ['ready', 'dispatching', 'paused', 'cancelled', 'completed', 'uncertain'] as const
const V2_TASK_STATUSES = new Set<TaskStatus>([...V1_TASK_STATUSES, 'planning', 'quota_paused'])
const V1_TASK_STATUS_SET = new Set<TaskStatus>(V1_TASK_STATUSES)
const V2_ONLY_STATUSES = new Set<TaskStatus>(['planning', 'quota_paused'])
const V2_TASK_KEYS = ['multiStep', 'stepsCompleted', 'usedResources'] as const
const EFFECT_OUTCOMES = new Set<EffectOutcome>(['applied', 'not-applied', 'uncertain'])
const ATTEMPT_STATUSES = new Set<TaskAttempt['status']>(['authorized', 'uncertain', 'settled', 'reconciled'])

interface TaskRuntimeArchive {
  readonly version: 1 | 2 | 3
  readonly tasks: readonly TaskRecord[]
  readonly attempts: readonly TaskAttempt[]
  readonly consumedGrantIds: readonly string[]
}

/** The embedding owner must choose every archive budget; this codec has no implicit storage policy. */
export interface TaskStateCodecLimits {
  readonly maxBytes: number
  readonly maxTasks: number
  readonly maxAttempts: number
  readonly maxConsumedGrantIds: number
  readonly maxCapabilitiesPerScope: number
  readonly maxResourcesPerScope: number
}

/** The future IO adapter reports these outcomes without conflating missing, unreadable, and corrupt state. */
export type TaskStateReadResult =
  | { readonly kind: 'found'; readonly serialized: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable'; readonly reason: string }

export type TaskStateLoadResult =
  | { readonly kind: 'loaded'; readonly state: TaskRuntimeState }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'corrupt'
      readonly reason:
        | 'invalid-json'
        | 'unsupported-version'
        | 'invalid-shape'
        | 'inconsistent-history'
        | 'limit-exceeded'
    }

function assertLimits(limits: TaskStateCodecLimits): void {
  if (
    !limits ||
    ![
      'maxBytes',
      'maxTasks',
      'maxAttempts',
      'maxConsumedGrantIds',
      'maxCapabilitiesPerScope',
      'maxResourcesPerScope'
    ].every(
      (key) =>
        Number.isSafeInteger(limits[key as keyof TaskStateCodecLimits]) && limits[key as keyof TaskStateCodecLimits] > 0
    )
  ) {
    throw new TypeError('Task state codec limits must be explicit positive safe integers')
  }
}

function withinByteLimit(value: string, maxBytes: number): boolean {
  let bytes = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4
      i += 1
    } else bytes += 3
    if (bytes > maxBytes) return false
  }
  return true
}

function nestedScopeLimitExceeded(
  tasks: readonly unknown[],
  attempts: readonly unknown[],
  limits: TaskStateCodecLimits
): boolean {
  for (const task of tasks) {
    if (!isObject(task) || !isObject(task.scope)) continue
    if (
      (Array.isArray(task.scope.capabilities) && task.scope.capabilities.length > limits.maxCapabilitiesPerScope) ||
      (isObject(task.scope.resources) && Object.keys(task.scope.resources).length > limits.maxResourcesPerScope)
    )
      return true
  }
  for (const attempt of attempts) {
    if (!isObject(attempt) || !isObject(attempt.scope)) continue
    if (isObject(attempt.scope.resources) && Object.keys(attempt.scope.resources).length > limits.maxResourcesPerScope)
      return true
  }
  return false
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  // An explicitly undefined field is an absent field (it never survives JSON).
  const keys = Object.keys(value).filter((key) => value[key] !== undefined)
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function isOwner(value: unknown): value is TaskOwner {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ['webContentsId', 'frameId', 'isTopFrame', 'authSessionGeneration', 'contextRevision'])
  )
    return false
  return (
    Number.isSafeInteger(value.webContentsId) &&
    (value.webContentsId as number) > 0 &&
    typeof value.frameId === 'string' &&
    value.frameId.length > 0 &&
    value.frameId.length <= 256 &&
    value.isTopFrame === true &&
    Number.isSafeInteger(value.authSessionGeneration) &&
    (value.authSessionGeneration as number) >= 0 &&
    Number.isSafeInteger(value.contextRevision) &&
    (value.contextRevision as number) >= 0
  )
}

function isResources(value: unknown): value is Readonly<Record<string, number>> {
  return (
    isObject(value) &&
    Object.entries(value).every(
      ([key, amount]) => key.length > 0 && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
    )
  )
}

function isTaskScope(value: unknown): value is TaskScope {
  return (
    isObject(value) &&
    hasExactKeys(value, ['capabilities', 'resources']) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === 'string' && capability.length > 0) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    isResources(value.resources)
  )
}

function usesV2(task: TaskRecord): boolean {
  return V2_ONLY_STATUSES.has(task.status) || V2_TASK_KEYS.some((key) => task[key] !== undefined)
}

function usesV3(task: TaskRecord): boolean {
  return task.recoveryOwner !== undefined
}

function isTaskRecord(value: unknown, limits: TaskStateCodecLimits, version: 1 | 2 | 3 = 2): value is TaskRecord {
  if (
    !isObject(value) ||
    !hasExactKeys(
      value,
      [
        'taskId',
        'revision',
        'taskType',
        'owner',
        'argumentsDigest',
        'scope',
        'createdAt',
        'retentionMs',
        'status',
        'expiresAt'
      ],
      [
        'parentTaskId',
        'parentTaskRevision',
        'effectOutcome',
        'activeAttemptId',
        'lastAttemptId',
        ...(version >= 2 ? V2_TASK_KEYS : []),
        ...(version >= 3 ? ['recoveryOwner'] : [])
      ]
    )
  )
    return false
  const task = value
  const baseValid =
    typeof task.taskId === 'string' &&
    task.taskId.length > 0 &&
    Number.isSafeInteger(task.revision) &&
    (task.revision as number) > 0 &&
    typeof task.taskType === 'string' &&
    task.taskType.length > 0 &&
    isOwner(task.owner) &&
    typeof task.argumentsDigest === 'string' &&
    task.argumentsDigest.length > 0 &&
    isTaskScope(task.scope) &&
    task.scope.capabilities.length <= limits.maxCapabilitiesPerScope &&
    Object.keys(task.scope.resources).length <= limits.maxResourcesPerScope &&
    typeof task.createdAt === 'number' &&
    Number.isFinite(task.createdAt) &&
    typeof task.retentionMs === 'number' &&
    Number.isFinite(task.retentionMs) &&
    task.retentionMs >= 0 &&
    typeof task.expiresAt === 'number' &&
    Number.isFinite(task.expiresAt) &&
    task.expiresAt === task.createdAt + task.retentionMs &&
    typeof task.status === 'string' &&
    (version >= 2 ? V2_TASK_STATUSES : V1_TASK_STATUS_SET).has(task.status as TaskStatus)
  if (!baseValid) return false
  if (!isV2TaskFieldsValid(task)) return false
  if (task.recoveryOwner !== undefined && (version < 3 || !isTaskRecoveryOwner(task.recoveryOwner))) return false
  if (task.parentTaskId !== undefined && (typeof task.parentTaskId !== 'string' || task.parentTaskId.length === 0))
    return false
  if (
    task.parentTaskRevision !== undefined &&
    (!Number.isSafeInteger(task.parentTaskRevision) || (task.parentTaskRevision as number) <= 0)
  )
    return false
  if ((task.parentTaskId === undefined) !== (task.parentTaskRevision === undefined)) return false
  if (
    task.effectOutcome !== undefined &&
    (typeof task.effectOutcome !== 'string' || !EFFECT_OUTCOMES.has(task.effectOutcome as EffectOutcome))
  )
    return false
  if (
    task.activeAttemptId !== undefined &&
    (typeof task.activeAttemptId !== 'string' || task.activeAttemptId.length === 0)
  )
    return false
  if (task.lastAttemptId !== undefined && (typeof task.lastAttemptId !== 'string' || task.lastAttemptId.length === 0))
    return false
  if (task.status === 'dispatching') {
    if (!task.activeAttemptId || task.lastAttemptId !== task.activeAttemptId) return false
  } else if (task.activeAttemptId !== undefined) return false
  return true
}

function isV2TaskFieldsValid(task: Record<string, unknown>): boolean {
  if (task.multiStep !== undefined && typeof task.multiStep !== 'boolean') return false
  if (
    task.stepsCompleted !== undefined &&
    (task.multiStep !== true || !Number.isSafeInteger(task.stepsCompleted) || (task.stepsCompleted as number) < 0)
  )
    return false
  if (task.usedResources !== undefined) {
    if (!isResources(task.usedResources)) return false
    const ceiling = (task.scope as TaskScope).resources
    // Metered usage can never exceed the approved budget, and only names a budgeted resource.
    if (
      !Object.entries(task.usedResources).every(
        ([key, used]) => Object.prototype.hasOwnProperty.call(ceiling, key) && used <= ceiling[key]!
      )
    )
      return false
  }
  // Helpers are created under an approved parent, so one can never be in planning.
  if (task.status === 'planning' && task.parentTaskId !== undefined) return false
  return true
}

function isTaskAttempt(value: unknown, limits: TaskStateCodecLimits): value is TaskAttempt {
  if (
    !isObject(value) ||
    !hasExactKeys(
      value,
      ['attemptId', 'taskId', 'taskRevision', 'grantId', 'owner', 'argumentsDigest', 'scope', 'authorizedAt', 'status'],
      ['outcome']
    )
  )
    return false
  const attempt = value
  return (
    typeof attempt.attemptId === 'string' &&
    attempt.attemptId.length > 0 &&
    typeof attempt.taskId === 'string' &&
    attempt.taskId.length > 0 &&
    Number.isSafeInteger(attempt.taskRevision) &&
    (attempt.taskRevision as number) > 0 &&
    typeof attempt.grantId === 'string' &&
    attempt.grantId.length > 0 &&
    isOwner(attempt.owner) &&
    typeof attempt.argumentsDigest === 'string' &&
    attempt.argumentsDigest.length > 0 &&
    isObject(attempt.scope) &&
    hasExactKeys(attempt.scope, ['capability', 'resources']) &&
    typeof attempt.scope.capability === 'string' &&
    attempt.scope.capability.length > 0 &&
    isResources(attempt.scope.resources) &&
    Object.keys(attempt.scope.resources).length <= limits.maxResourcesPerScope &&
    typeof attempt.authorizedAt === 'number' &&
    Number.isFinite(attempt.authorizedAt) &&
    typeof attempt.status === 'string' &&
    ATTEMPT_STATUSES.has(attempt.status as TaskAttempt['status']) &&
    (attempt.outcome === undefined ||
      (typeof attempt.outcome === 'string' && EFFECT_OUTCOMES.has(attempt.outcome as EffectOutcome)))
  )
}

function freezeOwner(owner: TaskOwner): TaskOwner {
  return Object.freeze({ ...owner })
}

function freezeScope(scope: TaskScope): TaskScope {
  return Object.freeze({
    capabilities: Object.freeze([...scope.capabilities]),
    resources: Object.freeze({ ...scope.resources })
  })
}

function freezeGrantScope(scope: TaskAttempt['scope']): TaskAttempt['scope'] {
  return Object.freeze({ capability: scope.capability, resources: Object.freeze({ ...scope.resources }) })
}

function freezeTask(task: TaskRecord): TaskRecord {
  return Object.freeze({
    ...task,
    owner: freezeOwner(task.owner),
    scope: freezeScope(task.scope),
    ...(task.recoveryOwner ? { recoveryOwner: cloneTaskRecoveryOwner(task.recoveryOwner)! } : {})
  })
}

function freezeAttempt(attempt: TaskAttempt): TaskAttempt {
  return Object.freeze({ ...attempt, owner: freezeOwner(attempt.owner), scope: freezeGrantScope(attempt.scope) })
}

function sameOwner(a: TaskOwner, b: TaskOwner): boolean {
  return (
    a.webContentsId === b.webContentsId &&
    a.frameId === b.frameId &&
    a.isTopFrame === b.isTopFrame &&
    a.authSessionGeneration === b.authSessionGeneration &&
    a.contextRevision === b.contextRevision
  )
}

function sameResources(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

function sameAttemptSnapshotDetails(task: TaskRecord, attempt: TaskAttempt): boolean {
  return (
    task.taskId === attempt.taskId &&
    sameOwner(task.owner, attempt.owner) &&
    task.argumentsDigest === attempt.argumentsDigest &&
    task.scope.capabilities.includes(attempt.scope.capability) &&
    Object.entries(attempt.scope.resources).every(
      ([key, amount]) => task.scope.resources[key] !== undefined && amount <= task.scope.resources[key]!
    )
  )
}

function sameAttemptSnapshot(task: TaskRecord, attempt: TaskAttempt): boolean {
  return task.revision === attempt.taskRevision && sameAttemptSnapshotDetails(task, attempt)
}

function isStrictlyNarrowerScope(child: TaskScope, parent: TaskScope): boolean {
  if (
    !child.capabilities.every((capability) => parent.capabilities.includes(capability)) ||
    Object.entries(child.resources).some(
      ([key, amount]) => parent.resources[key] === undefined || amount > parent.resources[key]!
    )
  )
    return false
  const sameCapabilities =
    child.capabilities.length === parent.capabilities.length &&
    child.capabilities.every((capability) => parent.capabilities.includes(capability))
  const childKeys = Object.keys(child.resources)
  const parentKeys = Object.keys(parent.resources)
  const sameResources =
    childKeys.length === parentKeys.length && childKeys.every((key) => child.resources[key] === parent.resources[key])
  return !(sameCapabilities && sameResources)
}

/**
 * Encode durable task and attempt history plus consumed-grant tombstones. Live runtime grants are
 * excluded; the caller must choose storage, encryption, retention, and principal policies separately.
 */
export function encodeTaskRuntimeState(state: TaskRuntimeState, limits: TaskStateCodecLimits): string {
  assertLimits(limits)
  const tasks = [...state.tasks.values()]
  const version: 1 | 2 | 3 = tasks.some(usesV3)
    ? ARCHIVE_VERSION_V3
    : tasks.some(usesV2)
      ? ARCHIVE_VERSION_V2
      : ARCHIVE_VERSION_V1
  if (
    state.tasks.size > limits.maxTasks ||
    state.attempts.size > limits.maxAttempts ||
    state.consumedGrantIds.size > limits.maxConsumedGrantIds ||
    [...state.tasks.values()].some((task) => !isTaskRecord(task, limits, version)) ||
    [...state.attempts.values()].some((attempt) => !isTaskAttempt(attempt, limits))
  ) {
    throw new RangeError('Task state exceeds the explicit archive limits or has invalid records')
  }
  const archive: TaskRuntimeArchive = {
    version,
    tasks: [...state.tasks.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    attempts: [...state.attempts.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    consumedGrantIds: [...state.consumedGrantIds].sort()
  }
  const serialized = JSON.stringify(archive)
  if (!withinByteLimit(serialized, limits.maxBytes)) throw new RangeError('Task state archive exceeds maxBytes')
  return serialized
}

/**
 * Decode an adapter result and recover it behind an owner-rebind fence. No filesystem or encryption
 * policy is selected here. The future main-owned owner-rebind decision must clear the fence explicitly.
 */
export function decodeTaskRuntimeState(read: TaskStateReadResult, limits: TaskStateCodecLimits): TaskStateLoadResult {
  assertLimits(limits)
  if (read.kind === 'not-found') return { kind: 'not-found' }
  if (read.kind === 'unavailable') return { kind: 'unavailable', reason: read.reason }
  if (!withinByteLimit(read.serialized, limits.maxBytes)) return { kind: 'corrupt', reason: 'limit-exceeded' }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.serialized)
  } catch {
    return { kind: 'corrupt', reason: 'invalid-json' }
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, ['version', 'tasks', 'attempts', 'consumedGrantIds'])) {
    return { kind: 'corrupt', reason: 'invalid-shape' }
  }
  // v1 archives are read as they always were; a v1 label never admits a v2 field or status.
  if (
    parsed.version !== ARCHIVE_VERSION_V1 &&
    parsed.version !== ARCHIVE_VERSION_V2 &&
    parsed.version !== ARCHIVE_VERSION_V3
  ) {
    return { kind: 'corrupt', reason: 'unsupported-version' }
  }
  const version = parsed.version
  if (
    Array.isArray(parsed.tasks) &&
    Array.isArray(parsed.attempts) &&
    nestedScopeLimitExceeded(parsed.tasks, parsed.attempts, limits)
  ) {
    return { kind: 'corrupt', reason: 'limit-exceeded' }
  }
  if (
    !Array.isArray(parsed.tasks) ||
    parsed.tasks.length > limits.maxTasks ||
    !parsed.tasks.every((item) => isTaskRecord(item, limits, version)) ||
    !Array.isArray(parsed.attempts) ||
    parsed.attempts.length > limits.maxAttempts ||
    !parsed.attempts.every((item) => isTaskAttempt(item, limits)) ||
    !Array.isArray(parsed.consumedGrantIds) ||
    parsed.consumedGrantIds.length > limits.maxConsumedGrantIds ||
    !parsed.consumedGrantIds.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    if (
      (Array.isArray(parsed.tasks) && parsed.tasks.length > limits.maxTasks) ||
      (Array.isArray(parsed.attempts) && parsed.attempts.length > limits.maxAttempts) ||
      (Array.isArray(parsed.consumedGrantIds) && parsed.consumedGrantIds.length > limits.maxConsumedGrantIds)
    ) {
      return { kind: 'corrupt', reason: 'limit-exceeded' }
    }
    return { kind: 'corrupt', reason: 'invalid-shape' }
  }
  if (new Set(parsed.consumedGrantIds).size !== parsed.consumedGrantIds.length)
    return { kind: 'corrupt', reason: 'inconsistent-history' }

  const tasks = new Map<string, TaskRecord>()
  for (const raw of parsed.tasks) {
    if (tasks.has(raw.taskId)) return { kind: 'corrupt', reason: 'inconsistent-history' }
    tasks.set(raw.taskId, raw)
  }
  const attempts = new Map<string, TaskAttempt>()
  for (const raw of parsed.attempts) {
    if (attempts.has(raw.attemptId) || !tasks.has(raw.taskId))
      return { kind: 'corrupt', reason: 'inconsistent-history' }
    attempts.set(raw.attemptId, raw)
  }
  const consumedGrantIds = new Set(parsed.consumedGrantIds as string[])
  const attemptGrantIds = new Set<string>()
  for (const attempt of attempts.values()) {
    if (attemptGrantIds.has(attempt.grantId) || !consumedGrantIds.has(attempt.grantId))
      return { kind: 'corrupt', reason: 'inconsistent-history' }
    attemptGrantIds.add(attempt.grantId)
  }
  for (const task of tasks.values()) {
    if (task.parentTaskId) {
      const parent = tasks.get(task.parentTaskId)
      if (!parent) return { kind: 'corrupt', reason: 'inconsistent-history' }
      if (task.status !== 'completed' && task.status !== 'cancelled') {
        if (
          parent.revision !== task.parentTaskRevision ||
          !sameOwner(parent.owner, task.owner) ||
          task.expiresAt > parent.expiresAt ||
          !isStrictlyNarrowerScope(task.scope, parent.scope)
        ) {
          return { kind: 'corrupt', reason: 'inconsistent-history' }
        }
        if (!['ready', 'dispatching', 'paused', 'quota_paused'].includes(parent.status))
          return { kind: 'corrupt', reason: 'inconsistent-history' }
        if (parent.status === 'paused' && task.status !== 'paused')
          return { kind: 'corrupt', reason: 'inconsistent-history' }
      }
    }
    if (task.lastAttemptId) {
      const lastAttempt = attempts.get(task.lastAttemptId)
      if (!lastAttempt || lastAttempt.taskId !== task.taskId) return { kind: 'corrupt', reason: 'inconsistent-history' }
    }
    if (
      (task.status === 'uncertain' && task.effectOutcome !== 'uncertain') ||
      // A multi-step task completes explicitly, so its completion needs no applied effect of its own.
      (task.status === 'completed' && task.effectOutcome !== 'applied' && task.multiStep !== true) ||
      (task.effectOutcome === 'applied' && task.status !== 'completed' && task.status !== 'cancelled') ||
      ((task.status === 'ready' ||
        task.status === 'dispatching' ||
        task.status === 'planning' ||
        task.status === 'quota_paused') &&
        (task.effectOutcome === 'applied' || task.effectOutcome === 'uncertain'))
    ) {
      return { kind: 'corrupt', reason: 'inconsistent-history' }
    }
    if (task.effectOutcome === 'uncertain') {
      const uncertainAttempt = task.lastAttemptId ? attempts.get(task.lastAttemptId) : undefined
      if (
        !uncertainAttempt ||
        uncertainAttempt.taskId !== task.taskId ||
        uncertainAttempt.status !== 'uncertain' ||
        uncertainAttempt.outcome !== 'uncertain' ||
        !sameAttemptSnapshot(task, uncertainAttempt)
      ) {
        return { kind: 'corrupt', reason: 'inconsistent-history' }
      }
    }
    if (task.effectOutcome === 'not-applied') {
      const notAppliedAttempt = task.lastAttemptId ? attempts.get(task.lastAttemptId) : undefined
      const expectedRevision = notAppliedAttempt ? notAppliedAttempt.taskRevision + 1 : Number.NaN
      const reconciledCancelledAtOriginalRevision =
        task.status === 'cancelled' &&
        notAppliedAttempt?.status === 'reconciled' &&
        task.revision === notAppliedAttempt.taskRevision
      if (
        !notAppliedAttempt ||
        (notAppliedAttempt.status !== 'settled' && notAppliedAttempt.status !== 'reconciled') ||
        notAppliedAttempt.outcome !== 'not-applied' ||
        !sameAttemptSnapshotDetails(task, notAppliedAttempt) ||
        (!reconciledCancelledAtOriginalRevision && task.revision !== expectedRevision)
      ) {
        return { kind: 'corrupt', reason: 'inconsistent-history' }
      }
    }
    if (task.effectOutcome === 'applied') {
      const appliedAttempt = task.lastAttemptId ? attempts.get(task.lastAttemptId) : undefined
      if (
        !appliedAttempt ||
        (appliedAttempt.status !== 'settled' && appliedAttempt.status !== 'reconciled') ||
        appliedAttempt.outcome !== 'applied' ||
        !sameAttemptSnapshot(task, appliedAttempt)
      ) {
        return { kind: 'corrupt', reason: 'inconsistent-history' }
      }
    }
    if (task.status === 'dispatching') {
      const active = task.activeAttemptId ? attempts.get(task.activeAttemptId) : undefined
      if (
        !active ||
        active.taskId !== task.taskId ||
        active.status !== 'authorized' ||
        !sameAttemptSnapshot(task, active)
      ) {
        return { kind: 'corrupt', reason: 'inconsistent-history' }
      }
    }
  }
  for (const attempt of attempts.values()) {
    const task = tasks.get(attempt.taskId)
    if (attempt.status === 'authorized') {
      if (task?.status !== 'dispatching' || task.activeAttemptId !== attempt.attemptId) {
        return { kind: 'corrupt', reason: 'inconsistent-history' }
      }
    }
    if (
      attempt.status === 'uncertain' &&
      (attempt.outcome !== 'uncertain' ||
        task?.lastAttemptId !== attempt.attemptId ||
        task.effectOutcome !== 'uncertain' ||
        !['uncertain', 'paused', 'cancelled'].includes(task.status))
    ) {
      return { kind: 'corrupt', reason: 'inconsistent-history' }
    }
    // A multi-step task keeps every verified step in its history, so only its latest attempt is the effect record.
    if (
      attempt.outcome === 'applied' &&
      ((attempt.status !== 'settled' && attempt.status !== 'reconciled') ||
        (task?.multiStep !== true &&
          (task?.lastAttemptId !== attempt.attemptId ||
            task.effectOutcome !== 'applied' ||
            !sameAttemptSnapshot(task, attempt))))
    ) {
      return { kind: 'corrupt', reason: 'inconsistent-history' }
    }
    if (
      (attempt.status === 'authorized' && attempt.outcome !== undefined) ||
      ((attempt.status === 'settled' || attempt.status === 'reconciled') &&
        attempt.outcome !== 'applied' &&
        attempt.outcome !== 'not-applied')
    ) {
      return { kind: 'corrupt', reason: 'inconsistent-history' }
    }
  }

  const recoveredAttempts = new Map<string, TaskAttempt>()
  for (const [id, attempt] of attempts) {
    recoveredAttempts.set(
      id,
      freezeAttempt(
        attempt.status === 'authorized' ? { ...attempt, status: 'uncertain', outcome: 'uncertain' } : attempt
      )
    )
  }
  const recoveredTasks = new Map<string, TaskRecord>()
  for (const [id, task] of tasks) {
    recoveredTasks.set(
      id,
      freezeTask(
        task.status === 'dispatching'
          ? { ...task, status: 'uncertain', effectOutcome: 'uncertain', activeAttemptId: undefined }
          : task
      )
    )
  }
  const ownerRebindRequired = [...recoveredTasks.values()].some(
    (task) => task.status !== 'cancelled' && task.status !== 'completed'
  )

  return {
    kind: 'loaded',
    state: {
      tasks: recoveredTasks,
      attempts: recoveredAttempts,
      grants: new Map(),
      consumedGrantIds,
      ownerRebindRequired
    }
  }
}
