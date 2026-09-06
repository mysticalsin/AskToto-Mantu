/**
 * Realtime/live polling routes (plan D4 + section 9c "Realtime"). `GET /v1/admin/live.json` is the
 * compact ETag-conditioned snapshot the console polls every 5 s; `GET /v1/admin/realtime/live-seats.json`
 * and `GET /v1/admin/realtime/geo.json` back the Realtime page's people table and geo table; the old
 * `GET /v1/admin/realtime.geo.json` keeps working as an alias of its original shape.
 */
import { buildDashboard, buildLiveSnapshot, ONLINE_MS } from '../dashboard'
import { isRealSeat } from '../fleet'
import { json, noStoreHeaders } from '../http'
import { sessionDurationMs } from '../sessions'
import type { GroupRow, IntegrationRow, IssuedLicenseRow, OperatorStore, SeatRow } from '../store'
import { resolveTierAndEntitlements } from '../tiers'
import { readOperatorSettings } from './settings-store'
import { defineRoute } from './registry'
import { cloudflareForDashboard, keyFlags, type AdminCtx } from './admin-ctx'
import { profileOf, safeCity } from './seat-view'

const THIRTY_MIN_MS = 30 * 60 * 1000

function licenseStateOf(seat: SeatRow, tier: string | null): 'licensed' | 'revoked' | 'trial' | 'unlicensed' {
  if ((seat.approval || '').trim().toLowerCase() === 'revoked') return 'revoked'
  if (tier) return 'licensed'
  if ((seat.license || '').trim().toLowerCase().startsWith('trial')) return 'trial'
  return 'unlicensed'
}

/** ETag comparison: browsers may send a weak or strong tag list; a single exact match is enough here
 *  since this Worker only ever mints one weak tag per snapshot. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(',')
    .map((s) => s.trim())
    .includes(etag)
}

function liveJsonResponse(body: unknown, etag: string, status: 200 | 304 = 200): Response {
  const headers: Record<string, string> = { ...noStoreHeaders(), etag }
  if (status === 304) return new Response(null, { status, headers })
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
}

export interface LiveSeatTableRow {
  deviceId: string
  hostname: string | null
  email: string | null
  country: string | null
  city: string | null
  os: string
  appVersion: string
  tier: string | null
  licenseState: 'licensed' | 'revoked' | 'trial' | 'unlicensed'
  sessionStartedAt: number | null
  durationMs: number | null
  eventsThisSession: number | null
  asksThisSession: number | null
  lastSeen: number
  live: boolean
}

/** Seats with a heartbeat in the last 30 min (section 9c "Connected people"). Bounded: one `listSeats`
 *  and one bounded `listSessions` read, tier resolution reuses one preloaded `listTiers()` call. */
async function buildLiveSeatsTable(store: OperatorStore, now: number): Promise<LiveSeatTableRow[]> {
  const [seatsRaw, sessionsPage, tiers] = await Promise.all([
    store.listSeats(),
    store.listSessions({ since: now - THIRTY_MIN_MS, limit: 500 }),
    store.listTiers()
  ])
  const seats = seatsRaw.filter(isRealSeat).filter((s) => now - s.last_seen <= THIRTY_MIN_MS)
  const openByDevice = new Map<string, (typeof sessionsPage.rows)[number]>()
  for (const s of sessionsPage.rows) {
    if (s.ended_at != null) continue
    const cur = openByDevice.get(s.device_id)
    if (!cur || s.started_at > cur.started_at) openByDevice.set(s.device_id, s)
  }
  const rows = await Promise.all(
    seats.map(async (s) => {
      const { tier } = await resolveTierAndEntitlements(store, s, now, tiers)
      const session = openByDevice.get(s.device_id) ?? null
      const who = profileOf(s)
      return {
        deviceId: s.device_id,
        hostname: who.hostname,
        email: who.email,
        country: s.country,
        city: safeCity(s),
        os: s.os,
        appVersion: s.app_version,
        tier,
        licenseState: licenseStateOf(s, tier),
        sessionStartedAt: session?.started_at ?? null,
        durationMs: session ? Math.max(0, now - session.started_at) : null,
        eventsThisSession: session?.pulses ?? null,
        asksThisSession: session?.asks ?? null,
        lastSeen: s.last_seen,
        live: now - s.last_seen < ONLINE_MS
      }
    })
  )
  return rows.sort((a, b) => b.lastSeen - a.lastSeen)
}

export interface GeoTableRow {
  iso: string
  country: string
  city: string | null
  events: number
  liveSessions: number
  seats30m: number
  avgDurationMs: number
}

/** Section 9c "Geo table": grouped by country + city, events in the last 30 min, live sessions
 *  (heartbeat in the last 2 min), seats30m (any activity in the last 30 min), and mean session
 *  duration. Bounded: fixed lookback window, capped reads on seats/sessions/events. */
async function buildGeoTable(store: OperatorStore, now: number): Promise<GeoTableRow[]> {
  const since = now - THIRTY_MIN_MS
  const [seatsRaw, sessionsPage, eventsPage] = await Promise.all([
    store.listSeats(),
    store.listSessions({ since, limit: 500 }),
    store.listEvents(500, { since, until: now, limit: 500 })
  ])
  const seatsById = new Map(seatsRaw.map((s) => [s.device_id, s]))
  const seats = seatsRaw.filter(isRealSeat).filter((s) => s.last_seen >= since && Boolean(s.country))

  type Bucket = { country: string; city: string | null; seats: Set<string>; live: Set<string>; events: number; durations: number[] }
  const buckets = new Map<string, Bucket>()
  function bucketFor(country: string, city: string | null): Bucket {
    const key = `${country}\0${city ?? ''}`
    let b = buckets.get(key)
    if (!b) {
      b = { country, city, seats: new Set(), live: new Set(), events: 0, durations: [] }
      buckets.set(key, b)
    }
    return b
  }

  for (const s of seats) {
    const country = (s.country || '').toUpperCase()
    if (!country) continue
    const b = bucketFor(country, safeCity(s))
    b.seats.add(s.device_id)
    if (now - s.last_seen < ONLINE_MS) b.live.add(s.device_id)
  }

  for (const e of eventsPage.rows) {
    const seat = e.device_id ? seatsById.get(e.device_id) : undefined
    const country = (e.country || seat?.country || '').toUpperCase()
    if (!country) continue
    bucketFor(country, safeCity(seat)).events++
  }

  for (const sess of sessionsPage.rows) {
    const country = (sess.country || '').toUpperCase()
    if (!country) continue
    bucketFor(country, safeCity(sess)).durations.push(sessionDurationMs(sess))
  }

  return [...buckets.values()]
    .map((b) => ({
      iso: b.country,
      country: b.country,
      city: b.city,
      events: b.events,
      liveSessions: b.live.size,
      seats30m: b.seats.size,
      avgDurationMs: b.durations.length ? Math.round(b.durations.reduce((a, c) => a + c, 0) / b.durations.length) : 0
    }))
    .sort((a, b) => b.liveSessions - a.liveSessions || b.events - a.events)
}

export interface SearchResultItem {
  id: string
  label: string
  sublabel: string | null
  page: string
  rowKey: string
}

export interface SearchResults {
  seats: SearchResultItem[]
  licenses: SearchResultItem[]
  groups: SearchResultItem[]
  integrations: SearchResultItem[]
}

const SEARCH_LIMIT_PER_GROUP = 8

function matchesQuery(q: string, fields: (string | null | undefined)[]): boolean {
  const needle = q.toLowerCase()
  return fields.some((f) => (f || '').toLowerCase().includes(needle))
}

/** Never the full device id in a label a person types to search by - just enough to recognise a
 *  machine, matching what a hostname-less seat already shows elsewhere in the console. */
function deviceShortId(deviceId: string): string {
  return deviceId.length > 8 ? deviceId.slice(-8) : deviceId
}

/** Rail search (plan 3.7 item 7, task B7): up to 8 matches per group, never a credential or a full
 *  license. `rowKey` is what the client re-selects on the target page after navigating there. */
function searchSeats(seats: SeatRow[], q: string): SearchResultItem[] {
  const out: SearchResultItem[] = []
  for (const s of seats) {
    if (!isRealSeat(s)) continue
    const who = profileOf(s)
    if (!matchesQuery(q, [who.hostname, who.email, deviceShortId(s.device_id)])) continue
    out.push({
      id: s.device_id,
      label: who.hostname || who.email || deviceShortId(s.device_id),
      sublabel: who.hostname && who.email ? who.email : safeCity(s),
      page: 'sessions',
      rowKey: s.device_id
    })
    if (out.length >= SEARCH_LIMIT_PER_GROUP) break
  }
  return out
}

function searchLicenses(issued: IssuedLicenseRow[], q: string): SearchResultItem[] {
  const out: SearchResultItem[] = []
  for (const l of issued) {
    if (!matchesQuery(q, [l.last4, l.tier, l.member])) continue
    out.push({
      id: l.jti,
      label: `License ···${l.last4}`,
      sublabel: [l.tier, l.revoked ? 'revoked' : 'active'].filter(Boolean).join(' · '),
      page: 'licenses',
      rowKey: l.jti
    })
    if (out.length >= SEARCH_LIMIT_PER_GROUP) break
  }
  return out
}

function searchGroups(groups: GroupRow[], q: string): SearchResultItem[] {
  const out: SearchResultItem[] = []
  for (const g of groups) {
    if (!matchesQuery(q, [g.name])) continue
    out.push({ id: g.id, label: g.name, sublabel: g.tier, page: 'groups', rowKey: g.id })
    if (out.length >= SEARCH_LIMIT_PER_GROUP) break
  }
  return out
}

function searchIntegrations(rows: IntegrationRow[], q: string): SearchResultItem[] {
  const out: SearchResultItem[] = []
  for (const r of rows) {
    if (!matchesQuery(q, [r.label, r.kind])) continue
    out.push({ id: r.id, label: r.label, sublabel: r.kind, page: 'connectors', rowKey: r.id })
    if (out.length >= SEARCH_LIMIT_PER_GROUP) break
  }
  return out
}

async function buildSearchResults(store: OperatorStore, q: string): Promise<SearchResults> {
  const [seats, issued, groups, integrations] = await Promise.all([
    store.listSeats(),
    store.listIssuedLicenses(),
    store.listGroups(),
    store.listIntegrationRows()
  ])
  return {
    seats: searchSeats(seats, q),
    licenses: searchLicenses(issued, q),
    groups: searchGroups(groups, q),
    integrations: searchIntegrations(integrations, q)
  }
}

export function registerLiveRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/live.json',
    auth: 'admin',
    handler: async (request, ctx) => {
      const sinceParam = new URL(request.url).searchParams.get('since')
      const since = sinceParam != null && sinceParam !== '' && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : undefined
      const { settingsVersion } = await readOperatorSettings(ctx.env.DB)
      const snapshot = await buildLiveSnapshot(ctx.store, ctx.now, { since, settingsVersion })
      const etag = `W/"${snapshot.generation}"`
      const ifNoneMatch = request.headers.get('if-none-match')
      if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) return liveJsonResponse(null, etag, 304)
      return liveJsonResponse({ ok: true, ...snapshot, serverNow: ctx.now }, etag)
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/realtime.geo.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const dash = await buildDashboard(ctx.store, ctx.email, ctx.now, keyFlags(ctx.env), await cloudflareForDashboard(ctx.store, ctx.env, ctx.opts, ctx.now))
      return json({ ok: true, geo: dash.geo, regions: dash.geoRegions })
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/realtime/geo.json',
    auth: 'admin',
    handler: async (_request, ctx) => json({ ok: true, rows: await buildGeoTable(ctx.store, ctx.now) })
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/realtime/live-seats.json',
    auth: 'admin',
    handler: async (_request, ctx) => json({ ok: true, rows: await buildLiveSeatsTable(ctx.store, ctx.now) })
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/search.json',
    auth: 'admin',
    handler: async (request, ctx) => {
      const q = (new URL(request.url).searchParams.get('q') || '').trim()
      if (!q) return json({ ok: true, seats: [], licenses: [], groups: [], integrations: [] })
      const results = await buildSearchResults(ctx.store, q)
      return json({ ok: true, ...results })
    }
  })
}
