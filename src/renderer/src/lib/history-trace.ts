import type { HistorySettled, HistoryTrace } from '@shared/ipc'

export interface HistoryRequest {
  /** Sent with recallList so main can time the queue and work stages. */
  readonly trace: HistoryTrace
  /** The IPC resolved; renderMs is measured from here. */
  resolved(): void
  /** React committed and painted the list this request fetched: reports outcome 'ok'. */
  painted(): void
  /** The response was never shown (a newer request won, or History closed): reports 'discarded'. */
  discarded(): void
  /** The IPC rejected: reports 'failed'. */
  failed(): void
}

export interface HistoryRequestDeps {
  report: (settled: HistorySettled) => void
  newId: () => string
  wallClock: () => number
  clock: () => number
}

export function beginHistoryRequest(deps: HistoryRequestDeps = defaultDeps()): HistoryRequest {
  const trace: HistoryTrace = { requestId: deps.newId(), sentAt: deps.wallClock() }
  const startedAt = deps.clock()
  let resolvedAt: number | null = null
  let settled = false

  const finish = (outcome: HistorySettled['outcome']): void => {
    if (settled) return
    settled = true
    const finishedAt = deps.clock()
    const base: HistorySettled = {
      requestId: trace.requestId,
      outcome,
      ipcMs: Math.max(0, (resolvedAt ?? finishedAt) - startedAt)
    }
    deps.report(
      outcome === 'ok'
        ? { ...base, renderMs: Math.max(0, finishedAt - (resolvedAt ?? finishedAt)) }
        : base
    )
  }

  return {
    trace,
    resolved(): void {
      if (resolvedAt === null) resolvedAt = deps.clock()
    },
    painted(): void {
      finish('ok')
    },
    discarded(): void {
      finish('discarded')
    },
    failed(): void {
      finish('failed')
    }
  }
}

function defaultDeps(): HistoryRequestDeps {
  return {
    report: (settled) => {
      void window.toto.reportHistorySettled(settled).catch(() => {})
    },
    newId: () => crypto.randomUUID(),
    wallClock: Date.now,
    clock: () => performance.now()
  }
}
