/**
 * `GET /v1/admin/events.json` (plan section 9c "Events"): validated, paginated, kind-filterable
 * event rows shaped for the console table, with per-kind counts for the resolved range. Filtering by
 * `os`/`version`/`country`/`q`/`device`/`kinds` happens inside `OperatorStore#listEvents`'s bounded
 * query; this module only validates query params, resolves range presets, and joins the seat fields
 * the UI needs (hostname, email, os, appVersion), one `getSeat` per distinct device in the page.
 */
import { json } from '../http'
import { looksLikeSecret } from '../redact'
import { projectEventTelemetry } from '../privacy'
import type { EventsQueryOpts } from '../store'
import { defineRoute } from './registry'
import type { AdminCtx } from './admin-ctx'
import { profileOf, safeCity, seatCache } from './seat-view'

export const KNOWN_EVENT_KINDS = [
  'heartbeat',
  'ask',
  'recap',
  'listen',
  'rating',
  'crm',
  'vault',
  'license',
  'seat',
  'use',
  'platform'
] as const

const RANGE_PRESET_MS: Record<string, number> = {
  '30m': 30 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

const DEFAULT_RANGE_MS = RANGE_PRESET_MS['24h']
const DEFAULT_LIMIT = 50
const MIN_LIMIT = 1
const MAX_LIMIT = 200

export function parseLimit(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || raw == null || raw === '') return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(n)))
}

export function parseEpoch(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function parseKinds(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const known = new Set<string>(KNOWN_EVENT_KINDS)
  const kinds = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => known.has(k))
  return kinds.length ? kinds : undefined
}

export interface ResolvedRange {
  since: number
  until: number
}

/** `range=30m|24h|7d|30d` resolves server-side to `{ since: now - window, until: now }` and takes
 *  precedence over explicit `since`/`until`. With no `range` and no explicit bounds, defaults to the
 *  last 24 h (the console's default filter). */
export function resolveRange(params: URLSearchParams, now: number): ResolvedRange {
  const range = params.get('range')
  if (range && RANGE_PRESET_MS[range] != null) {
    return { since: now - RANGE_PRESET_MS[range], until: now }
  }
  const since = parseEpoch(params.get('since'))
  const until = parseEpoch(params.get('until'))
  if (since == null && until == null) return { since: now - DEFAULT_RANGE_MS, until: now }
  return { since: since ?? now - DEFAULT_RANGE_MS, until: until ?? now }
}

export function parseEventsQuery(url: URL, now: number): EventsQueryOpts & ResolvedRange {
  const params = url.searchParams
  const { since, until } = resolveRange(params, now)
  return {
    since,
    until,
    kinds: parseKinds(params.get('kinds')),
    deviceId: params.get('device')?.trim() || undefined,
    country: params.get('country')?.trim() || undefined,
    os: params.get('os')?.trim() || undefined,
    version: params.get('version')?.trim() || undefined,
    q: params.get('q')?.trim() || undefined,
    cursor: params.get('cursor')?.trim() || undefined,
    limit: parseLimit(params.get('limit'))
  }
}

export interface EventListRow {
  id: string
  ts: number
  kind: string
  actor: string | null
  deviceId: string | null
  hostname: string | null
  email: string | null
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
  detail: string | null
}

export function registerEventsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/events.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const query = parseEventsQuery(ctx.url, ctx.now)
      const [page, counts] = await Promise.all([
        ctx.store.listEvents(query.limit ?? DEFAULT_LIMIT, query),
        ctx.store.countEventsByKind(query.since, query.until)
      ])
      const getSeat = seatCache(ctx.store)
      const rows: EventListRow[] = await Promise.all(
        page.rows.map(async (stored) => {
          const e = projectEventTelemetry(stored)
          const seat = e.device_id ? await getSeat(e.device_id) : null
          const who = profileOf(seat)
          return {
            id: e.id,
            ts: e.ts,
            kind: e.kind,
            actor: who.email || (e.actor && !looksLikeSecret(e.actor) ? e.actor : null),
            deviceId: e.device_id,
            hostname: who.hostname,
            email: who.email,
            country: e.country || seat?.country || null,
            city: safeCity(seat),
            os: seat?.os || null,
            appVersion: seat?.app_version || null,
            detail: e.detail
          }
        })
      )
      return json({ ok: true, rows, nextCursor: page.nextCursor, counts, range: { since: query.since, until: query.until } })
    }
  })
}
