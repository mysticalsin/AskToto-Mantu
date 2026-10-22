/**
 * Admin routes for zero-config enrolment (O03). All live under `/v1/admin/*`, so they inherit the console's
 * Access identity check, the CSRF gate and the 60/min admin mutation rate limit from `index.ts`. Reads are
 * for any admin; every mutation additionally needs an owner (`OWNER_EMAILS`), the same rule as the fleet
 * model policy, because a token or a pause switch changes who can report to the fleet.
 *
 *   GET  /v1/admin/enroll-tokens                 tokens (never the secret or its hash), settings, SSO status
 *   POST /v1/admin/enroll-tokens                 create; the token string is returned ONCE
 *   POST /v1/admin/enroll-tokens/:kid/revoke     revoke, optionally cascading to the licences it minted
 *   POST /v1/admin/settings/enroll               paused / ssoTier / ssoMaxDevicesPerUser
 */
import { isOwnerEmail } from '../access'
import { ssoConfigFromEnv } from '../entra-idtoken'
import { createEnrollToken, enrollTokenView, utcDayStart, workerChannel } from '../enroll/tokens'
import { knownTierIds, readEnrollSettings, validateEnrollSettingsPatch, writeEnrollSettings } from '../enroll/settings'
import { json } from '../http'
import { auditLog, safeAuditText, type AdminCtx } from './admin-ctx'
import { defineRoute } from './registry'

async function requireOwner(ctx: AdminCtx): Promise<Response | null> {
  if (isOwnerEmail(ctx.email, ctx.env)) return null
  await auditLog(ctx, 'enroll-admin.denied', null, safeAuditText(`${ctx.email} is not an owner`))
  return json({ ok: false, error: 'Only the owner may change enrolment.', code: 'not-owner' }, 403)
}

/** Whether SSO enrolment is configured, without ever echoing a configured value (tenant: last 4 only). */
function ssoStatus(ctx: AdminCtx): {
  configured: boolean
  tenantLast4: string | null
  clientIdCount: number
  domainCount: number
} {
  const cfg = ssoConfigFromEnv(ctx.env)
  if (!cfg) return { configured: false, tenantLast4: null, clientIdCount: 0, domainCount: 0 }
  return {
    configured: true,
    tenantLast4: cfg.tenantId.slice(-4),
    clientIdCount: cfg.clientIds.length,
    domainCount: cfg.domains.length
  }
}

export async function enrollPanelPayload(ctx: AdminCtx) {
  const now = ctx.now
  const dayStart = utcDayStart(now)
  // A D1 one migration behind has no enrolment tables yet. `/health` already says so; the console (every page,
  // since the dashboard carries this slice) must keep loading, with an empty token list.
  let tokens: ReturnType<typeof enrollTokenView>[] = []
  try {
    const rows = await ctx.store.listEnrollTokens()
    tokens = await Promise.all(
      rows.map(async (row) =>
        enrollTokenView(row, await ctx.store.countEnrollments({ tokenKid: row.kid, since: dayStart }), now)
      )
    )
  } catch {
    tokens = []
  }
  return {
    tokens,
    settings: await readEnrollSettings(ctx.store),
    tierIds: await knownTierIds(ctx.store),
    sso: ssoStatus(ctx),
    channel: workerChannel(ctx.env),
    isOwner: isOwnerEmail(ctx.email, ctx.env)
  }
}

export function registerEnrollAdminRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/enroll-tokens',
    auth: 'admin',
    handler: async (_request, ctx) => json({ ok: true, ...(await enrollPanelPayload(ctx)) })
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/enroll-tokens',
    auth: 'admin',
    handler: async (request, ctx) => {
      const denied = await requireOwner(ctx)
      if (denied) return denied
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid json' }, 400)
      const created = await createEnrollToken(
        ctx.store,
        {
          label: body.label,
          channel: body.channel,
          expiresInDays: body.expiresInDays,
          maxDevices: body.maxDevices,
          dailyCap: body.dailyCap
        },
        ctx.email,
        ctx.now
      )
      if (!created.ok) return json({ ok: false, error: created.error }, created.status)
      const { row } = created
      // The kid is a public row id; the secret is never in the audit trail.
      await auditLog(
        ctx,
        'enroll-token-create',
        null,
        safeAuditText(
          `${row.kid} · ${row.label} · ${row.channel} · expires ${new Date(row.expires_at).toISOString().slice(0, 10)}`
        )
      )
      // Deliberately a plain `json()` (not `stripSecrets`): this is the one response that carries the token.
      return json({
        ok: true,
        kid: row.kid,
        token: created.token,
        label: row.label,
        channel: row.channel,
        expiresAt: row.expires_at,
        maxDevices: row.max_devices,
        dailyCap: row.daily_cap,
        shownOnce: true
      })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/enroll-tokens\/(?<kid>[0-9a-f]{16})\/revoke$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const denied = await requireOwner(ctx)
      if (denied) return denied
      const kid = match.params.kid
      const existing = await ctx.store.getEnrollToken(kid)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      const body = (await request.json().catch(() => ({}))) as { reason?: unknown; cascade?: unknown }
      const reason = typeof body.reason === 'string' ? safeAuditText(body.reason, 120) || 'revoked' : 'revoked'
      const cascade = body.cascade === true
      const revoked = await ctx.store.revokeEnrollToken(kid, ctx.email, reason, ctx.now)
      if (!revoked) return json({ ok: false, error: 'already revoked', code: 'already-revoked' }, 409)
      const cascaded = cascade ? await ctx.store.revokeLicensesEnrolledByToken(kid, ctx.now) : 0
      await auditLog(
        ctx,
        'enroll-token-revoke',
        null,
        safeAuditText(`${kid} · ${existing.label} · ${reason}${cascade ? ` · cascade ${cascaded} licences` : ''}`)
      )
      return json({ ok: true, kid, cascaded })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/settings/enroll',
    auth: 'admin',
    handler: async (request, ctx) => {
      const denied = await requireOwner(ctx)
      if (denied) return denied
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid json' }, 400)
      const checked = validateEnrollSettingsPatch(body, await knownTierIds(ctx.store))
      if (!checked.ok) return json({ ok: false, error: checked.error, field: checked.field }, 400)
      const before = await readEnrollSettings(ctx.store)
      await writeEnrollSettings(ctx.store, checked.patch, ctx.email, ctx.now)
      const after = await readEnrollSettings(ctx.store)
      await auditLog(
        ctx,
        'enroll-settings-update',
        null,
        safeAuditText(`before ${JSON.stringify(before)} after ${JSON.stringify(after)}`, 300)
      )
      return json({ ok: true, settings: after })
    }
  })
}
