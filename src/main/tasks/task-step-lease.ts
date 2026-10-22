import type { StepLeaseAbortReason, TaskRecord, TaskRuntimeState } from './task-contract'

export interface StepLease {
  readonly attemptId: string
  readonly taskId: string
  readonly taskRevision: number
  /** Deadline in the caller's clock. It is checked, not timed: no background timer runs here. */
  readonly expiresAt: number
  readonly signal: AbortSignal
}

export type StepLeaseCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'lease_stale' }

interface LeaseEntry {
  readonly lease: StepLease
  readonly controller: AbortController
}

/**
 * Runtime-only registry of the one live lease per active step. It is never persisted: after a restart no step is
 * live, and the recovered archive already marks the interrupted attempt uncertain. Call `sync` after every state
 * transition (or `assertCurrent` right before the guarded effect). A lease the registry did not issue is stale.
 */
export class TaskStepLeases {
  private readonly entries = new Map<string, LeaseEntry>()

  get size(): number {
    return this.entries.size
  }

  open(task: TaskRecord, expiresAt: number): StepLease {
    if (task.status !== 'dispatching' || !task.activeAttemptId) {
      throw new TypeError('A step lease needs a dispatching task with an active attempt')
    }
    if (!Number.isFinite(expiresAt)) throw new TypeError('A step lease needs a finite deadline')
    if (this.entries.has(task.activeAttemptId)) throw new Error('A lease for this attempt is already open')
    const controller = new AbortController()
    const lease: StepLease = Object.freeze({
      attemptId: task.activeAttemptId,
      taskId: task.taskId,
      taskRevision: task.revision,
      expiresAt,
      signal: controller.signal
    })
    this.entries.set(lease.attemptId, { lease, controller })
    return lease
  }

  /** Aborts every lease whose step is no longer current. Returns the aborted attempt ids. */
  sync(state: TaskRuntimeState, now: number): string[] {
    const aborted: string[] = []
    for (const [attemptId, { lease, controller }] of [...this.entries]) {
      const task = state.tasks.get(lease.taskId)
      const attempt = state.attempts.get(attemptId)
      const live =
        !state.ownerRebindRequired &&
        task?.status === 'dispatching' &&
        task.activeAttemptId === attemptId &&
        task.revision === lease.taskRevision &&
        attempt?.status === 'authorized'
      if (live && task && now < lease.expiresAt && now < task.expiresAt) continue
      this.entries.delete(attemptId)
      // A step that settled normally ends its lease without an abort.
      if (!state.ownerRebindRequired && (attempt?.status === 'settled' || attempt?.status === 'reconciled')) continue
      const reason: StepLeaseAbortReason = live ? 'expired' : 'revoked'
      controller.abort(reason)
      aborted.push(attemptId)
    }
    return aborted
  }

  assertCurrent(state: TaskRuntimeState, lease: StepLease, now: number): StepLeaseCheck {
    const entry = this.entries.get(lease.attemptId)
    if (!entry || entry.lease !== lease) return { ok: false, reason: 'lease_stale' }
    this.sync(state, now)
    return this.entries.has(lease.attemptId) ? { ok: true } : { ok: false, reason: 'lease_stale' }
  }

  abortAll(reason: StepLeaseAbortReason = 'revoked'): void {
    for (const { controller } of this.entries.values()) controller.abort(reason)
    this.entries.clear()
  }
}
