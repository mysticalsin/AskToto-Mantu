import type { ImportJob, ImportJobStore } from './import-jobs'
import { ImportRetentionBlockedError } from './import-retention-policy'

export class StaleImportJobWriteError extends Error {}

export interface ImportHoldInventory {
  jobIds: string[]
  policyHeldJobIds: string[]
  inventoryOverflow: boolean
  policyHoldOverflow: boolean
}

export interface ImportRetentionHost {
  jobs: Map<string, ImportJob>
  queue: string[]
  activeJobIds: Set<string>
  decodeSlotIds: Set<string>
  retainedPcmConsumerIds: Set<string>
  copy(job: ImportJob): ImportJob
  captureAttempt(jobId: string): unknown
  stopAttempt(jobId: string, owner: unknown): void
  takePcm(jobId: string): void
  onCancel(jobId: string): void | Promise<void>
  releaseDecodeSlot(jobId: string, owner: unknown): Promise<void>
  retireAttempt(jobId: string, owner: unknown): void
  maybeIdle(): void
}

export interface ImportResumeHost {
  jobs: Map<string, ImportJob>
  queue: string[]
  decodeSlotIds: Set<string>
  activeJobIds: Set<string>
  copy(job: ImportJob): ImportJob
  assertAllowed(): void
  validateSource(job: ImportJob): void | Promise<void>
  persist(job: ImportJob): Promise<void>
  releaseHold(job: ImportJob): Promise<void>
  prepareCheckpoint(job: ImportJob): void
  removeCheckpoint(jobId: string): Promise<void>
  enqueue(jobId: string): void
  pump(): Promise<void>
  requireJob(jobId: string): ImportJob
}

export class ImportJobRetentionCoordinator {
  readonly durableJobs = new Map<string, ImportJob>()
  readonly checkpointWriteTails = new Map<string, Promise<void>>()
  heldJobIds: string[] = []
  policyHeldJobIds: string[] = []
  inventoryOverflow = false
  policyHoldOverflow = false
  private holdingAll = false
  private readonly holdMarkerTails = new Map<string, Promise<void>>()

  async initialize(store: ImportJobStore, allowed: boolean): Promise<void> {
    const inventory = await store.markExistingJobsHeld?.(allowed ? 'restart' : 'policy')
    this.heldJobIds = inventory?.jobIds ?? []
    this.policyHeldJobIds = inventory?.policyHeldJobIds ?? []
    this.inventoryOverflow = inventory?.inventoryOverflow ?? false
    this.policyHoldOverflow = inventory?.policyHoldOverflow ?? false
  }

  async snapshot(store: ImportJobStore, allowed: () => boolean, jobs: () => ImportJob[], holdAll: () => Promise<void>) {
    if (!allowed()) await holdAll()
    const inventory = await store.listHeldJobIds?.()
    if (inventory) this.merge(inventory)
    const policyBlocked = !allowed()
    if (policyBlocked) await holdAll()
    return {
      jobs: policyBlocked ? [] : jobs(),
      policyBlocked,
      heldJobIds: this.heldJobIds.slice(0, 1_024),
      policyHeldJobIds: this.policyHeldJobIds.slice(0, 1_024),
      inventoryOverflow: this.inventoryOverflow,
      policyHoldOverflow: this.policyHoldOverflow
    }
  }

  merge(inventory: ImportHoldInventory): void {
    this.heldJobIds = boundedUnion(this.heldJobIds, inventory.jobIds)
    this.policyHeldJobIds = boundedUnion(this.policyHeldJobIds, inventory.policyHeldJobIds)
    this.inventoryOverflow ||= inventory.inventoryOverflow
    this.policyHoldOverflow ||= inventory.policyHoldOverflow
  }

  async persist(
    job: ImportJob,
    allowed: () => boolean,
    hold: () => Promise<void>,
    copy: (job: ImportJob) => ImportJob,
    isCurrent: () => boolean,
    assertWriteOwner: () => void,
    store: ImportJobStore,
    now: () => number,
    onChange?: (job: ImportJob) => void
  ): Promise<void> {
    if (!allowed()) {
      await hold()
      throw new ImportRetentionBlockedError()
    }
    job.updatedAt = now()
    try {
      const snapshot = copy(job)
      await this.serialize(job.jobId, () => store.save(snapshot, assertWriteOwner))
    } catch (error) {
      if (!allowed()) {
        await hold()
        throw new ImportRetentionBlockedError()
      }
      throw error
    }
    if (!allowed()) {
      await hold()
      throw new ImportRetentionBlockedError()
    }
    if (!isCurrent()) throw new StaleImportJobWriteError()
    this.durableJobs.set(job.jobId, copy(job))
    onChange?.(copy(job))
  }

  async hold(job: ImportJob, host: ImportRetentionHost, store: ImportJobStore): Promise<void> {
    if (job.state === 'policy-held' && this.heldJobIds.includes(job.jobId)) return
    const durable = this.durableJobs.get(job.jobId)
    if (durable) Object.assign(job, host.copy(durable))
    const owner = host.captureAttempt(job.jobId)
    const hadDecoder = host.decodeSlotIds.has(job.jobId)
    host.stopAttempt(job.jobId, owner)
    job.state = 'policy-held'
    job.error = undefined
    host.takePcm(job.jobId)
    if (this.durableJobs.has(job.jobId)) this.addHeld(job.jobId)
    for (let i = host.queue.length - 1; i >= 0; i -= 1) {
      if (host.queue[i] === job.jobId) host.queue.splice(i, 1)
    }
    host.activeJobIds.delete(job.jobId)
    if (hadDecoder) {
      try {
        await host.onCancel(job.jobId)
      } catch {
        // Native cleanup is best effort; a policy hold cannot be undone by a cleanup error.
      }
    }
    try {
      await host.releaseDecodeSlot(job.jobId, owner)
    } catch {
      // Keep the hold even if a downstream idle/pump callback fails during cleanup.
    }
    if (!host.decodeSlotIds.has(job.jobId) && !host.retainedPcmConsumerIds.has(job.jobId)) {
      host.retireAttempt(job.jobId, owner)
    }
    // An explicit Resume may replace this job object while cleanup is awaiting an owned decoder. Do not
    // recreate its hold marker or inventory entry after that successor has already been admitted.
    if (host.jobs.get(job.jobId) !== job || job.state !== 'policy-held') {
      host.maybeIdle()
      return
    }
    let persisted = false
    try {
      await this.serializeHoldMarker(job.jobId, async () => {
        if (host.jobs.get(job.jobId) !== job || job.state !== 'policy-held') return
        persisted = (await store.markHeld?.(job.jobId)) ?? this.durableJobs.has(job.jobId)
      })
    } catch {
      this.inventoryOverflow = true
      this.policyHoldOverflow = true
    }
    if (host.jobs.get(job.jobId) !== job || job.state !== 'policy-held') {
      host.maybeIdle()
      return
    }
    if (persisted) this.addHeld(job.jobId)
    host.maybeIdle()
  }

  async holdAll(jobs: Iterable<ImportJob>, host: ImportRetentionHost, store: ImportJobStore): Promise<void> {
    if (this.holdingAll) return
    this.holdingAll = true
    try {
      for (const job of jobs) {
        if (
          !isTerminal(job.state) ||
          job.state === 'failed' ||
          (job.state === 'policy-held' && !this.heldJobIds.includes(job.jobId))
        ) {
          await this.hold(job, host, store)
        }
      }
    } finally {
      this.holdingAll = false
    }
  }

  async release(job: ImportJob, store: ImportJobStore): Promise<void> {
    try {
      await this.serializeHoldMarker(job.jobId, () => store.clearHold?.(job.jobId) ?? Promise.resolve())
    } catch (error) {
      job.state = 'policy-held'
      throw error
    }
    this.heldJobIds = this.heldJobIds.filter((id) => id !== job.jobId)
    this.policyHeldJobIds = this.policyHeldJobIds.filter((id) => id !== job.jobId)
  }

  async resume(jobId: string, store: ImportJobStore, host: ImportResumeHost): Promise<ImportJob> {
    host.assertAllowed()
    let job = host.jobs.get(jobId)
    const held = this.heldJobIds.includes(jobId)
    if (held && job) job = host.copy(this.durableJobs.get(jobId) ?? job)
    if (!job && held && store.loadHeld) {
      const loaded = await store.loadHeld(jobId, true)
      if (loaded) job = host.copy(loaded)
    }
    if (!job) throw new Error('The saved import is unavailable.')
    if (held) {
      await host.validateSource(host.copy(job))
      host.jobs.set(jobId, job)
      this.durableJobs.set(jobId, host.copy(job))
    }
    if (job.state !== 'failed' && !(held && (job.file || !isTerminal(job.state)))) {
      throw new Error('Only a failed import can be resumed.')
    }
    if (job.file) {
      // The transcript already exists; retry only its interrupted summary to avoid duplicate meetings.
      job.state = 'done'
      job.error = undefined
      job.recapError = job.recapError ?? 'Automatic summary was interrupted. Open the meeting to retry it.'
      await host.persist(job)
      if (held) await host.releaseHold(job)
      await host.removeCheckpoint(job.jobId)
      return host.copy(host.requireJob(jobId))
    }
    host.prepareCheckpoint(job)
    job.state = 'queued'
    job.error = undefined
    job.recapError = undefined
    await host.persist(job)
    if (held) await host.releaseHold(job)
    // Keep a timed-out retained consumer ahead of its retry so both never own the decoder at once.
    if (host.decodeSlotIds.has(jobId) || host.activeJobIds.has(jobId)) {
      if (!host.queue.includes(jobId)) host.queue.push(jobId)
    } else host.enqueue(jobId)
    await host.pump()
    return host.copy(host.requireJob(jobId))
  }

  private addHeld(jobId: string): void {
    if (!this.heldJobIds.includes(jobId)) this.heldJobIds = [...this.heldJobIds, jobId].slice(0, 1_024)
    if (!this.policyHeldJobIds.includes(jobId))
      this.policyHeldJobIds = [...this.policyHeldJobIds, jobId].slice(0, 1_024)
  }

  private async serialize(jobId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.checkpointWriteTails.get(jobId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => {}).then(() => current)
    this.checkpointWriteTails.set(jobId, tail)
    await previous.catch(() => {})
    try {
      await write()
    } finally {
      release()
      if (this.checkpointWriteTails.get(jobId) === tail) this.checkpointWriteTails.delete(jobId)
    }
  }

  private async serializeHoldMarker(jobId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.holdMarkerTails.get(jobId) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => {}).then(() => turn)
    this.holdMarkerTails.set(jobId, tail)
    await previous.catch(() => {})
    try {
      await operation()
    } finally {
      release()
      if (this.holdMarkerTails.get(jobId) === tail) this.holdMarkerTails.delete(jobId)
    }
  }
}

function boundedUnion(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right])).slice(0, 1_024)
}

function isTerminal(state: ImportJob['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'policy-held' || state === 'cancelled'
}
