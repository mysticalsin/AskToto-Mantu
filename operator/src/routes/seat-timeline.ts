/**
 * B4: `GET /v1/admin/seats/:id/timeline.json`, a merged, newest-first, cursor-paginated view of
 * everything the Operator has recorded for one device: heartbeats, asks (never prompt text),
 * events, CRM sends, and the connectors it holds a grant for, plus the device's current license
 * state and group (section 6.5 "Session drawer": seat link, group link, license state, connectors
 * this seat received).
 *
 * None of the five sources the store exposes are device-filtered and windowed the same way (only
 * `listEvents` takes a `deviceId`); this route reads a bounded recent window per source and
 * filters/joins in memory, the same pattern `routes/sessions.ts`'s `sessionDetail` and
 * `routes/groups.ts`'s `groupActivity` already use for filters outside a store method's own
 * contract. Group resolution reuses `routes/groups.ts`'s exported `resolveSeatToGroup` (the
 * license-priority-then-membership logic already audited there) rather than a second, possibly
 * divergent implementation.
 *
 * Gateway calls (MCP `tools/call` audit, plan section 7 task B3) have not landed: no store table
 * or method exists for them yet. The response always carries an empty contribution to `rows` for
 * that kind and `gatewayCallsAvailable: false`, so the drawer can say plainly "not available yet"
 * instead of pretending the section is simply empty (plan lock 3: no fake data, name the reason).
 */
import { json } from '../http'
import { approvalOf, isApprovedSeat, parseLicenseId, type SeatApproval } from '../fleet'
import { resolveTierAndEntitlements } from '../tiers'
import { resolveSeatToGroup } from './groups'
import type { AdminCtx } from './admin-ctx'
import { param } from './admin-ctx'
import { defineRoute, type RouteMatch } from './registry'
import { profileOf, safeCity } from './seat-view'

const DAY_MS = 24 * 60 * 60 * 1000
const RANGE_PRESET_MS: Record<string, number> = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS }
const DEFAULT_WINDOW_MS = RANGE_PRESET_MS['30d']
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 300

export interface SeatTimelineWindow {
  since: number
  until: number
}

export function resolveTimelineWindow(params: URLSearchParams, now: number): SeatTimelineWindow {
  const range = params.get('range')
  if (range && RANGE_PRESET_MS[range] != null) return { since: now - RANGE_PRESET_MS[range], until: now }
  const rawSince = params.get('since')
  const rawUntil = params.get('until')
  const since = rawSince != null && rawSince !== '' && Number.isFinite(Number(rawSince)) ? Number(rawSince) : undefined
  const until = rawUntil != null && rawUntil !== '' && Number.isFinite(Number(rawUntil)) ? Number(rawUntil) : undefined
  if (since == null && until == null) return { since: now - DEFAULT_WINDOW_MS, until: now }
  return { since: since ?? now - DEFAULT_WINDOW_MS, until: until ?? now }
}

export function parseTimelineLimit(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || raw == null || raw === '') return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)))
}

// Workers-safe base64url, mirroring store.ts's private cursor codec (kept local: that one is not
// exported, and this is five lines, not a dependency worth creating).
function toB64Url(raw: string): string {
  const bytes = new TextEncoder().encode(raw)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (padded.length % 4)) % 4
  const bin = atob(padded + '='.repeat(pad))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
export function encodeTimelineCursor(ts: number, id: string): string {
  return toB64Url(`${ts}:${id}`)
}
function decodeTimelineCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null
  try {
    const raw = fromB64Url(cursor)
    const i = raw.lastIndexOf(':')
    if (i < 0) return null
    const ts = Number(raw.slice(0, i))
    const id = raw.slice(i + 1)
    if (!Number.isFinite(ts) || !id) return null
    return { ts, id }
  } catch {
    return null
  }
}

export type SeatTimelineKind = 'heartbeat' | 'ask' | 'event' | 'crm' | 'grant'

export interface SeatTimelineRow {
  id: string
  ts: number
  kind: SeatTimelineKind
  // ask (never prompt_cipher, prompt_iv or preview)
  mode?: string | null
  questionType?: string | null
  provider?: string | null
  model?: string | null
  outcome?: string | null
  rating?: string | null
  cacheStatus?: string | null
  // event
  eventKind?: string
  detail?: string | null
  // crm
  status?: string
  title?: string
  connector?: string
  // grant
  integrationId?: string
  connectorKind?: string
  connectorLabel?: string
  connectorStatus?: string
}

export type SeatLicenseState = 'approved' | 'licensed' | 'expired' | 'revoked' | 'pending' | 'unknown'

/** Mirrors `routes/groups.ts`'s private `licenseStateOf` (same five-state classification); kept
 *  local because that one is not exported and the logic is a short, already-proven classifier,
 *  not something worth a cross-module dependency for. */
function seatLicenseState(
  seat: { approval?: string | null; license?: string | null; license_jti?: string | null } | null,
  issued: { revoked: number; exp: number } | null,
  now: number
): SeatLicenseState {
  if (!seat) return 'unknown'
  if ((seat.approval || '').trim().toLowerCase() === 'revoked') return 'revoked'
  if (isApprovedSeat(seat)) return 'approved'
  if (issued) {
    if (issued.revoked) return 'revoked'
    if (issued.exp * 1000 <= now) return 'expired'
    return 'licensed'
  }
  return 'pending'
}

export function registerSeatTimelineRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: /^\/v1\/admin\/seats\/(?<id>[^/]+)\/timeline\.json$/,
    auth: 'admin',
    handler: async (_request, ctx, match: RouteMatch) => seatTimeline(ctx, param(match, 'id'))
  })
}

async function seatTimeline(ctx: AdminCtx, deviceId: string) {
  const seat = await ctx.store.getSeat(deviceId)
  if (!seat) return json({ ok: false, error: 'seat not found' }, 404)

  const { since, until } = resolveTimelineWindow(ctx.url.searchParams, ctx.now)
  const limit = parseTimelineLimit(ctx.url.searchParams.get('limit'))
  const cursor = decodeTimelineCursor(ctx.url.searchParams.get('cursor')?.trim() || undefined)

  const [pulses, asksAll, eventsPage, crmAll, integrations, groups, allIssued] = await Promise.all([
    ctx.store.listPulses(since),
    ctx.store.listAsks(1000, since),
    ctx.store.listEvents(500, { deviceId, since, until, limit: 500 }),
    ctx.store.listCrm(1000),
    ctx.store.listIntegrationRows(),
    ctx.store.listGroups(),
    ctx.store.listIssuedLicenses()
  ])

  const rows: SeatTimelineRow[] = []

  for (const p of pulses) {
    if (p.device_id !== deviceId || p.kind !== 'heartbeat' || p.ts > until) continue
    rows.push({ id: p.id, ts: p.ts, kind: 'heartbeat' })
  }

  for (const a of asksAll) {
    if (a.device_id !== deviceId || a.ts > until) continue
    rows.push({
      id: a.id,
      ts: a.ts,
      kind: 'ask',
      mode: a.mode,
      questionType: a.question_type,
      provider: a.provider,
      model: a.model,
      outcome: a.outcome,
      rating: a.rating,
      cacheStatus: a.cache_status
    })
  }

  for (const e of eventsPage.rows) {
    rows.push({ id: e.id, ts: e.ts, kind: 'event', eventKind: e.kind, detail: e.detail })
  }

  for (const c of crmAll) {
    if (c.device_id !== deviceId || c.ts < since || c.ts > until) continue
    rows.push({ id: c.id, ts: c.ts, kind: 'crm', status: c.status, title: c.title, connector: c.connector })
  }

  const grantLists = await Promise.all(integrations.map((i) => ctx.store.listIntegrationGrants(i.id, 200)))
  grantLists.forEach((grants, i) => {
    const integration = integrations[i]
    for (const g of grants) {
      if (g.device_id !== deviceId || g.ts < since || g.ts > until) continue
      rows.push({
        id: g.id,
        ts: g.ts,
        kind: 'grant',
        integrationId: integration.id,
        connectorKind: integration.kind,
        connectorLabel: integration.label,
        connectorStatus: integration.status
      })
    }
  })

  rows.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
  let page = rows
  if (cursor) page = page.filter((r) => r.ts < cursor.ts || (r.ts === cursor.ts && r.id < cursor.id))
  page = page.slice(0, limit)
  const last = page.at(-1)
  const nextCursor = page.length === limit && last ? encodeTimelineCursor(last.ts, last.id) : null

  const who = profileOf(seat)
  const jti = parseLicenseId(seat.license_jti)
  const issued = jti ? (allIssued.find((l) => l.jti === jti) ?? null) : null
  const { tier } = await resolveTierAndEntitlements(ctx.store, seat, ctx.now)

  let group: { id: string; name: string } | null = null
  if (groups.length) {
    const membersByGroup = await Promise.all(groups.map((g) => ctx.store.listGroupMembers(g.id)))
    const allMembers = membersByGroup.flat()
    const issuedByJti = new Map(allIssued.map((l) => [l.jti, l]))
    const groupTierById = new Map(groups.map((g) => [g.id, g.tier]))
    const resolved = resolveSeatToGroup(seat, issuedByJti, allMembers, groupTierById, ctx.now)
    if (resolved) {
      const g = groups.find((x) => x.id === resolved.groupId)
      if (g) group = { id: g.id, name: g.name }
    }
  }

  return json({
    ok: true,
    deviceId,
    seat: { hostname: who.hostname, email: who.email, os: seat.os, appVersion: seat.app_version, country: seat.country, city: safeCity(seat) },
    approval: approvalOf(seat) as SeatApproval,
    tier,
    licenseState: seatLicenseState(seat, issued, ctx.now),
    group,
    rows: page,
    nextCursor,
    gatewayCallsAvailable: false
  })
}
