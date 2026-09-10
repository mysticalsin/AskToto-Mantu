/**
 * `GET /v1/admin/sessions.json` and `GET /v1/admin/sessions/:id.json` (plan section 9c "Sessions"):
 * one seat's pulses materialized in the `sessions` table (operator/src/sessions.ts owns the 2-minute
 * gap math). `since`/`until`/`device`/`cursor`/`limit` and the `range` preset are handled by
 * `OperatorStore#listSessions`'s bounded query; `country`/`os`/`q` are not part of the store's
 * `SessionsQueryOpts` contract, so they are applied on the page the store already returned. A
 * filtered page can come back with fewer than `limit` rows; the client keeps paging with
 * `nextCursor` (the store's own cursor) until it is null, same as an unfiltered page.
 */
import { ONLINE_MS } from '../dashboard'
import { json } from '../http'
import type { SessionRow } from '../store'
import { resolveTierAndEntitlements } from '../tiers'
import { projectAskTelemetry, projectEventTelemetry } from '../privacy'
import { resolveRange, parseLimit } from './events'
import { defineRoute, type RouteMatch } from './registry'
import type { AdminCtx } from './admin-ctx'
import { profileOf, safeCity, seatCache } from './seat-view'

export interface SessionsFilterOpts {
  country?: string
  os?: string
  q?: string
}

export interface SessionsQuery {
  since: number
  until: number
  deviceId?: string
  cursor?: string
  limit: number
  filter: SessionsFilterOpts
}

export function parseSessionsQuery(url: URL, now: number): SessionsQuery {
  const params = url.searchParams
  const { since, until } = resolveRange(params, now)
  return {
    since,
    until,
    deviceId: params.get('device')?.trim() || undefined,
    cursor: params.get('cursor')?.trim() || undefined,
    limit: parseLimit(params.get('limit')),
    filter: {
      country: params.get('country')?.trim() || undefined,
      os: params.get('os')?.trim() || undefined,
      q: params.get('q')?.trim() || undefined
    }
  }
}

function sessionMatchesFilter(
  s: SessionRow,
  filter: SessionsFilterOpts,
  who: { hostname: string | null; email: string | null }
): boolean {
  if (filter.country && (s.country || '').toUpperCase() !== filter.country.toUpperCase()) return false
  if (filter.os && (s.os || '').toLowerCase() !== filter.os.toLowerCase()) return false
  if (filter.q) {
    const q = filter.q.toLowerCase()
    const haystack = [s.device_id, s.city, s.country, s.os, s.app_version, who.hostname, who.email]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

export interface SessionListRow {
  id: string
  deviceId: string
  hostname: string | null
  email: string | null
  startedAt: number
  lastPulseAt: number
  endedAt: number | null
  durationMs: number
  pulses: number
  asks: number
  recaps: number
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
  tier: string | null
  live: boolean
}

function isLive(s: Pick<SessionRow, 'ended_at' | 'last_pulse_at'>, now: number): boolean {
  return s.ended_at == null && now - s.last_pulse_at < ONLINE_MS
}

function durationOf(s: Pick<SessionRow, 'started_at' | 'last_pulse_at' | 'ended_at'>): number {
  const end = s.ended_at ?? s.last_pulse_at
  return Math.max(0, end - s.started_at)
}

function toSessionRow(s: SessionRow, tier: string | null, who: { hostname: string | null; email: string | null }, now: number): SessionListRow {
  return {
    id: s.id,
    deviceId: s.device_id,
    hostname: who.hostname,
    email: who.email,
    startedAt: s.started_at,
    lastPulseAt: s.last_pulse_at,
    endedAt: s.ended_at,
    durationMs: durationOf(s),
    pulses: s.pulses,
    asks: s.asks,
    recaps: s.recaps,
    country: s.country,
    city: safeCity(s),
    os: s.os,
    appVersion: s.app_version,
    tier,
    live: isLive(s, now)
  }
}

export function registerSessionsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/sessions.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const query = parseSessionsQuery(ctx.url, ctx.now)
      const [page, tiers] = await Promise.all([
        ctx.store.listSessions({ since: query.since, until: query.until, deviceId: query.deviceId, cursor: query.cursor, limit: query.limit }),
        ctx.store.listTiers()
      ])
      const getSeat = seatCache(ctx.store)
      const rows: SessionListRow[] = []
      for (const s of page.rows) {
        const seat = await getSeat(s.device_id)
        const who = profileOf(seat)
        if (!sessionMatchesFilter(s, query.filter, who)) continue
        const { tier } = seat ? await resolveTierAndEntitlements(ctx.store, seat, ctx.now, tiers) : { tier: null }
        rows.push(toSessionRow(s, tier, who, ctx.now))
      }
      return json({ ok: true, rows, nextCursor: page.nextCursor, range: { since: query.since, until: query.until } })
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: /^\/v1\/admin\/sessions\/(?<id>[^/]+)\.json$/,
    auth: 'admin',
    handler: async (_request, ctx, match: RouteMatch) => sessionDetail(ctx, decodeURIComponent(match.params.id ?? ''))
  })
}

async function sessionDetail(ctx: AdminCtx, id: string): Promise<Response> {
  const detail = await ctx.store.getSession(id)
  if (!detail) return json({ ok: false, error: 'not found' }, 404)
  const { session, pulses } = detail
  const end = session.ended_at ?? session.last_pulse_at
  const [tiers, seat, eventsPage, asksAll] = await Promise.all([
    ctx.store.listTiers(),
    ctx.store.getSeat(session.device_id),
    ctx.store.listEvents(200, { deviceId: session.device_id, since: session.started_at, until: end, limit: 200 }),
    ctx.store.listAsks(500, session.started_at)
  ])
  const who = profileOf(seat)
  const { tier } = seat ? await resolveTierAndEntitlements(ctx.store, seat, ctx.now, tiers) : { tier: null }

  const events = eventsPage.rows.map(projectEventTelemetry).map((e) => ({
    id: e.id,
    ts: e.ts,
    kind: e.kind,
    actor: e.actor,
    country: e.country,
    detail: e.detail
  }))
  // asks are never shown with prompt text or ciphertext: no `preview`, `prompt_cipher` or `prompt_iv`.
  const asks = asksAll
    .filter((a) => a.device_id === session.device_id && a.ts <= end)
    .map(projectAskTelemetry)
    .map((a) => ({
      id: a.id,
      ts: a.ts,
      mode: a.mode,
      skillId: a.skill_id,
      provider: a.provider,
      model: a.model,
      outcome: a.outcome,
      rating: a.rating,
      cacheStatus: a.cache_status,
      questionType: a.question_type
    }))

  const row = toSessionRow(session, tier, who, ctx.now)
  return json({ ok: true, session: row, pulses: pulses.map((p) => ({ id: p.id, ts: p.ts, kind: p.kind })), events, asks })
}
