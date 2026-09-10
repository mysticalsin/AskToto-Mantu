/**
 * enterprise-client.ts — one client every LLM provider walks through.
 *
 * Strategies (openai / anthropic / dust / cli / local) still own wire format. This wrapper owns
 * the enterprise contract around each attempt:
 *   - hard wall-clock timeout (a trickle of tokens cannot hang the UI forever)
 *   - cancel via the returned handle (AbortController + inner.abort)
 *   - TTFT / TTA metrics (first visible token, then done)
 *   - circuit snapshot (provider-health) so a cooling provider is logged honestly
 *   - secret redaction on every error string that could reach a log
 *   - answer-first post-filter on typed/screen streams
 *   - fail closed: a hung call errors with a specific timeout sentence, never "Something went wrong"
 *
 * Retry-with-jitter and the fallback chain are pure helpers here (`runWithRetry`, `runFallbackChain`).
 * index.ts's attempt()/failover remains the live ask dispatcher (hedge + local-cloud boundary);
 * those helpers are the tested primitives and the place a future extract should land.
 */

import { AnswerFirstFilter } from '@shared/answer-first'
import { redactSecrets } from '@shared/redact'
import type { ProviderId } from '@shared/providers'
import { isCoolingDown, unhealthyProviders } from './provider-health'
import { isTransient, nextBackoff } from './retry'
import type { StreamHandle, StreamOptions } from './shared'
import { errMsg } from './shared'

/** Wall-clock ceiling when the caller does not set hardTimeoutMs. */
export const ENTERPRISE_HARD_TIMEOUT_MS = 180_000

export function resolveHardTimeoutMs(idleMs?: number, override?: number): number {
  if (typeof override === 'number' && override > 0) return override
  const idle = idleMs ?? 120_000
  return Math.min(ENTERPRISE_HARD_TIMEOUT_MS, Math.max(30_000, idle * 2))
}

export interface LlmCallMetrics {
  providerId: ProviderId
  ttftMs: number | null
  ttaMs: number | null
  cancelled: boolean
  timedOut: boolean
  circuitOpen: boolean
}

export interface CircuitSnapshot {
  open: boolean
  reason?: string
  until?: number
  error?: string
}

/** Advisory snapshot. Routing still decides last-resort; we never invent a hard lockout here. */
export function evaluateCircuit(providerId: ProviderId, now = Date.now()): CircuitSnapshot {
  if (!isCoolingDown(providerId, now)) return { open: false }
  const row = unhealthyProviders(now).find((p) => p.provider === providerId)
  return {
    open: true,
    reason: row?.reason,
    until: row?.until,
    error: row?.error
  }
}

export function honestError(message: string, fallback: string): string {
  const cleaned = redactSecrets((message || '').trim())
  if (!cleaned) return fallback
  if (/something went wrong/i.test(cleaned)) return fallback
  return cleaned
}

export function timeoutMessage(providerLabel: string, ms: number): string {
  const sec = Math.round(ms / 1000)
  return `${providerLabel} timed out after ${sec}s with no finish. Cancelled so the overlay stays usable. Try again, or pick another provider in Settings.`
}

export function cancelMessage(): string {
  return 'Cancelled.'
}

export interface FallbackAttempt<T> {
  id: string
  run: (signal: AbortSignal) => Promise<T>
}

/**
 * Try each provider in order. Transient failures retry the SAME id with equal jitter (retry.ts).
 * Permanent failures move to the next id. Cancel / abort fail closed immediately.
 */
export async function runFallbackChain<T>(
  chain: FallbackAttempt<T>[],
  opts: {
    signal?: AbortSignal
    maxRetriesPerProvider?: number
    rand?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<T> {
  const { signal, maxRetriesPerProvider = 1, rand = Math.random, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } =
    opts
  if (!chain.length) throw new Error('No provider left to try. Add a key in Settings → AI.')
  let lastError: Error = new Error('No provider left to try. Add a key in Settings → AI.')
  for (const step of chain) {
    if (signal?.aborted) throw new Error(cancelMessage())
    for (let attempt = 0; attempt <= maxRetriesPerProvider; attempt++) {
      if (signal?.aborted) throw new Error(cancelMessage())
      try {
        return await step.run(signal ?? new AbortController().signal)
      } catch (e) {
        const msg = honestError(errMsg(e), `${step.id} failed.`)
        lastError = new Error(msg)
        if (signal?.aborted || /cancel/i.test(msg)) throw new Error(cancelMessage())
        if (!isTransient(e) || attempt >= maxRetriesPerProvider) break
        await sleep(nextBackoff(attempt, { rand }))
      }
    }
  }
  throw lastError
}

/** Same-provider retry with jitter. Used by tests and any caller that is not walking a chain. */
export async function runWithRetry<T>(
  run: () => Promise<T>,
  opts: { maxRetries?: number; rand?: () => number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}
): Promise<T> {
  return runFallbackChain([{ id: 'primary', run: () => run() }], {
    signal: opts.signal,
    maxRetriesPerProvider: opts.maxRetries ?? 1,
    rand: opts.rand,
    sleep: opts.sleep
  })
}

export interface EnterpriseWrapOptions {
  /** Injectable clock for tests. */
  now?: () => number
  /** Called once when the stream ends (done, error, timeout, cancel). */
  onMetrics?: (m: LlmCallMetrics) => void
  /** Override the hard timeout (tests). */
  hardTimeoutMs?: number
  /** Skip the answer-first filter (recap/summary/suggest already have their own shape). */
  answerFirst?: boolean
}

/**
 * Wrap one strategy handle with the enterprise contract. The dispatcher still chooses the strategy;
 * this is the one doorway those strategies return through.
 */
export function wrapEnterpriseStream(
  dispatch: (opts: StreamOptions) => StreamHandle,
  opts: StreamOptions,
  wrap: EnterpriseWrapOptions = {}
): StreamHandle {
  const now = wrap.now ?? Date.now
  const started = now()
  const hardMs = resolveHardTimeoutMs(opts.idleMs, wrap.hardTimeoutMs)
  const circuit = evaluateCircuit(opts.providerId, started)
  const answerFirst =
    wrap.answerFirst ??
    ((opts.req.mode === 'answer' || opts.req.mode === 'vision') && opts.req.kind !== 'factcheck')
  const filter = answerFirst ? new AnswerFirstFilter(opts.req.mode === 'answer' ? opts.req.prompt : undefined) : null

  let finished = false
  let cancelled = false
  let timedOut = false
  let ttftMs: number | null = null
  let inner: StreamHandle | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const finishMetrics = (): void => {
    wrap.onMetrics?.({
      providerId: opts.providerId,
      ttftMs,
      ttaMs: now() - started,
      cancelled,
      timedOut,
      circuitOpen: circuit.open
    })
  }

  const stopTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const handlers = opts.handlers
  const wrapped: StreamOptions = {
    ...opts,
    handlers: {
      onDelta: (text) => {
        if (finished || cancelled) return
        const out = filter ? filter.push(text) : text
        if (!out) return
        if (ttftMs == null) ttftMs = now() - started
        handlers.onDelta(out)
      },
      onDone: (u, completion) => {
        if (finished || cancelled) return
        finished = true
        stopTimer()
        const tail = filter ? filter.flush() : ''
        if (tail) {
          if (ttftMs == null) ttftMs = now() - started
          handlers.onDelta(tail)
        }
        finishMetrics()
        handlers.onDone(u, completion)
      },
      onError: (message) => {
        if (finished || cancelled) return
        finished = true
        stopTimer()
        finishMetrics()
        handlers.onError(
          honestError(message, `${opts.providerId} failed. Check the provider in Settings → AI.`)
        )
      }
    }
  }

  const abortInner = (): void => {
    try {
      inner?.abort()
    } catch {
      /* a strategy abort must never mask the timeout/cancel we are reporting */
    }
  }

  timer = setTimeout(() => {
    if (finished || cancelled) return
    timedOut = true
    finished = true
    stopTimer()
    abortInner()
    finishMetrics()
    handlers.onError(timeoutMessage(opts.providerId, hardMs))
  }, hardMs)

  inner = dispatch(wrapped)

  return {
    abort: () => {
      if (finished || cancelled) return
      cancelled = true
      finished = true
      stopTimer()
      abortInner()
      finishMetrics()
      // Do not call onError: a user cancel is not a failure the UI should toast as one.
      // index.ts's askCancel path already treats abort as silence.
    }
  }
}
