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

function durationMs(s: SeatGeoInput): number {
  return Math.max(0, s.last_seen - s.first_seen)
}

export function realtimeGeoRows(seats: SeatGeoInput[]): RealtimeGeoRow[] {
  const groups = new Map<string, { country: string; city: string; devices: Set<string>; durations: number[] }>()
  for (const s of seats) {
    const country = (s.country || '').trim().toUpperCase()
    const city = (s.city || '').trim()
    if (!country || !city) continue
    const key = `${country}\0${city}`
    const g = groups.get(key) ?? { country, city, devices: new Set<string>(), durations: [] }
    g.devices.add(s.device_id)
    g.durations.push(durationMs(s))
    groups.set(key, g)
  }
  return [...groups.values()]
    .map((g) => ({
      country: g.country,
      city: g.city,
      count: g.devices.size,
      unique_sessions: g.devices.size,
      avg_duration: g.durations.length
        ? Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length)
        : 0
    }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city))
}

export function geoRegionRows(seats: SeatGeoInput[]): GeoRegionRow[] {
  const groups = new Map<string, { country: string; region: string; devices: Set<string>; durations: number[] }>()
  for (const s of seats) {
    const country = (s.country || '').trim().toUpperCase()
    const region = (s.region || '').trim()
    if (!country || !region) continue
    const key = `${country}\0${region}`
    const g = groups.get(key) ?? { country, region, devices: new Set<string>(), durations: [] }
    g.devices.add(s.device_id)
    g.durations.push(durationMs(s))
    groups.set(key, g)
  }
  return [...groups.values()]
    .map((g) => ({
      country: g.country,
      region: g.region,
      count: g.devices.size,
      unique_sessions: g.devices.size,
      avg_duration: g.durations.length
        ? Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length)
        : 0
    }))
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
