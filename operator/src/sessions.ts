/**
 * Pure session math (no I/O). A session is one seat's pulses (heartbeat, ask, recap) with gaps
 * under 2 minutes: the ingest path calls OperatorStore#touchSession per pulse, which reads the
 * seat's most recent session row and asks applyPulse what to do with it, then persists the result.
 * Kept pure and dependency-free so the 2-minute-gap rule has one tested definition (section 9c).
 */

export const SESSION_GAP_MS = 2 * 60 * 1000

export type PulseKind = 'heartbeat' | 'ask' | 'recap'

export interface SessionRow {
  id: string
  device_id: string
  started_at: number
  last_pulse_at: number
  ended_at: number | null
  pulses: number
  asks: number
  recaps: number
  country: string | null
  city: string | null
  os: string | null
  app_version: string | null
}

export interface PulseInput {
  deviceId: string
  ts: number
  kind: PulseKind
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
}

export interface ApplyPulseResult {
  /** The session row to persist (an in-place update of `existing`, or a freshly opened one). */
  session: SessionRow
  /** Set when `existing` was open and gets closed in favor of the new row above. */
  closed: SessionRow | null
  /** True when `session` is a new row distinct from `existing`. */
  opened: boolean
}

function bump(session: SessionRow, kind: PulseKind): SessionRow {
  return {
    ...session,
    pulses: session.pulses + 1,
    asks: session.asks + (kind === 'ask' ? 1 : 0),
    recaps: session.recaps + (kind === 'recap' ? 1 : 0)
  }
}

/** A session is still open (never ended) and the gap since its last pulse is inside the window. */
export function isSessionOpen(session: Pick<SessionRow, 'ended_at'>): boolean {
  return session.ended_at == null
}

export function isSessionStale(session: Pick<SessionRow, 'ended_at' | 'last_pulse_at'>, now: number, gapMs = SESSION_GAP_MS): boolean {
  return isSessionOpen(session) && now - session.last_pulse_at > gapMs
}

/**
 * Decide what a new pulse does to the seat's most recent session (or null if it never had one).
 * `existing` continues in place when it is open and the new pulse arrives within `gapMs`;
 * otherwise it is closed (ended_at = its own last_pulse_at, never the new pulse's ts) and a fresh
 * session opens. Geo/OS/version follow the newest non-null value, same COALESCE shape as upsertSeat.
 */
export function applyPulse(
  existing: SessionRow | null,
  input: PulseInput,
  newId: () => string,
  gapMs = SESSION_GAP_MS
): ApplyPulseResult {
  if (existing && isSessionOpen(existing) && input.ts - existing.last_pulse_at <= gapMs && input.ts >= existing.last_pulse_at) {
    const continued = bump(
      {
        ...existing,
        last_pulse_at: input.ts,
        country: input.country ?? existing.country,
        city: input.city ?? existing.city,
        os: input.os ?? existing.os,
        app_version: input.appVersion ?? existing.app_version
      },
      input.kind
    )
    return { session: continued, closed: null, opened: false }
  }
  const closed: SessionRow | null = existing && isSessionOpen(existing) ? { ...existing, ended_at: existing.last_pulse_at } : null
  const opened = bump(
    {
      id: newId(),
      device_id: input.deviceId,
      started_at: input.ts,
      last_pulse_at: input.ts,
      ended_at: null,
      pulses: 0,
      asks: 0,
      recaps: 0,
      country: input.country,
      city: input.city,
      os: input.os,
      app_version: input.appVersion
    },
    input.kind
  )
  return { session: opened, closed, opened: true }
}

export function sessionDurationMs(session: Pick<SessionRow, 'started_at' | 'last_pulse_at' | 'ended_at'>): number {
  const end = session.ended_at ?? session.last_pulse_at
  return Math.max(0, end - session.started_at)
}

export function averageSessionDurationMs(sessions: Pick<SessionRow, 'started_at' | 'last_pulse_at' | 'ended_at'>[]): number | null {
  if (!sessions.length) return null
  const total = sessions.reduce((sum, s) => sum + sessionDurationMs(s), 0)
  return Math.round(total / sessions.length)
}
