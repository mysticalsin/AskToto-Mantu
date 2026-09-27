import type { HistorySettled, HistoryTrace } from '@shared/ipc'

export interface HistoryRequest {
  /** Sent with recallList so main can time the queue and work stages. */
  readonly trace: HistoryTrace
  /** The IPC resolved; renderMs is measured from here. */
  resolved(): void
  /** React committed and painted the list this request fetched: reports outcome 'ok'. */
  painted(): void
  /** The response was never shown: reports 'discarded'. */
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

export function beginHistoryRequest(_deps?: HistoryRequestDeps): HistoryRequest {
  // Scaffolding: the real renderer History timing state machine lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
