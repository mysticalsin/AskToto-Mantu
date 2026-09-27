import type { AuditSink } from '../../logger'

export interface HistoryTracer {
  /** Serve one History list request; audits only when `rawTrace` is a valid HistoryTrace. */
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

export function createHistoryTracer(_opts: HistoryTracerOptions): HistoryTracer {
  // Scaffolding: the real History request timing logic lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
