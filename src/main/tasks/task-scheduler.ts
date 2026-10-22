/**
 * Per-owner task scheduler (G32): bounded concurrency, named resource locks, a queue deadline and Stop.
 *
 * It decides only WHEN a job may start. What a job does, and how its effect is proven, stays with the caller.
 * - One owner has at most `maxEffectPerOwner` effect jobs and `maxReadOnlyPerOwner` read-only jobs running.
 * - A job holds every resource it names for as long as it runs. An effect holds them exclusively, read-only jobs
 *   share them with each other, so two tasks never act on the same resource at once, across owners too.
 * - Arrival order is kept per resource: a later job never overtakes an earlier one that waits for the same
 *   resource, but it does not wait behind a job whose resources it does not touch.
 * - Stop invalidates what was queued (it never runs) and aborts what is running. The locks of a running job are
 *   released only when it really finishes, because an abort cannot take back an effect already underway.
 * - A job that waits longer than `maxQueueWaitMs` is dropped unrun: a confirmation must not fire much later.
 * The limits are caller policy; this module defines no defaults.
 */

export type SchedulerEffect = 'effect' | 'read-only'

export interface SchedulerLimits {
  /** Desktop-effect jobs one owner may run at once. */
  readonly maxEffectPerOwner: number
  /** Read-only jobs one owner may run at once. */
  readonly maxReadOnlyPerOwner: number
  /** Waiting jobs one owner may have. */
  readonly maxQueuedPerOwner: number
  readonly maxQueueWaitMs: number
}

export interface SchedulerJob<T> {
  /** Unique among the queued and running jobs. A second submission of a live key is refused. */
  readonly key: string
  readonly owner: string
  readonly effect: SchedulerEffect
  /** Named resources (an app, a document, the clipboard, the focused field). */
  readonly resources: readonly string[]
  /** The signal aborts when Stop reaches the job while it runs. */
  readonly run: (signal: AbortSignal) => Promise<T>
}

export type SchedulerRejection = 'stopped' | 'queue_timeout' | 'duplicate_job' | 'queue_full' | 'invalid_job'

export type SchedulerResult<T> =
  | { readonly status: 'ran'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: SchedulerRejection }

export interface SchedulerStopSummary {
  readonly queued: number
  readonly running: number
}

const MAX_RESOURCES_PER_JOB = 8

interface QueuedJob {
  readonly job: SchedulerJob<unknown>
  readonly resources: readonly string[]
  readonly resolve: (result: SchedulerResult<unknown>) => void
  readonly reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

interface RunningJob {
  readonly job: SchedulerJob<unknown>
  readonly resources: readonly string[]
  readonly controller: AbortController
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

function validJob(job: SchedulerJob<unknown>): boolean {
  return (
    typeof job?.key === 'string' &&
    job.key.length > 0 &&
    typeof job.owner === 'string' &&
    job.owner.length > 0 &&
    (job.effect === 'effect' || job.effect === 'read-only') &&
    Array.isArray(job.resources) &&
    job.resources.length <= MAX_RESOURCES_PER_JOB &&
    job.resources.every((name) => typeof name === 'string' && name.length > 0) &&
    typeof job.run === 'function'
  )
}

export class TaskScheduler {
  private readonly queue: QueuedJob[] = []
  private readonly running = new Set<RunningJob>()
  private draining = false

  constructor(private readonly limits: SchedulerLimits) {
    if (
      !positiveInteger(limits.maxEffectPerOwner) ||
      !positiveInteger(limits.maxReadOnlyPerOwner) ||
      !positiveInteger(limits.maxQueuedPerOwner) ||
      !Number.isFinite(limits.maxQueueWaitMs) ||
      limits.maxQueueWaitMs <= 0
    ) {
      throw new TypeError('Scheduler limits must be positive integers and a positive finite queue wait')
    }
  }

  snapshot(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length }
  }

  submit<T>(job: SchedulerJob<T>): Promise<SchedulerResult<T>> {
    const rejected = (reason: SchedulerRejection): Promise<SchedulerResult<T>> =>
      Promise.resolve({ status: 'rejected', reason })
    if (!validJob(job as SchedulerJob<unknown>)) return rejected('invalid_job')
    if (this.hasKey(job.key)) return rejected('duplicate_job')
    if (this.queue.filter((queued) => queued.job.owner === job.owner).length >= this.limits.maxQueuedPerOwner) {
      return rejected('queue_full')
    }
    return new Promise<SchedulerResult<T>>((resolve, reject) => {
      const queued: QueuedJob = {
        job: job as SchedulerJob<unknown>,
        resources: [...new Set(job.resources)],
        resolve: resolve as (result: SchedulerResult<unknown>) => void,
        reject,
        timer: undefined
      }
      queued.timer = setTimeout(() => this.expire(queued), this.limits.maxQueueWaitMs)
      queued.timer.unref?.()
      this.queue.push(queued)
      this.drain()
    })
  }

  /** Invalidates the owner's queued jobs (or every owner's) and aborts the ones running. Safe to call twice. */
  stop(owner?: string): SchedulerStopSummary {
    let queued = 0
    for (const waiting of [...this.queue]) {
      if (owner !== undefined && waiting.job.owner !== owner) continue
      this.removeQueued(waiting)
      waiting.resolve({ status: 'rejected', reason: 'stopped' })
      queued += 1
    }
    let running = 0
    for (const active of this.running) {
      if (owner !== undefined && active.job.owner !== owner) continue
      if (active.controller.signal.aborted) continue
      active.controller.abort('stopped')
      running += 1
    }
    // Removing queued work can free a job that only waited behind it.
    this.drain()
    return { queued, running }
  }

  private hasKey(key: string): boolean {
    return this.queue.some((queued) => queued.job.key === key) || [...this.running].some((r) => r.job.key === key)
  }

  private removeQueued(queued: QueuedJob): void {
    if (queued.timer) clearTimeout(queued.timer)
    queued.timer = undefined
    const index = this.queue.indexOf(queued)
    if (index >= 0) this.queue.splice(index, 1)
  }

  private expire(queued: QueuedJob): void {
    if (!this.queue.includes(queued)) return
    this.removeQueued(queued)
    queued.resolve({ status: 'rejected', reason: 'queue_timeout' })
    this.drain()
  }

  private runningFor(owner: string, effect: SchedulerEffect): number {
    let count = 0
    for (const active of this.running) if (active.job.owner === owner && active.job.effect === effect) count += 1
    return count
  }

  private locksAllow(job: SchedulerJob<unknown>, resources: readonly string[]): boolean {
    for (const active of this.running) {
      if (job.effect === 'read-only' && active.job.effect === 'read-only') continue
      if (resources.some((name) => active.resources.includes(name))) return false
    }
    return true
  }

  private drain(): void {
    // A job's synchronous start can submit or stop work; keep one pass at a time and repeat until stable.
    if (this.draining) return
    this.draining = true
    try {
      let started = true
      while (started) {
        started = false
        const waitingExclusive = new Set<string>()
        const waitingShared = new Set<string>()
        for (const queued of [...this.queue]) {
          const { job, resources } = queued
          const cap = job.effect === 'effect' ? this.limits.maxEffectPerOwner : this.limits.maxReadOnlyPerOwner
          const behindEarlier = resources.some(
            (name) => waitingExclusive.has(name) || (job.effect === 'effect' && waitingShared.has(name))
          )
          if (!behindEarlier && this.runningFor(job.owner, job.effect) < cap && this.locksAllow(job, resources)) {
            this.removeQueued(queued)
            this.start(queued)
            started = true
            break
          }
          for (const name of resources) (job.effect === 'effect' ? waitingExclusive : waitingShared).add(name)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private start(queued: QueuedJob): void {
    const active: RunningJob = {
      job: queued.job,
      resources: queued.resources,
      controller: new AbortController()
    }
    this.running.add(active)
    let work: Promise<unknown>
    try {
      work = Promise.resolve(queued.job.run(active.controller.signal))
    } catch (error) {
      work = Promise.reject(error)
    }
    const finish = (): void => {
      this.running.delete(active)
      this.drain()
    }
    work.then(
      (value) => {
        finish()
        queued.resolve({ status: 'ran', value })
      },
      (error: unknown) => {
        finish()
        queued.reject(error)
      }
    )
  }
}
