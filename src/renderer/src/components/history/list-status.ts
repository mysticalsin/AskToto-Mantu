/**
 * History's list request as the user sees it: a spinner, the rows, the empty state, or a degraded banner.
 *
 * Invariants:
 *   - The spinner shows only while a request is 'loading', and a request still unanswered after
 *     HISTORY_DEGRADED_MS turns 'slow': the list never spins indefinitely.
 *   - 'slow' and 'failed' keep the rows already on screen and explain the gap in a banner; only an answered
 *     request ('ready') may say there are no meetings.
 *   - A late 'slow' never overrides an answer that already arrived.
 */
import type { MeetingSummary } from '@shared/ipc'

export const HISTORY_DEGRADED_MS = 2000

export type ListPhase = 'loading' | 'slow' | 'failed' | 'ready'
export type ListEvent = 'request' | 'slow' | 'answered' | 'failed'

export function nextListPhase(phase: ListPhase, event: ListEvent): ListPhase {
  switch (event) {
    case 'request':
      return 'loading'
    case 'slow':
      return phase === 'loading' ? 'slow' : phase
    case 'answered':
      return 'ready'
    case 'failed':
      return 'failed'
  }
}

/** Calls `onSlow` once HISTORY_DEGRADED_MS pass; the returned cancel is for a request that settled first. */
export function armSlowNotice(onSlow: () => void, ms = HISTORY_DEGRADED_MS): () => void {
  const timer = setTimeout(onSlow, ms)
  return () => clearTimeout(timer)
}

/** What the list area shows: 'blank' leaves it to the banner rather than claim there are no meetings. */
export type ListBody = 'spinner' | 'rows' | 'empty' | 'blank'

export function listBody(phase: ListPhase, rowCount: number): ListBody {
  if (phase === 'loading') return 'spinner'
  if (rowCount > 0) return 'rows'
  return phase === 'ready' ? 'empty' : 'blank'
}

export interface DegradedBanner {
  kind: 'slow' | 'failed' | 'unavailable'
  message: string
  /** Offer Retry: a new request can help (it cannot while the current one is still out). */
  retry: boolean
}

export function degradedBanner(phase: ListPhase, rows: readonly Pick<MeetingSummary, 'unavailable'>[]): DegradedBanner | null {
  if (phase === 'slow') {
    return { kind: 'slow', message: 'OneDrive is slow to answer. Meetings appear here as soon as it does.', retry: false }
  }
  if (phase === 'failed') {
    return { kind: 'failed', message: 'Could not load your meetings. Check that OneDrive is reachable, then retry.', retry: true }
  }
  if (phase !== 'ready') return null
  const unavailable = rows.filter((row) => row.unavailable).length
  if (unavailable === 0) return null
  return {
    kind: 'unavailable',
    message: `${unavailable === 1 ? '1 meeting' : `${unavailable} meetings`} could not be read right now.`,
    retry: true
  }
}
