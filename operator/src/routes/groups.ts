/**
 * Groups and tiers admin routes (plan section 6.6/6.7, B1, prior brief P1.10, prior plan section 9c
 * "Groups"): `GET/POST /v1/admin/groups`, `GET/PATCH/DELETE /v1/admin/groups/:id`,
 * `POST/DELETE /v1/admin/groups/:id/members[/:member]`, `POST
 * /v1/admin/groups/:id/licenses/generate` (delegates to `../licenses/generate`), `GET/PATCH
 * /v1/admin/tiers[/:id]`. The `groups`, `group_members`, `tiers` and `issued_licenses` tables and
 * every store method this module needs already exist (`operator/src/store.ts`,
 * `operator/src/d1.ts`); nothing here touches either file.
 *
 * A seat resolves to a group two ways (plan 9c "Groups"): through an active Operator-issued license
 * that carries a `group_id` (the pure math lives in `../groups-resolve.ts`), or by a
 * `group_members` row matching its SSO email or device id. License-based resolution wins when both
 * would apply.
 */
import { json } from '../http'
import { ONLINE_MS } from '../dashboard'
import {
  defaultTiers,
  type GroupMemberKind,
  type GroupMemberRow,
  type GroupRow,
  type IssuedLicenseRow,
  type OperatorStore,
  type SeatRow,
  type TierRow
} from '../store'
import { isApprovedSeat, isRealSeat, issuedLicenseActive, parseLicenseId } from '../fleet'
import { DEFAULT_TIER, resolveSeatGroup } from '../groups-resolve'
import { resolveTierAndEntitlements } from '../tiers'
import { mintOperatorLicense } from '../licenses/generate'
import { OPERATOR_ENTITLEMENT_KEYS } from '../../../src/shared/operator-entitlements'
import { defineRoute } from './registry'
import { auditLog, param, safeAuditText, type AdminCtx } from './admin-ctx'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function describeRaw(raw: unknown): string {
  if (raw === undefined) return 'undefined'
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/** Unicode-aware case-insensitive compare for the group-name uniqueness check: NFKC first so
 *  visually/semantically equivalent forms (full-width letters, compatibility ligatures) collapse to
 *  the same string before the case fold, not just a plain `.toLowerCase()`. */
function normalizeForCompare(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────

function validateGroupName(
  raw: unknown,
  existing: GroupRow[],
  excludeId?: string
): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length < 2 || name.length > 60) {
    return {
      ok: false,
      error: `name must be 2 to 60 characters, received ${describeRaw(raw)} (${name.length} character${
        name.length === 1 ? '' : 's'
      })`
    }
  }
  const dup = existing.find((g) => g.id !== excludeId && normalizeForCompare(g.name.trim()) === normalizeForCompare(name))
  if (dup) {
    return {
      ok: false,
      error: `name must be unique, ${describeRaw(name)} is already used by group "${dup.name}", choose a different name, for example "${name} 2"`
    }
  }
  return { ok: true, name }
}

function validateTierId(raw: unknown, tiers: TierRow[]): { ok: true; tier: string } | { ok: false; error: string } {
  const tier = typeof raw === 'string' ? raw.trim() : ''
  const known = tiers.map((t) => t.id)
  if (!tier || !known.includes(tier)) {
    return {
      ok: false,
      error: `tier must be one of ${known.join(', ') || 'no tiers exist yet'}, received ${describeRaw(raw)}, for example "${known[0] ?? 'metis'}"`
    }
  }
  return { ok: true, tier }
}

function normalizeNotes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().slice(0, 500)
  return trimmed || null
}

async function validateMemberInput(
  store: Pick<OperatorStore, 'getSeat'>,
  rawMember: unknown,
  rawKind: unknown
): Promise<{ ok: true; member: string; kind: GroupMemberKind } | { ok: false; error: string }> {
  const kind = rawKind === 'email' || rawKind === 'device' ? rawKind : null
  if (!kind) {
    return {
      ok: false,
      error: `kind must be "email" or "device", received ${describeRaw(rawKind)}, for example "email"`
    }
  }
  const memberRaw = typeof rawMember === 'string' ? rawMember.trim() : ''
  if (!memberRaw) {
    return {
      ok: false,
      error: `member is required, received ${describeRaw(rawMember)}, expected an email address or a device id, for example "name@example.com"`
    }
  }
  if (kind === 'email') {
    if (!EMAIL_RE.test(memberRaw)) {
      return {
        ok: false,
        error: `member must be a valid email address when kind is "email", received ${describeRaw(memberRaw)}, expected format "name@domain.tld", for example "member@example.com"`
      }
    }
    return { ok: true, member: memberRaw.toLowerCase(), kind }
  }
  const seat = await store.getSeat(memberRaw)
  if (!seat) {
    return {
      ok: false,
      error: `member must be an existing seat device id when kind is "device", received ${describeRaw(memberRaw)}, no seat with that device id has checked in, for example a device id copied from the Sessions page`
    }
  }
  return { ok: true, member: memberRaw, kind }
}

/** `member` on the license-generate routes is free text with no `kind` alongside it (unlike the
 *  members route): auto-detect email vs. device id the same way, an empty/absent value meaning "no
 *  member", and reject anything that is neither a valid email nor a device id an actual seat holds. */
async function validateLicenseMember(
  store: Pick<OperatorStore, 'getSeat'>,
  raw: unknown
): Promise<{ ok: true; member: string | null } | { ok: false; error: string }> {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { ok: true, member: null }
  if (EMAIL_RE.test(trimmed)) return { ok: true, member: trimmed.toLowerCase() }
  const seat = await store.getSeat(trimmed)
  if (seat) return { ok: true, member: trimmed }
  return {
    ok: false,
    error: `member must be a valid email address or an existing seat device id, received ${describeRaw(raw)}, no seat with that device id has checked in, for example "name@example.com" or a device id copied from the Sessions page`
  }
}

function parseEntitlements(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

// ── ids and seeding ──────────────────────────────────────────────────────────────────────────────

function newGroupId(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'group'
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6)
  return `${slug}-${suffix}`
}

/** Seeds `metis` and `metis-light` from `DEFAULT_TIER_ENTITLEMENTS` the first time the `tiers`
 *  table is read empty, audited once as `tiers-seeded`. A no-op on every later call. */
async function ensureTiersSeeded(ctx: AdminCtx): Promise<TierRow[]> {
  const existing = await ctx.store.listTiers()
  if (existing.length) return existing
  const seeded = defaultTiers(ctx.now)
  for (const tier of seeded) await ctx.store.putTier(tier)
  await auditLog(ctx, 'tiers-seeded', null, seeded.map((t) => t.id).join(', '))
  return seeded
}

// ── seat resolution ──────────────────────────────────────────────────────────────────────────────

export interface GroupSeatResolution {
  groupId: string
  tier: string
}

/** License-based resolution (an active Operator-issued license carrying a `group_id`) wins; a
 *  `group_members` email or device match is the fallback, in that order (prior plan 9c "Groups"). */
export function resolveSeatToGroup(
  seat: Pick<SeatRow, 'device_id' | 'license_jti' | 'sso_email'>,
  issuedByJti: Map<string, IssuedLicenseRow>,
  members: GroupMemberRow[],
  groupTierById: Map<string, string>,
  now: number
): GroupSeatResolution | null {
  const jti = parseLicenseId(seat.license_jti)
  if (jti) {
    const issued = issuedByJti.get(jti) ?? null
    const resolved = resolveSeatGroup(seat, issued, now)
    if (resolved) return resolved
  }
  const email = (seat.sso_email || '').trim().toLowerCase()
  const emailMember = email ? members.find((m) => m.kind === 'email' && m.member.trim().toLowerCase() === email) : undefined
  const matched = emailMember ?? members.find((m) => m.kind === 'device' && m.member === seat.device_id)
  if (!matched) return null
  return { groupId: matched.group_id, tier: groupTierById.get(matched.group_id) ?? DEFAULT_TIER }
}

function licenseStateOf(seat: Pick<SeatRow, 'approval' | 'license'>, issued: IssuedLicenseRow | null, now: number): string {
  if ((seat.approval || '').trim().toLowerCase() === 'revoked') return 'revoked'
  if (isApprovedSeat(seat)) return 'approved'
  if (issued) {
    if (issued.revoked) return 'revoked'
    if (issued.exp * 1000 <= now) return 'expired'
    return 'licensed'
  }
  return 'pending'
}

/** Last 50 audit rows whose detail mentions this group's id or name. `listAudit` has no free-text
 *  filter, so this reads a bounded recent window and filters in memory, the same pattern
 *  `sessions.ts`/`events.ts` use for filters outside the store's own query contract. */
async function groupActivity(store: Pick<OperatorStore, 'listAudit'>, groupId: string, groupName: string) {
  const rows = await store.listAudit(500)
  const needleId = groupId.toLowerCase()
  const needleName = groupName.trim().toLowerCase()
  return rows
    .filter((r) => {
      const detail = (r.detail || '').toLowerCase()
      return detail.includes(needleId) || (needleName.length > 0 && detail.includes(needleName))
    })
    .slice(0, 50)
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────

export function registerGroupsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/groups',
    auth: 'admin',
    handler: async (_request, ctx) => {
      await ensureTiersSeeded(ctx)
      const groups = await ctx.store.listGroups()
      if (!groups.length) return json({ ok: true, groups: [] })

      const [seats, allIssued, membersByGroup] = await Promise.all([
        ctx.store.listSeats(),
        ctx.store.listIssuedLicenses(),
        Promise.all(groups.map((g) => ctx.store.listGroupMembers(g.id)))
      ])
      const issuedByJti = new Map(allIssued.map((l) => [l.jti, l]))
      const allMembers = membersByGroup.flat()
      const groupTierById = new Map(groups.map((g) => [g.id, g.tier]))

      const licenseAgg = new Map<string, { issued: number; active: number }>()
      for (const lic of allIssued) {
        if (!lic.group_id) continue
        const agg = licenseAgg.get(lic.group_id) ?? { issued: 0, active: 0 }
        agg.issued += 1
        if (issuedLicenseActive(lic, ctx.now)) agg.active += 1
        licenseAgg.set(lic.group_id, agg)
      }

      const liveByGroup = new Map<string, number>()
      const lastActiveByGroup = new Map<string, number>()
      for (const seat of seats) {
        if (!isRealSeat(seat)) continue
        const resolved = resolveSeatToGroup(seat, issuedByJti, allMembers, groupTierById, ctx.now)
        if (!resolved) continue
        if (ctx.now - seat.last_seen < ONLINE_MS) {
          liveByGroup.set(resolved.groupId, (liveByGroup.get(resolved.groupId) ?? 0) + 1)
        }
        const prev = lastActiveByGroup.get(resolved.groupId) ?? 0
        if (seat.last_seen > prev) lastActiveByGroup.set(resolved.groupId, seat.last_seen)
      }

      const rows = groups.map((g, i) => {
        const agg = licenseAgg.get(g.id) ?? { issued: 0, active: 0 }
        return {
          id: g.id,
          name: g.name,
          tier: g.tier,
          notes: g.notes,
          createdAt: g.created_at,
          createdBy: g.created_by,
          members: membersByGroup[i]?.length ?? 0,
          licensesIssued: agg.issued,
          licensesActive: agg.active,
          seatsLive: liveByGroup.get(g.id) ?? 0,
          lastActiveAt: lastActiveByGroup.get(g.id) ?? null
        }
      })
      return json({ ok: true, groups: rows })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/groups',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const existing = await ctx.store.listGroups()
      const nameResult = validateGroupName(body.name, existing)
      if (!nameResult.ok) return json({ ok: false, error: nameResult.error }, 400)
      const tiers = await ensureTiersSeeded(ctx)
      const tierResult = validateTierId(body.tier, tiers)
      if (!tierResult.ok) return json({ ok: false, error: tierResult.error }, 400)
      const notes = normalizeNotes(body.notes)
      const id = newGroupId(nameResult.name)
      const row: GroupRow = { id, name: nameResult.name, tier: tierResult.tier, notes, created_at: ctx.now, created_by: ctx.email }
      await ctx.store.putGroup(row)
      await auditLog(ctx, 'group-create', null, `${id} "${safeAuditText(row.name)}" tier ${row.tier}`)
      return json({ ok: true, group: row })
    }
  })

  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: /^\/v1\/admin\/groups\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const id = param(match, 'id')
      const group = await ctx.store.getGroup(id)
      if (!group) return json({ ok: false, error: 'not found' }, 404)

      const [members, allIssued, seats] = await Promise.all([
        ctx.store.listGroupMembers(id),
        ctx.store.listIssuedLicenses(),
        ctx.store.listSeats()
      ])
      const issuedByJti = new Map(allIssued.map((l) => [l.jti, l]))
      const groupTierById = new Map([[group.id, group.tier]])

      const licenses = allIssued
        .filter((l) => l.group_id === id)
        .sort((a, b) => b.created_at - a.created_at)
        .map((l) => ({
          jti: l.jti,
          last4: l.last4,
          tier: l.tier,
          member: l.member ?? null,
          days: l.days,
          exp: l.exp,
          revoked: Boolean(l.revoked),
          activatedDevice: l.activated_device ?? null,
          activatedAt: l.activated_at ?? null,
          createdAt: l.created_at,
          createdBy: l.created_by
        }))

      const seatRows = []
      for (const seat of seats) {
        if (!isRealSeat(seat)) continue
        const resolved = resolveSeatToGroup(seat, issuedByJti, members, groupTierById, ctx.now)
        if (!resolved || resolved.groupId !== id) continue
        const jti = parseLicenseId(seat.license_jti)
        const issued = jti ? issuedByJti.get(jti) ?? null : null
        seatRows.push({
          deviceId: seat.device_id,
          deviceShortId: seat.device_id.slice(0, 8),
          hostname: seat.hostname,
          email: seat.sso_email,
          live: ctx.now - seat.last_seen < ONLINE_MS,
          licenseState: licenseStateOf(seat, issued, ctx.now)
        })
      }

      const activity = await groupActivity(ctx.store, id, group.name)

      return json({
        ok: true,
        group: {
          id: group.id,
          name: group.name,
          tier: group.tier,
          notes: group.notes,
          createdAt: group.created_at,
          createdBy: group.created_by
        },
        members: members.map((m) => ({ member: m.member, kind: m.kind, addedAt: m.added_at, addedBy: m.added_by })),
        licenses,
        seats: seatRows,
        activity: activity.map((a) => ({
          ts: a.ts,
          actor: a.actor,
          action: a.action,
          detail: a.detail,
          requestId: a.request_id,
          route: a.route
        }))
      })
    }
  })

  defineRoute<AdminCtx>({
    method: 'PATCH',
    pattern: /^\/v1\/admin\/groups\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const id = param(match, 'id')
      const group = await ctx.store.getGroup(id)
      if (!group) return json({ ok: false, error: 'not found' }, 404)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

      let name = group.name
      let tier = group.tier
      let notes = group.notes
      const changes: string[] = []

      if (body.name !== undefined) {
        const existing = await ctx.store.listGroups()
        const result = validateGroupName(body.name, existing, id)
        if (!result.ok) return json({ ok: false, error: result.error }, 400)
        if (result.name !== group.name) changes.push(`name -> "${safeAuditText(result.name)}"`)
        name = result.name
      }
      if (body.tier !== undefined) {
        const tiers = await ensureTiersSeeded(ctx)
        const result = validateTierId(body.tier, tiers)
        if (!result.ok) return json({ ok: false, error: result.error }, 400)
        if (result.tier !== group.tier) changes.push(`tier -> ${result.tier}`)
        tier = result.tier
      }
      if (body.notes !== undefined) {
        const nextNotes = normalizeNotes(body.notes)
        if (nextNotes !== group.notes) changes.push('notes updated')
        notes = nextNotes
      }

      const updated: GroupRow = { ...group, name, tier, notes }
      await ctx.store.putGroup(updated)
      if (changes.length) await auditLog(ctx, 'group-update', null, `${id} ${changes.join(', ')}`)
      return json({
        ok: true,
        group: { id: updated.id, name: updated.name, tier: updated.tier, notes: updated.notes, createdAt: updated.created_at, createdBy: updated.created_by }
      })
    }
  })

  defineRoute<AdminCtx>({
    method: 'DELETE',
    pattern: /^\/v1\/admin\/groups\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const id = param(match, 'id')
      const group = await ctx.store.getGroup(id)
      if (!group) return json({ ok: false, error: 'not found' }, 404)
      const allIssued = await ctx.store.listIssuedLicenses()
      const active = allIssued.filter((l) => l.group_id === id && issuedLicenseActive(l, ctx.now))
      if (active.length) {
        return json(
          {
            ok: false,
            error: `This group has ${active.length} active license${active.length === 1 ? '' : 's'} issued to it, revoke ${
              active.length === 1 ? 'it' : 'them'
            } before deleting the group, for example from this group's Licenses tab`,
            code: 'has-active-licenses'
          },
          409
        )
      }
      await ctx.store.deleteGroup(id)
      await auditLog(ctx, 'group-delete', null, `${id} "${safeAuditText(group.name)}"`)
      return json({ ok: true, id })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/groups\/(?<id>[^/]+)\/members$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const id = param(match, 'id')
      const group = await ctx.store.getGroup(id)
      if (!group) return json({ ok: false, error: 'not found' }, 404)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const result = await validateMemberInput(ctx.store, body.member, body.kind)
      if (!result.ok) return json({ ok: false, error: result.error }, 400)
      await ctx.store.putGroupMember({ group_id: id, member: result.member, kind: result.kind, added_at: ctx.now, added_by: ctx.email })
      await auditLog(ctx, 'group-member-add', null, `${id} + ${safeAuditText(result.member)} (${result.kind})`)
      return json({ ok: true, member: result.member, kind: result.kind })
    }
  })

  defineRoute<AdminCtx>({
    method: 'DELETE',
    pattern: /^\/v1\/admin\/groups\/(?<id>[^/]+)\/members\/(?<member>[^/]+)$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const id = param(match, 'id')
      const memberParam = param(match, 'member')
      const group = await ctx.store.getGroup(id)
      if (!group) return json({ ok: false, error: 'not found' }, 404)
      const members = await ctx.store.listGroupMembers(id)
      const found = members.find((m) => m.member.toLowerCase() === memberParam.toLowerCase())
      if (!found) return json({ ok: false, error: 'member not found in this group' }, 404)
      await ctx.store.deleteGroupMember(id, found.member)
      await auditLog(ctx, 'group-member-remove', null, `${id} - ${safeAuditText(found.member)}`)
      return json({ ok: true, member: found.member })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/groups\/(?<id>[^/]+)\/licenses\/generate$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const id = param(match, 'id')
      const group = await ctx.store.getGroup(id)
      if (!group) return json({ ok: false, error: 'not found' }, 404)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

      let tier = group.tier
      if (body.tier !== undefined) {
        const tiers = await ensureTiersSeeded(ctx)
        const result = validateTierId(body.tier, tiers)
        if (!result.ok) return json({ ok: false, error: result.error }, 400)
        tier = result.tier
      }
      const memberResult = await validateLicenseMember(ctx.store, body.member)
      if (!memberResult.ok) return json({ ok: false, error: memberResult.error }, 400)
      const member = memberResult.member

      const minted = await mintOperatorLicense(ctx, {
        days: body.days,
        groupId: id,
        tier,
        member,
        actor: ctx.email,
        action: 'group-license-generate'
      })
      if (!minted.ok) return json({ ok: false, error: minted.error }, minted.status)
      return json({
        ok: true,
        license: minted.token,
        jti: minted.jti,
        last4: minted.last4,
        days: minted.days,
        iat: minted.iat,
        exp: minted.exp,
        groupId: minted.groupId,
        tier: minted.tier,
        member: minted.member
      })
    }
  })

  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/tiers',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const tiers = await ensureTiersSeeded(ctx)
      const seats = await ctx.store.listSeats()
      const seatCounts = new Map<string, number>()
      for (const seat of seats) {
        if (!isRealSeat(seat)) continue
        const { tier } = await resolveTierAndEntitlements(ctx.store, seat, ctx.now, tiers)
        if (!tier) continue
        seatCounts.set(tier, (seatCounts.get(tier) ?? 0) + 1)
      }
      const rows = tiers.map((t) => ({
        id: t.id,
        label: t.label,
        entitlements: parseEntitlements(t.entitlements_json),
        updatedAt: t.updated_at,
        seats: seatCounts.get(t.id) ?? 0
      }))
      return json({ ok: true, tiers: rows })
    }
  })

  defineRoute<AdminCtx>({
    method: 'PATCH',
    pattern: /^\/v1\/admin\/tiers\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const id = param(match, 'id')
      const tiers = await ensureTiersSeeded(ctx)
      const existing = tiers.find((t) => t.id === id)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

      if (!Array.isArray(body.entitlements)) {
        return json(
          {
            ok: false,
            error: `entitlements must be an array of strings, received ${describeRaw(body.entitlements)}, valid entitlements are ${OPERATOR_ENTITLEMENT_KEYS.join(', ')}, for example ["ask", "intelligence"]`
          },
          400
        )
      }
      const raw = body.entitlements as unknown[]
      const invalid = raw.filter((e) => typeof e !== 'string' || !(OPERATOR_ENTITLEMENT_KEYS as readonly string[]).includes(e))
      if (invalid.length) {
        return json(
          {
            ok: false,
            error: `entitlements must only contain known entitlement names, received ${describeRaw(invalid)}, valid entitlements are ${OPERATOR_ENTITLEMENT_KEYS.join(', ')}, for example "ask"`
          },
          400
        )
      }
      const entitlements = [...new Set(raw as string[])]
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : existing.label
      const before = parseEntitlements(existing.entitlements_json).join(', ') || 'none'
      const after = entitlements.join(', ') || 'none'
      const updated: TierRow = { id, label, entitlements_json: JSON.stringify(entitlements), updated_at: ctx.now }
      await ctx.store.putTier(updated)
      await auditLog(ctx, 'tier-update', null, `${id}: ${before} -> ${after}`)
      return json({ ok: true, tier: { id, label, entitlements, updatedAt: ctx.now } })
    }
  })
}
