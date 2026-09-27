import type { AuditSink } from '../../logger'
import { HistorySettledSchema, HistoryTraceSchema } from '@shared/ipc'

export interface HistoryTracer {
  /** Serve one History list request; audits `received` and `served` when `rawTrace` is a valid HistoryTrace,
   *  otherwise just serves (BrainView/Review/Settings call recallList untraced). */
  traceList<T extends readonly unknown[]>(rawTrace: unknown, list: () => Promise<T>): Promise<T>
  /** Audit the renderer's `settled` report, once, and only for a requestId this tracer received. */
  settle(rawReport: unknown): void
}

export interface HistoryTracerOptions {
  audit: AuditSink
  wallClock?: () => number
  clock?: () => number
}

export const MAX_UNSETTLED = 32

export function createHistoryTracer(opts: HistoryTracerOptions): HistoryTracer {
  const wallClock = opts.wallClock ?? Date.now
  const clock = opts.clock ?? (() => performance.now())
  const unsettled = new Set<string>()

  const remember = (requestId: string): void => {
    unsettled.add(requestId)
    while (unsettled.size > MAX_UNSETTLED) {
      // size > MAX_UNSETTLED > 0 guarantees a first entry exists.
      const oldest = unsettled.values().next().value!
      unsettled.delete(oldest)
    }
  }

  return {
    async traceList<T extends readonly unknown[]>(rawTrace: unknown, list: () => Promise<T>): Promise<T> {
      const parsed = HistoryTraceSchema.safeParse(rawTrace)
      if (!parsed.success) return list()
      const { requestId, sentAt } = parsed.data
      remember(requestId)
      opts.audit('history.request', {
        requestId,
        stage: 'received',
        queueMs: Math.max(0, wallClock() - sentAt)
      })
      const startedAt = clock()
      try {
        const result = await list()
        opts.audit('history.request', {
          requestId,
          stage: 'served',
          outcome: 'ok',
          mainMs: Math.max(0, clock() - startedAt),
          resultCount: result.length
        })
        return result
      } catch (error) {
        opts.audit('history.request', {
          requestId,
          stage: 'served',
          outcome: 'failed',
          mainMs: Math.max(0, clock() - startedAt)
        })
        throw error
      }
    },
    settle(rawReport: unknown): void {
      const parsed = HistorySettledSchema.safeParse(rawReport)
      if (!parsed.success) return
      const { requestId, outcome, ipcMs, renderMs } = parsed.data
      if (!unsettled.delete(requestId)) return
      opts.audit('history.request', {
        requestId,
        stage: 'settled',
        outcome,
        ipcMs,
        renderMs
      })
    }
  }
}
