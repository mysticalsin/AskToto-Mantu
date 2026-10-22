import { BoundedSet } from '../bounded-set'

/**
 * Steering for a task that is mid-step (G32). A step in flight is not a safe boundary, so a steer waits here and
 * is handed over once, at the boundary, to the one task it names. G06 `steerTask` stays the only place a steer
 * changes a task; this inbox only holds it until then.
 */
export interface PendingSteer {
  readonly steerId: string
  readonly taskId: string
  readonly revision: number
  readonly argumentsDigest: string
}

export type SteerDeferral =
  | { readonly ok: true; readonly superseded?: string }
  | {
      readonly ok: false
      readonly reason: 'invalid_input' | 'duplicate_steer' | 'stale_steer' | 'steer_queue_full'
    }

export interface SteeringInboxLimits {
  readonly maxPendingTasks: number
  /** Steer ids remembered for the exactly-once rule. The oldest is forgotten past this. */
  readonly maxRememberedIds: number
}

const DEFAULT_LIMITS: SteeringInboxLimits = { maxPendingTasks: 16, maxRememberedIds: 256 }

export class TaskSteeringInbox {
  private readonly pending = new Map<string, PendingSteer>()
  private readonly seen: BoundedSet<string>
  private readonly maxPendingTasks: number

  constructor(limits: SteeringInboxLimits = DEFAULT_LIMITS) {
    this.maxPendingTasks = limits.maxPendingTasks
    this.seen = new BoundedSet(limits.maxRememberedIds)
  }

  defer(steer: PendingSteer): SteerDeferral {
    if (
      typeof steer?.steerId !== 'string' ||
      !steer.steerId ||
      typeof steer.taskId !== 'string' ||
      !steer.taskId ||
      !Number.isSafeInteger(steer.revision) ||
      steer.revision < 1 ||
      typeof steer.argumentsDigest !== 'string' ||
      !steer.argumentsDigest
    ) {
      return { ok: false, reason: 'invalid_input' }
    }
    if (this.seen.has(steer.steerId)) return { ok: false, reason: 'duplicate_steer' }
    const current = this.pending.get(steer.taskId)
    if (current && steer.revision <= current.revision) return { ok: false, reason: 'stale_steer' }
    if (!current && this.pending.size >= this.maxPendingTasks) return { ok: false, reason: 'steer_queue_full' }
    this.seen.add(steer.steerId)
    this.pending.set(steer.taskId, { ...steer })
    return current ? { ok: true, superseded: current.steerId } : { ok: true }
  }

  pendingFor(taskId: string): PendingSteer | undefined {
    return this.pending.get(taskId)
  }

  /** The safe boundary: removes and returns the steer for this task, if any. */
  take(taskId: string): PendingSteer | undefined {
    const steer = this.pending.get(taskId)
    this.pending.delete(taskId)
    return steer
  }

  /** Stop: nothing waiting survives it. Returns the dropped steer ids. */
  dropAll(): string[] {
    const ids = [...this.pending.values()].map((steer) => steer.steerId)
    this.pending.clear()
    return ids
  }
}
