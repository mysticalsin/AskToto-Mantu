import type { MeetingSummary, RecallHit } from '@shared/ipc'
import type { HistoryTrace } from '@shared/history-trace'

export type HistoryItem = MeetingSummary | RecallHit

/** One History fetch: the list, or the search for `query`; `total` is how many meetings matched in all. */
export async function fetchHistory(
  query: string,
  trace?: HistoryTrace
): Promise<{ items: HistoryItem[]; total: number }> {
  if (query) {
    const found = await window.toto.recallSearch(query)
    return { items: found.hits, total: found.total }
  }
  const items = await window.toto.recallList(trace)
  return { items, total: items.length }
}
