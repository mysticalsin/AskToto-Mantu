import type { MetisCommandRecoveryNotice } from '@shared/metis-command-contract'
import { recoveredUncertainCopy } from '@shared/command-copy'
import type { TaskRecord, TaskRecoveryOwner } from './task-contract'
import { cloneTaskRecoveryOwner, sameTaskRecoveryOwner } from './task-recovery-owner'

export interface DesktopActionTaskRecoveryDeps {
  readonly acknowledgements?: {
    read(): Promise<readonly string[]>
    write(ids: readonly string[]): Promise<void>
  }
  readonly currentPrincipal: () => TaskRecoveryOwner | null
  readonly authSessionGeneration: () => number
  readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>
  readonly tasks: () => Iterable<TaskRecord>
  readonly loaded: () => boolean
  readonly log?: { warn(message: string, ...args: unknown[]): void }
}

/** Owns disclosure acknowledgements while the bridge retains task state and its serialization lock. */
export class DesktopActionTaskRecovery {
  private acknowledged: Set<string> | null = null

  constructor(private readonly deps: DesktopActionTaskRecoveryDeps) {}

  captureRecoveryPrincipal(): TaskRecoveryOwner | null {
    return this.readPrincipal()
  }

  /** Retain the scheduled identity only while it is still current; never substitute a later account. */
  retainScheduledPrincipal(captured: TaskRecoveryOwner | undefined, generation: number): TaskRecoveryOwner | null {
    if (!captured || this.deps.authSessionGeneration() !== generation) return null
    return sameTaskRecoveryOwner(captured, this.readPrincipal()) ? captured : null
  }

  async takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]> {
    if (!this.deps.loaded()) return []
    const generation = this.deps.authSessionGeneration()
    const principal = this.readPrincipal()
    if (!principal) return []

    return this.deps.withLock(async () => {
      if (!this.isCurrent(principal, generation)) return []
      const acknowledged = await this.loadAcknowledgements()
      if (!this.isCurrent(principal, generation)) return []

      const fresh = [...this.deps.tasks()].filter(
        (task) =>
          task.effectOutcome === 'uncertain' &&
          sameTaskRecoveryOwner(task.recoveryOwner, principal) &&
          !acknowledged.has(task.taskId)
      )
      if (fresh.length === 0) return []

      const prior = new Set(acknowledged)
      for (const task of fresh) acknowledged.add(task.taskId)
      if (!this.isCurrent(principal, generation)) {
        this.acknowledged = prior
        return []
      }
      await this.persistAcknowledgements()
      // A write already dispatched to disk cannot be rolled back if the owner changes while it is in flight.
      if (!this.isCurrent(principal, generation)) return []

      return fresh.map((task) => {
        const actionId = task.scope.capabilities[0] ?? ''
        return { taskId: task.taskId, actionId, copy: recoveredUncertainCopy(actionId) }
      })
    })
  }

  /** Preserves the historic immediate-ack assumption for settled uncertain effects; late detached delivery is separate. */
  async acknowledgeSettled(taskId: string): Promise<void> {
    const acknowledged = await this.loadAcknowledgements()
    acknowledged.add(taskId)
    await this.persistAcknowledgements()
  }

  private readPrincipal(): TaskRecoveryOwner | null {
    try {
      return cloneTaskRecoveryOwner(this.deps.currentPrincipal())
    } catch {
      return null
    }
  }

  private isCurrent(principal: TaskRecoveryOwner, generation: number): boolean {
    return this.deps.authSessionGeneration() === generation && sameTaskRecoveryOwner(this.readPrincipal(), principal)
  }

  private async loadAcknowledgements(): Promise<Set<string>> {
    if (this.acknowledged) return this.acknowledged
    let ids: readonly string[] = []
    try {
      ids = (await this.deps.acknowledgements?.read()) ?? []
    } catch (error) {
      this.deps.log?.warn('[desktop-action-task] could not read acknowledgements; notices may repeat once:', error)
    }
    this.acknowledged = new Set(ids)
    return this.acknowledged
  }

  /** Forget acknowledgements for tasks that no longer exist, then write. Best effort: a notice may repeat once. */
  private async persistAcknowledgements(): Promise<void> {
    if (!this.acknowledged || !this.deps.acknowledgements) return
    const liveTaskIds = new Set([...this.deps.tasks()].map((task) => task.taskId))
    const live = new Set([...this.acknowledged].filter((id) => liveTaskIds.has(id)))
    this.acknowledged = live
    try {
      await this.deps.acknowledgements.write([...live])
    } catch (error) {
      this.deps.log?.warn('[desktop-action-task] could not persist acknowledgements:', error)
    }
  }
}
