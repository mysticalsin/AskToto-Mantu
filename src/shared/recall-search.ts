import type { RecallHit } from './ipc'

/** History search limits, shared so the search box and the main process agree: the box stops at the character
 *  cap, main reads no more than the term cap and returns no more than the result cap. */
export const RECALL_SEARCH_MAX_CHARS = 200
export const RECALL_SEARCH_MAX_TERMS = 16
export const RECALL_SEARCH_RESULT_CAP = 25

/** recall:search's answer: the best matches, and how many meetings matched in all. */
export interface RecallSearchResult {
  hits: RecallHit[]
  total: number
}

/** The note under capped search results, or null when every match is shown. */
export function searchCapNotice(shown: number, total: number): string | null {
  return total > shown ? `Showing the top ${shown} matches.` : null
}
