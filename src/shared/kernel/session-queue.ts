import { ContractError, type ContractErrorCode, requireCondition } from './contract-data'
import type { ContextSnapshot, SessionContext, SessionOutputKind } from './session-context'

export interface SessionQueueOptions {
  /** Pending jobs allowed behind the one active job. Default 2. */
  readonly maxPending?: number
  /** Per-job deadline in milliseconds. Default 10 000. */
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
  readonly resolve: (result: SessionQueueResult<unknown>) => void
  readonly reject: (reason: unknown) => void
}

const DEFAULT_MAX_PENDING = 2
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_PENDING_LIMIT = 32
const MAX_TIMEOUT_MS = 60_000

const reasonFor = (code: ContractErrorCode): ContractError => new ContractError(code)

/** One active publication task per session; bounded pending work and cooperative cancellation. */
export class SessionQueue {
  readonly #context: SessionContext
  readonly #maxPending: number
  readonly #timeoutMs: number
  readonly #pending: Job[] = []
  #active: { readonly controller: AbortController } | null = null
  #closed = false
  readonly #unsubscribe: () => void

  constructor(context: SessionContext, options: SessionQueueOptions = {}) {
    const { maxPending = DEFAULT_MAX_PENDING, timeoutMs = DEFAULT_TIMEOUT_MS } = options
    requireCondition(Number.isInteger(maxPending) && maxPending >= 0 && maxPending <= MAX_PENDING_LIMIT, 'QUEUE_LIMIT')
    requireCondition(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS, 'QUEUE_TIMEOUT')
    this.#context = context
    this.#maxPending = maxPending
    this.#timeoutMs = timeoutMs
    this.#unsubscribe = context.onChange(() => {
      this.#active?.controller.abort(reasonFor('TASK_INVALIDATED'))
      for (const job of this.#pending.splice(0)) job.reject(reasonFor('TASK_INVALIDATED'))
    })
  }

  submit<T>(outputKind: SessionOutputKind, work: SessionTask<T>): Promise<SessionQueueResult<T>> {
    return new Promise<SessionQueueResult<T>>((resolve, reject) => {
      try {
        requireCondition(!this.#closed, 'QUEUE_CLOSED')
        requireCondition(typeof work === 'function', 'TASK_FUNCTION')
        requireCondition(!this.#active || this.#pending.length < this.#maxPending, 'QUEUE_FULL')
        const snapshot = this.#context.snapshot(outputKind)
        this.#pending.push({
          snapshot,
          work,
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
      this.#context.assertCurrent(job.snapshot)
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason ?? reasonFor('TASK_CANCELLED'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => controller.abort(reasonFor('TASK_TIMEOUT')), this.#timeoutMs)
      const work = Promise.resolve().then(() => {
        this.#context.assertCurrent(job.snapshot)
        if (controller.signal.aborted) throw controller.signal.reason
        return job.work(job.snapshot, controller.signal)
      })
      const value = await Promise.race([work, cancelled])
      this.#context.assertCurrent(job.snapshot)
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

  dispose(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribe()
    this.#active?.controller.abort(reasonFor('QUEUE_CLOSED'))
    for (const job of this.#pending.splice(0)) job.reject(reasonFor('QUEUE_CLOSED'))
  }
}
