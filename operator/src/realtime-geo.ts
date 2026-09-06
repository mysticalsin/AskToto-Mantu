/** Shoey-shaped city geo from real seats. request.cf only. Never client GPS. */

export type RealtimeGeoRow = {
  country: string
  city: string
  count: number
  unique_sessions: number
  avg_duration: number
}

export type GeoRegionRow = {
  country: string
  region: string
  count: number
  unique_sessions: number
  avg_duration: number
}

export type SeatGeoInput = {
  device_id: string
  country: string | null
  city: string | null
  region?: string | null
  first_seen: number
  last_seen: number
}

/** A materialized session row (operator/src/sessions.ts), used when present so unique_sessions and
 *  avg_duration reflect real per-device pulses with gaps under 2 minutes, not a seat's whole lifetime. */
export type SessionGeoInput = {
  device_id: string
  country: string | null
  city: string | null
  region?: string | null
  started_at: number
  last_pulse_at: number
  ended_at: number | null
}

function durationMs(s: SeatGeoInput): number {
  return Math.max(0, s.last_seen - s.first_seen)
}

function sessionDurationMs(s: SessionGeoInput): number {
  const end = s.ended_at ?? s.last_pulse_at
  return Math.max(0, end - s.started_at)
}

function seatGroups(seats: SeatGeoInput[], keyOf: (s: SeatGeoInput) => string | null): Map<string, { devices: Set<string>; durations: number[] }> {
  const groups = new Map<string, { devices: Set<string>; durations: number[] }>()
  for (const s of seats) {
    const key = keyOf(s)
    if (!key) continue
    const g = groups.get(key) ?? { devices: new Set<string>(), durations: [] }
    g.devices.add(s.device_id)
    g.durations.push(durationMs(s))
    groups.set(key, g)
  }
  return groups
}

function sessionGroups(sessions: SessionGeoInput[], keyOf: (s: SessionGeoInput) => string | null): Map<string, { count: number; durations: number[] }> {
  const groups = new Map<string, { count: number; durations: number[] }>()
  for (const s of sessions) {
    const key = keyOf(s)
    if (!key) continue
    const g = groups.get(key) ?? { count: 0, durations: [] }
    g.count += 1
    g.durations.push(sessionDurationMs(s))
    groups.set(key, g)
  }
  return groups
}

function avg(durations: number[]): number {
  return durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0
}

export function realtimeGeoRows(seats: SeatGeoInput[], sessions?: SessionGeoInput[]): RealtimeGeoRow[] {
  const groups = seatGroups(seats, (s) => {
    const country = (s.country || '').trim().toUpperCase()
    const city = (s.city || '').trim()
    return country && city ? `${country}\0${city}` : null
  })
  const sessionsByKey = sessions
    ? sessionGroups(sessions, (s) => {
        const country = (s.country || '').trim().toUpperCase()
        const city = (s.city || '').trim()
        return country && city ? `${country}\0${city}` : null
      })
    : null
  return [...groups.entries()]
    .map(([key, g]) => {
      const [country, city] = key.split('\0')
      const sessionStats = sessionsByKey?.get(key)
      return {
        country,
        city,
        count: g.devices.size,
        unique_sessions: sessionStats ? sessionStats.count : g.devices.size,
        avg_duration: sessionStats ? avg(sessionStats.durations) : avg(g.durations)
      }
    })
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city))
}

export function geoRegionRows(seats: SeatGeoInput[], sessions?: SessionGeoInput[]): GeoRegionRow[] {
  const groups = seatGroups(seats, (s) => {
    const country = (s.country || '').trim().toUpperCase()
    const region = (s.region || '').trim()
    return country && region ? `${country}\0${region}` : null
  })
  const sessionsByKey = sessions
    ? sessionGroups(sessions, (s) => {
        const country = (s.country || '').trim().toUpperCase()
        const region = (s.region || '').trim()
        return country && region ? `${country}\0${region}` : null
      })
    : null
  return [...groups.entries()]
    .map(([key, g]) => {
      const [country, region] = key.split('\0')
      const sessionStats = sessionsByKey?.get(key)
      return {
        country,
        region,
        count: g.devices.size,
        unique_sessions: sessionStats ? sessionStats.count : g.devices.size,
        avg_duration: sessionStats ? avg(sessionStats.durations) : avg(g.durations)
      }
    })
    .sort((a, b) => b.count - a.count || a.region.localeCompare(b.region))
}

export type GeoCountryRow = {
  country: string
  count: number
  unique_sessions: number
  avg_duration: number
}

export function geoCountryRollup(rows: RealtimeGeoRow[]): GeoCountryRow[] {
  const m = new Map<string, { count: number; sessions: number; weighted: number }>()
  for (const r of rows) {
    const cur = m.get(r.country) ?? { count: 0, sessions: 0, weighted: 0 }
    cur.count += r.count
    cur.sessions += r.unique_sessions
    cur.weighted += r.avg_duration * r.count
    m.set(r.country, cur)
  }
  return [...m.entries()]
    .map(([country, c]) => ({
      country,
      count: c.count,
      unique_sessions: c.sessions,
      avg_duration: c.count ? Math.round(c.weighted / c.count) : 0
    }))
    .sort((a, b) => b.count - a.count)
}

export function formatAvgDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}
