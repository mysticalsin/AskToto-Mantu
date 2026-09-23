/** Shoey-shaped city geo from real seats. request.cf only. Never client GPS. */

import { isRealSeat } from './fleet'
import { looksLikeSecret } from './redact'
import type { AskRow, SeatRow, SessionRow } from './store'
import { countryName } from './world/map'

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

// ---------------------------------------------------------------------------------------
// Realtime places (live.json `geo.places`, DashboardPayload.realtime). One function feeds both
// the SSR Realtime page and the 5 s poll so the two can never disagree about what is on the map.
// ---------------------------------------------------------------------------------------

/** Seats count toward the Realtime map for 30 minutes after their last heartbeat. */
export const REALTIME_WINDOW_MS = 30 * 60 * 1000

/** Exactly eight keys (live.json contract, PLAN.md Architecture "Live"). */
export type RealtimePlace = {
  iso2: string
  country: string
  region: string | null
  city: string | null
  lat: number
  lon: number
  seats: number
  sessions: number
}

export type PlaceActivity = {
  modes: [string, number][]
  skills: [string, number][]
}

const ISO2 = /^[A-Z]{2}$/

function round2(n: number): number {
  return Number(n.toFixed(2))
}

function cleanText(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t && !looksLikeSecret(t) ? t : null
}

/** Stable identity of a place: ISO2, city, and lat/lon at 2 dp (~1 km). */
export function placeKey(p: Pick<RealtimePlace, 'iso2' | 'city' | 'lat' | 'lon'>): string {
  return `${p.iso2}|${p.city ?? ''}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`
}

function seatPlaceKey(s: SeatRow): string | null {
  const iso2 = (s.country || '').trim().toUpperCase()
  if (!ISO2.test(iso2)) return null
  if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return null
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null
  if (s.lat < -90 || s.lat > 90 || s.lon < -180 || s.lon > 180) return null
  return placeKey({ iso2, city: cleanText(s.city), lat: round2(s.lat), lon: round2(s.lon) })
}

function recentRealSeats(seats: SeatRow[], now: number): SeatRow[] {
  return seats.filter((s) => isRealSeat(s) && now - s.last_seen <= REALTIME_WINDOW_MS)
}

/**
 * Seats heard from in the last 30 min with a usable lat/lon, grouped by place. Seats without
 * coordinates are excluded here (they are counted under "Not set" by the geo tables instead).
 * `sessions` counts open (not ended) sessions of the seats at that place.
 */
export function realtimePlaces(seats: SeatRow[], sessions: SessionRow[], now: number): RealtimePlace[] {
  const openByDevice = new Set(sessions.filter((s) => s.ended_at == null).map((s) => s.device_id))
  const byKey = new Map<string, RealtimePlace>()
  for (const s of recentRealSeats(seats, now)) {
    const key = seatPlaceKey(s)
    if (!key) continue
    const cur = byKey.get(key)
    const open = openByDevice.has(s.device_id) ? 1 : 0
    if (cur) {
      cur.seats += 1
      cur.sessions += open
      if (!cur.region) cur.region = cleanText(s.region)
      continue
    }
    const iso2 = (s.country || '').trim().toUpperCase()
    byKey.set(key, {
      iso2,
      country: countryName(iso2),
      region: cleanText(s.region),
      city: cleanText(s.city),
      lat: round2(s.lat as number),
      lon: round2(s.lon as number),
      seats: 1,
      sessions: open
    })
  }
  return [...byKey.values()].sort((a, b) => b.seats - a.seats || placeKey(a).localeCompare(placeKey(b)))
}

function topCounts(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
}

/**
 * Ask modes and skill ids per place over the last 30 min (asks joined device -> seat -> place).
 * Only places with at least one ask appear; keys are always a subset of `places` keys. Names only:
 * `asks` must already be privacy-projected (projectAskTelemetry), and no prompt/preview is read.
 */
export function realtimePlaceActivity(
  places: RealtimePlace[],
  seats: SeatRow[],
  asks: Pick<AskRow, 'device_id' | 'ts' | 'mode' | 'skill_id'>[],
  now: number
): Record<string, PlaceActivity> {
  const known = new Set(places.map(placeKey))
  const placeByDevice = new Map<string, string>()
  for (const s of recentRealSeats(seats, now)) {
    const key = seatPlaceKey(s)
    if (key && known.has(key)) placeByDevice.set(s.device_id, key)
  }
  const acc = new Map<string, { modes: Map<string, number>; skills: Map<string, number> }>()
  for (const a of asks) {
    if (now - a.ts > REALTIME_WINDOW_MS || a.ts > now) continue
    const key = placeByDevice.get(a.device_id)
    if (!key) continue
    const cur = acc.get(key) ?? { modes: new Map<string, number>(), skills: new Map<string, number>() }
    const mode = cleanText(a.mode)
    const skill = cleanText(a.skill_id)
    if (mode) cur.modes.set(mode, (cur.modes.get(mode) ?? 0) + 1)
    if (skill) cur.skills.set(skill, (cur.skills.get(skill) ?? 0) + 1)
    acc.set(key, cur)
  }
  const out: Record<string, PlaceActivity> = {}
  for (const key of [...acc.keys()].sort()) {
    const cur = acc.get(key)!
    if (!cur.modes.size && !cur.skills.size) continue
    out[key] = { modes: topCounts(cur.modes, 5), skills: topCounts(cur.skills, 5) }
  }
  return out
}
