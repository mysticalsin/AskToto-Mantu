import { ContractError, type ContractErrorCode, requireCondition } from './contract-data'
import type { ContextSnapshot, SessionChangeReason, SessionContext, SessionOutputKind } from './session-context'

export interface SessionQueueOptions {
  /** Pending jobs allowed behind the one active job. Default 2. */
  readonly maxPending?: number
  /** Per-job deadline in milliseconds. Default 10 000. */
  readonly timeoutMs?: number
  /**
   * Context changes that move the session on without invalidating work in flight. Default none: any change aborts
   * the active job and rejects pending ones. A live conversation lists `transcript`, because an answer to a question
   * is still the answer after someone speaks again; stop, resume, permissions, screen and knowledge still invalidate.
   */
  readonly tolerate?: readonly SessionChangeReason[]
}

export interface SessionSubmitOptions {
  /** This job's own deadline, for work that legitimately outlives the queue default (a streamed answer). */
  readonly timeoutMs?: number
}

export interface SessionQueueResult<T> {
  readonly snapshot: ContextSnapshot
  readonly value: T
}

export type SessionTask<T> = (snapshot: ContextSnapshot, signal: AbortSignal) => T | PromiseLike<T>

interface Job {
  readonly snapshot: ContextSnapshot
  readonly work: SessionTask<unknown>
  readonly timeoutMs: number
  readonly resolve: (result: SessionQueueResult<unknown>) => void
  readonly reject: (reason: unknown) => void
}

const DEFAULT_MAX_PENDING = 2
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_PENDING_LIMIT = 32
const MAX_TIMEOUT_MS = 60_000
/** A single job may ask for longer than the queue's own ceiling; it is still bounded. */
const MAX_JOB_TIMEOUT_MS = 300_000

const reasonFor = (code: ContractErrorCode): ContractError => new ContractError(code)

/** One active publication task per session; bounded pending work and cooperative cancellation. */
export class SessionQueue {
  readonly #context: SessionContext
  readonly #maxPending: number
  readonly #timeoutMs: number
  readonly #tolerated: ReadonlySet<SessionChangeReason>
  readonly #pending: Job[] = []
  #active: { readonly controller: AbortController } | null = null
  #closed = false
  readonly #unsubscribe: () => void

  constructor(context: SessionContext, options: SessionQueueOptions = {}) {
    const { maxPending = DEFAULT_MAX_PENDING, timeoutMs = DEFAULT_TIMEOUT_MS, tolerate = [] } = options
    requireCondition(Number.isInteger(maxPending) && maxPending >= 0 && maxPending <= MAX_PENDING_LIMIT, 'QUEUE_LIMIT')
    requireCondition(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS, 'QUEUE_TIMEOUT')
    this.#context = context
    this.#maxPending = maxPending
    this.#timeoutMs = timeoutMs
    this.#tolerated = new Set(tolerate)
    this.#unsubscribe = context.onChange((reason) => {
      if (this.#tolerated.has(reason)) return
      this.#active?.controller.abort(reasonFor('TASK_INVALIDATED'))
      for (const job of this.#pending.splice(0)) job.reject(reasonFor('TASK_INVALIDATED'))
    })
  }

  submit<T>(
    outputKind: SessionOutputKind,
    work: SessionTask<T>,
    options: SessionSubmitOptions = {}
  ): Promise<SessionQueueResult<T>> {
    return new Promise<SessionQueueResult<T>>((resolve, reject) => {
      try {
        requireCondition(!this.#closed, 'QUEUE_CLOSED')
        requireCondition(typeof work === 'function', 'TASK_FUNCTION')
        const timeoutMs = options.timeoutMs ?? this.#timeoutMs
        requireCondition(
          Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_JOB_TIMEOUT_MS,
          'QUEUE_TIMEOUT'
        )
        requireCondition(!this.#active || this.#pending.length < this.#maxPending, 'QUEUE_FULL')
        const snapshot = this.#context.snapshot(outputKind)
        this.#pending.push({
          snapshot,
          work,
          timeoutMs,
          resolve: resolve as Job['resolve'],
          reject
        })
        void this.#pump()
      } catch (error) {
        reject(error)
      }
    })
  }

  async #pump(): Promise<void> {
    if (this.#active || this.#closed) return
    const job = this.#pending.shift()
    if (!job) return
    const controller = new AbortController()
    const active = { controller }
    this.#active = active
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      this.#assertFresh(job)
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason ?? reasonFor('TASK_CANCELLED'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => controller.abort(reasonFor('TASK_TIMEOUT')), job.timeoutMs)
      const work = Promise.resolve().then(() => {
        this.#assertFresh(job)
        if (controller.signal.aborted) throw controller.signal.reason
        return job.work(job.snapshot, controller.signal)
      })
      const value = await Promise.race([work, cancelled])
      this.#assertFresh(job)
      if (controller.signal.aborted) throw controller.signal.reason
      job.resolve({ snapshot: job.snapshot, value })
    } catch (error) {
      job.reject(error)
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      if (this.#active === active) this.#active = null
      void this.#pump()
    }
  }

  /**
   * A job's snapshot is current, or only moved on by a tolerated change. Every change that is not tolerated has already
   * rejected the jobs it outdated (the listener above), so a job that still reaches this check with a stale context
   * revision can only have been outdated by a tolerated one. Generation, permissions and scope are never tolerated.
   */
  #assertFresh(job: Job): void {
    try {
      this.#context.assertCurrent(job.snapshot)
    } catch (error) {
      if (this.#tolerated.size > 0 && error instanceof ContractError && error.code === 'STALE_CONTEXT') return
      throw error
    }
  }

  dispose(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribe()
    this.#active?.controller.abort(reasonFor('QUEUE_CLOSED'))
    for (const job of this.#pending.splice(0)) job.reject(reasonFor('QUEUE_CLOSED'))
  }
}
