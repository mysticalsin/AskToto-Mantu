/**
 * Triage queue backend (plan 6.7 block 0 "Needs your review", task B11): `GET
 * /v1/admin/review-queue.json` returns pending approvals and licenses expiring within 7 days in one
 * payload, each row carrying the exact route its action buttons should call so the page needs no
 * lookup (Approve/Revoke reuse the existing seat/license routes in `admin-core.ts`, never
 * duplicated here; Renew/Let it expire are the two new routes this module registers, delegating to
 * `../licenses/renew.ts`).
 */
import { json } from '../http'
import { ONLINE_MS } from '../dashboard'
import { approvalOf, isRealSeat, issuedLicenseActive } from '../fleet'
import { resolveTierAndEntitlements } from '../tiers'
import { declineLicenseRenewal, renewLicense } from '../licenses/renew'
import { defineRoute } from './registry'
import { param, type AdminCtx } from './admin-ctx'
import { profileOf, safeCity } from './seat-view'
import type { IssuedLicenseRow, SeatRow } from '../store'

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRING_WITHIN_MS = 7 * DAY_MS
const LIST_CAP = 200
/** Bounded recent-asks scan for the "asks 24h" column, same limit `insights.ts` uses for a
 *  since-bounded read: generous for a real fleet, never unbounded. */
const ASKS_SCAN_LIMIT = 5000

export interface PendingRow {
  deviceId: string
  deviceShortId: string
  hostname: string | null
  email: string | null
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
  tier: string | null
  firstSeen: number
  lastSeen: number
  live: boolean
  asks24h: number
  actions: { approve: string; revoke: string }
}

export interface ExpiringRow {
  jti: string
  last4: string
  tier: string | null
  groupId: string | null
  groupName: string | null
  member: string | null
  activatedDevice: string | null
  activatedSeat: { hostname: string | null; email: string | null } | null
  exp: number
  daysLeft: number
  actions: { renew: string; expire: string }
}

export function registerReviewQueueRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/review-queue.json',
    auth: 'admin',
    handler: async (_request, ctx) => reviewQueue(ctx)
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/licenses\/(?<jti>[^/]+)\/renew$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const result = await renewLicense(ctx, param(match, 'jti'), body.days)
      if (!result.ok) return json({ ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status)
      return json({ ok: true, license: result.license })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/licenses\/(?<jti>[^/]+)\/expire$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const result = await declineLicenseRenewal(ctx, param(match, 'jti'))
      if (!result.ok) return json({ ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status)
      return json({ ok: true, license: result.license })
    }
  })
}

async function reviewQueue(ctx: AdminCtx) {
  const [seats, allIssued, groups, tiers] = await Promise.all([
    ctx.store.listSeats(),
    ctx.store.listIssuedLicenses(),
    ctx.store.listGroups(),
    ctx.store.listTiers()
  ])
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]))
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))

  // Pending: oldest-waiting first, so the queue clears in the order seats actually arrived.
  const pendingSeats = seats.filter((s) => isRealSeat(s) && approvalOf(s) === 'pending').sort((a, b) => a.first_seen - b.first_seen)

  const asksSince = ctx.now - DAY_MS
  const recentAsks = pendingSeats.length ? await ctx.store.listAsks(ASKS_SCAN_LIMIT, asksSince) : []
  const asks24hByDevice = new Map<string, number>()
  for (const a of recentAsks) {
    if (a.ts < asksSince) continue
    asks24hByDevice.set(a.device_id, (asks24hByDevice.get(a.device_id) ?? 0) + 1)
  }

  const pendingAll: PendingRow[] = []
  for (const seat of pendingSeats) {
    const who = profileOf(seat)
    const { tier } = await resolveTierAndEntitlements(ctx.store, seat, ctx.now, tiers)
    pendingAll.push({
      deviceId: seat.device_id,
      deviceShortId: seat.device_id.slice(0, 8),
      hostname: who.hostname,
      email: who.email,
      country: seat.country,
      city: safeCity(seat),
      os: seat.os || null,
      appVersion: seat.app_version || null,
      tier,
      firstSeen: seat.first_seen,
      lastSeen: seat.last_seen,
      live: ctx.now - seat.last_seen < ONLINE_MS,
      asks24h: asks24hByDevice.get(seat.device_id) ?? 0,
      actions: {
        approve: `/v1/admin/licenses/${encodeURIComponent(seat.device_id)}/approve`,
        revoke: `/v1/admin/licenses/${encodeURIComponent(seat.device_id)}/revoke`
      }
    })
  }

  // Expiring: soonest first, active licenses only (a revoked or already-expired one is neither
  // "active" nor useful to renew from the queue).
  const expiringAll: ExpiringRow[] = allIssued
    .filter((l) => issuedLicenseActive(l, ctx.now) && l.exp * 1000 - ctx.now <= EXPIRING_WITHIN_MS)
    .sort((a, b) => a.exp - b.exp)
    .map((l) => expiringRowOf(l, ctx.now, groupNameById, seatsById))

  const pending = pendingAll.slice(0, LIST_CAP)
  const expiring = expiringAll.slice(0, LIST_CAP)

  return json({
    ok: true,
    pending,
    expiring,
    counts: { pending: pendingAll.length, expiring: expiringAll.length, total: pendingAll.length + expiringAll.length },
    truncated: { pending: pendingAll.length > LIST_CAP, expiring: expiringAll.length > LIST_CAP }
  })
}

function expiringRowOf(l: IssuedLicenseRow, now: number, groupNameById: Map<string, string>, seatsById: Map<string, SeatRow>): ExpiringRow {
  const activatedSeat = l.activated_device ? seatsById.get(l.activated_device) : undefined
  return {
    jti: l.jti,
    last4: l.last4,
    tier: l.tier ?? null,
    groupId: l.group_id ?? null,
    groupName: l.group_id ? (groupNameById.get(l.group_id) ?? null) : null,
    member: l.member ?? null,
    activatedDevice: l.activated_device ?? null,
    activatedSeat: activatedSeat ? profileOf(activatedSeat) : null,
    exp: l.exp,
    daysLeft: Math.max(0, Math.ceil((l.exp * 1000 - now) / DAY_MS)),
    actions: {
      renew: `/v1/admin/licenses/${encodeURIComponent(l.jti)}/renew`,
      expire: `/v1/admin/licenses/${encodeURIComponent(l.jti)}/expire`
    }
  }
}
