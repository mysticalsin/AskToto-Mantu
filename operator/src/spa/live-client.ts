/**
 * Pure state transitions for the rail's live-polling client (plan D3/D4). No DOM, no fetch,
 * no timers: operator/client/live.ts drives an actual poll loop around these functions. Kept
 * here rather than in operator/client/ because operator/vitest.config.ts only includes
 * `src/**\/*.test.ts` (operator/client is browser-only and not part of the vitest run), and this
 * is exactly the logic (fetch scheduling, backoff, ETag handling) that needs a real test.
 */

export type LiveConnState = 'live' | 'reconnecting' | 'paused'

/** Only the live.json fields the shell chrome consumes today (operator/src/routes/live.ts,
 * operator/src/dashboard.ts LiveSnapshot). Duplicated as a minimal local shape rather than
 * imported so this file stays dependency-free and safe to bundle into the browser client. */
export interface LiveSnapshotLike {
  generation: number
  liveSeats: number
  notices: number
}

export interface PollState {
  etag: string | null
  backoffMs: number
  state: LiveConnState
  lastSuccessAt: number | null
}

/** 5s, 10s, 20s, 40s, 60s (plan D3: "exponential backoff (5, 10, 20, 40, max 60s)"). */
export const BACKOFF_SEQUENCE_MS = [5000, 10000, 20000, 40000, 60000]
export const VISIBLE_INTERVAL_MS = 5000
export const HIDDEN_INTERVAL_MS = 30000

export function initialPollState(): PollState {
  return { etag: null, backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live', lastSuccessAt: null }
}

export type FetchOutcome =
  | { kind: 'not-modified' }
  | { kind: 'ok'; etag: string | null }
  | { kind: 'error' }

/**
 * One state transition: given the previous poll state and what the last fetch did, returns the
 * next poll state. A 200 or a 304 both count as a healthy round trip (reset backoff, state
 * 'live'); a network failure or a non-2xx/304 status backs off through BACKOFF_SEQUENCE_MS and
 * flips to 'reconnecting'. Never throws, never touches the DOM or a clock other than `now`.
 */
export function nextPollState(prev: PollState, outcome: FetchOutcome, now: number): PollState {
  if (outcome.kind === 'error') {
    const idx = BACKOFF_SEQUENCE_MS.indexOf(prev.backoffMs)
    const nextBackoff = BACKOFF_SEQUENCE_MS[Math.min(idx + 1, BACKOFF_SEQUENCE_MS.length - 1)]
    return { ...prev, backoffMs: nextBackoff, state: 'reconnecting' }
  }
  if (outcome.kind === 'not-modified') {
    return { ...prev, backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live', lastSuccessAt: now }
  }
  return { etag: outcome.etag ?? prev.etag, backoffMs: BACKOFF_SEQUENCE_MS[0], state: 'live', lastSuccessAt: now }
}

/** Delay until the next poll. Reconnecting always uses the current backoff step regardless of
 * visibility; a healthy connection uses the visible/hidden cadence (plan D3: 5s visible, 30s
 * hidden). */
export function pollDelayMs(state: PollState, visible: boolean): number {
  if (state.state === 'reconnecting') return state.backoffMs
  return visible ? VISIBLE_INTERVAL_MS : HIDDEN_INTERVAL_MS
}

/** What the rail indicator shows. A hidden tab always reads "Paused" regardless of connection
 * health (plan 6.1), even though polling keeps running underneath at the slower cadence. */
export function displayLiveState(poll: LiveConnState, documentVisible: boolean): LiveConnState {
  if (!documentVisible) return 'paused'
  return poll
}

/**
 * "Live, updated 3s ago" / "Live, updated just now" / "Reconnecting" / "Paused". `formatAge` is
 * injected (the real client passes operator/src/render primitives.relativeTime) so this stays a
 * pure string function with no time-formatting duplicated here.
 */
export function liveStatusText(
  display: LiveConnState,
  lastSuccessAt: number | null,
  now: number,
  formatAge: (ts: number, now: number) => string
): string {
  if (display === 'paused') return 'Paused'
  if (display === 'reconnecting') return 'Reconnecting'
  if (lastSuccessAt == null) return 'Live'
  const age = formatAge(lastSuccessAt, now)
  return age === 'now' ? 'Live, updated just now' : `Live, updated ${age} ago`
}

/** Rail badge ids the live payload can drive today (plan 6.1: Licenses = pending approvals,
 * Notifications = unseen, Connectors = failing tests). Only `notices` exists on LiveSnapshot as
 * of this task (B7, plan section 7, has not landed) — licenses and connectors are intentionally
 * left out of the returned record (never zeroed) so the caller never overwrites a real
 * server-rendered count with a fabricated one. */
export function badgeCountsFromSnapshot(
  snapshot: LiveSnapshotLike
): Partial<Record<'licenses' | 'notifications' | 'connectors', number>> {
  return { notifications: snapshot.notices }
}
