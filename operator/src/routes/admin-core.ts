/**
 * Core admin routes (plan section 4): dashboard, summary, asks, reveal, skills, crm, licenses,
 * keys, health, audit, export, plus the console shell and the Cloudflare OAuth connect/callback
 * and session routes that don't belong to any other feature module. Realtime/live routes live in
 * `./live`, Events in `./events`, Sessions in `./sessions`.
 */
import { accessTeamDomain, CONSOLE_PATHS } from '../access'
import { handleCloudflareCallback, redirectToCloudflareLogin } from '../cloudflare-connect'
import { decryptPrompt, sha256Hex, signSkillPack } from '../crypto'
import { buildDashboard } from '../dashboard'
import { html, json, newCspNonce } from '../http'
import type { D1DatabaseLike } from '../d1'
import { listKeysJson, revokeVaultKey, rotateVaultKey, writeVaultKey } from '../keys'
import { LICENSES_EMPTY, parseApproval } from '../fleet'
import { mintOperatorLicense } from '../licenses/generate'
import { renderConsole } from '../ui'
import { defineRoute } from './registry'
import { auditLog, cloudflareForDashboard, keyFlags, param, stripSecrets, type AdminCtx } from './admin-ctx'
import { readOperatorSettings } from './settings-store'

/** The stored hourly rate and currency feed the Value tile; without a stored rate valueMinor stays null. */
async function valueSettings(ctx: AdminCtx): Promise<{ hourlyRate: number | null; currency: string }> {
  const { values } = await readOperatorSettings(ctx.env.DB)
  return { hourlyRate: values.hourlyRate, currency: values.currency }
}

// Exported so `index.ts`'s `/health` (task B6, plan D10) can report `schema` from "the same check
// health.json uses" rather than a second, driftable copy of this list.
export const EXPECTED_D1_TABLES = [
  'seats',
  'asks',
  'pulses',
  'events',
  'vault_keys',
  'crm_sends',
  'nonces',
  'rate_limits',
  'proposals',
  'packs',
  'audit',
  'issued_licenses',
  'sessions',
  'groups',
  'group_members',
  'tiers',
  'integrations',
  'integration_grants',
  'operator_settings'
] as const

const PLACEHOLDER_DIFF_RE = /^#\s*unified diff against .+\n#\s*edit, then approve\. push is a separate click\.$/i

function consoleShellPattern(): RegExp {
  const escaped = (CONSOLE_PATHS as readonly string[]).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^(?:${escaped.join('|')})$`)
}

function isPlaceholderDiff(source: string): boolean {
  return PLACEHOLDER_DIFF_RE.test(source.trim())
}

function bump(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return '1.0.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function skillPackBody(skillId: string, version: string, source: string): string {
  const trimmed = source.replace(/\r\n/g, '\n').trim()
  if (trimmed.startsWith('---')) {
    return trimmed.replace(/^version:\s*.*$/m, `version: ${version}`)
  }
  return `---\nid: ${skillId}\nversion: ${version}\nlocked: true\n---\n\n${trimmed}\n`
}

async function skillDecision(request: Request, ctx: AdminCtx, id: string, action: string): Promise<Response> {
  const { store, email, now } = ctx
  const row = await store.getProposal(id)
  if (!row) return json({ ok: false, error: 'not found' }, 404)
  const body = (await request.json().catch(() => ({}))) as { diff?: string; reason?: string; body?: string }
  if (action === 'reject') {
    await store.putProposal({ ...row, status: 'rejected', reject_reason: body.reason || 'rejected', decided_at: now })
    await auditLog(ctx, 'reject', null, row.skill_id)
    return json({ ok: true })
  }
  if (action === 'approve') {
    await store.putProposal({
      ...row,
      status: 'approved',
      diff: typeof body.diff === 'string' ? body.diff : row.diff,
      decided_at: now
    })
    await auditLog(ctx, 'approve', null, row.skill_id)
    return json({ ok: true, pushed: false })
  }
  if (row.status !== 'approved') return json({ ok: false, error: 'approve first' }, 400)
  const source = typeof body.body === 'string' ? body.body : row.diff
  if (isPlaceholderDiff(source)) {
    return json({ ok: false, error: 'skill body is still the placeholder; edit it before pushing', code: 'placeholder-diff' }, 400)
  }
  if (!ctx.env.OPERATOR_SKILL_PRIVATE_KEY) return json({ ok: false, error: 'skill signing key missing' }, 500)
  const nextVersion = bump(row.from_version)
  const skillBody = skillPackBody(row.skill_id, nextVersion, source)
  const digest = await sha256Hex(skillBody)
  const signed = await signSkillPack(
    { skillId: row.skill_id, version: nextVersion, sha256: digest, body: skillBody },
    ctx.env.OPERATOR_SKILL_PRIVATE_KEY
  )
  await store.putPack({
    id: crypto.randomUUID(),
    skill_id: row.skill_id,
    version: nextVersion,
    sha256: digest,
    body: skillBody,
    signed,
    pushed_at: now,
    pushed_by: email
  })
  await store.putProposal({ ...row, status: 'pushed', decided_at: now })
  await auditLog(ctx, 'push', null, `${row.skill_id}@${nextVersion}`)
  return json({ ok: true, pushed: true, version: nextVersion, signed })
}

async function healthPayload(env: AdminCtx['env']): Promise<Record<string, unknown>> {
  const flags = keyFlags(env)
  const d1 = await d1SchemaStatus(env.DB)
  return {
    ok: Boolean(flags.ingestBound && flags.promptBound),
    version: env.OPERATOR_VERSION ?? 'dev',
    bindings: {
      ingest: flags.ingestBound,
      prompt: flags.promptBound,
      skill: flags.skillBound,
      vault: flags.vaultBound,
      session: Boolean(env.OPERATOR_SESSION_SECRET?.trim() || env.OPERATOR_PROMPT_KEY?.trim()),
      oauth: flags.oauthBound
    },
    access: {
      teamDomain: Boolean(accessTeamDomain(env.TEAM_DOMAIN)),
      policyAud: Boolean(env.POLICY_AUD?.trim())
    },
    d1
  }
}

export async function d1SchemaStatus(db: D1DatabaseLike | undefined): Promise<{ ok: boolean; tables: string[]; missing: string[] }> {
  if (!db) return { ok: true, tables: [], missing: [] }
  const tables: string[] = []
  const missing: string[] = []
  for (const table of EXPECTED_D1_TABLES) {
    try {
      const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
      if (info.results && info.results.length > 0) tables.push(table)
      else missing.push(table)
    } catch {
      missing.push(table)
    }
  }
  return { ok: missing.length === 0, tables, missing }
}

async function auditJson(ctx: AdminCtx): Promise<Response> {
  const params = ctx.url.searchParams
  const since = Number(params.get('since') ?? 0) || undefined
  const actor = params.get('actor')?.trim().toLowerCase() || undefined
  const action = params.get('action')?.trim() || undefined
  const limit = Math.min(500, Math.max(1, Number(params.get('limit') ?? 100) || 100))
  const rows = await ctx.store.listAudit(limit, { since, actor, action })
  return json({ ok: true, audit: rows })
}

/** `/v1/admin/licenses/:id/:action` shared by two concepts: revoking an Operator-issued license (by
 *  `jti`) and approving/revoking a seat (by `deviceId`). A `jti` is only ever an issued-license id,
 *  so it is tried first for `revoke`; anything else falls back to the seat-approval behaviour this
 *  route has always had. `approve` only ever means seat approval - there is no issued-license
 *  "approve". */
async function licenseOrSeatAction(ctx: AdminCtx, id: string, action: 'approve' | 'revoke'): Promise<Response> {
  if (action === 'revoke') {
    const issued = await ctx.store.getIssuedLicense(id)
    if (issued) {
      const revoked = await ctx.store.revokeIssuedLicense(id, ctx.now)
      await auditLog(ctx, 'revoke-license', null, id)
      return json({ ok: true, jti: id, revoked })
    }
  }
  const approval = action === 'approve' ? 'approved' : 'revoked'
  const ok = await ctx.store.updateSeatApproval(id, approval)
  if (!ok) return json({ ok: false, error: 'seat not found' }, 404)
  await auditLog(ctx, approval === 'approved' ? 'approve-seat' : 'revoke-seat', null, id)
  return json({ ok: true, deviceId: id, approval })
}

export function registerAdminCoreRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/session',
    auth: 'admin',
    handler: () => json({ ok: true })
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/cloudflare/connect',
    auth: 'admin',
    handler: (request, ctx) => redirectToCloudflareLogin(request, ctx.env)
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/cloudflare/callback',
    auth: 'admin',
    handler: (request, ctx) =>
      handleCloudflareCallback(request, ctx.env, ctx.store, ctx.email, ctx.now, ctx.opts.cfFetch ?? fetch)
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: consoleShellPattern(),
    auth: 'admin',
    handler: async (_request, ctx) => {
      const nonce = newCspNonce()
      const dash = await buildDashboard(ctx.store, ctx.email, ctx.now, keyFlags(ctx.env), await cloudflareForDashboard(ctx.store, ctx.env, ctx.opts, ctx.now), await valueSettings(ctx))
      return html(renderConsole(dash), { nonce })
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/dashboard',
    auth: 'admin',
    handler: async (_request, ctx) =>
      json(
        stripSecrets(
          await buildDashboard(ctx.store, ctx.email, ctx.now, keyFlags(ctx.env), await cloudflareForDashboard(ctx.store, ctx.env, ctx.opts, ctx.now), await valueSettings(ctx))
        )
      )
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/health.json',
    auth: 'admin',
    handler: async (_request, ctx) => json(await healthPayload(ctx.env))
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/audit.json',
    auth: 'admin',
    handler: async (_request, ctx) => auditJson(ctx)
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/keys',
    auth: 'admin',
    handler: async (_request, ctx) => json(stripSecrets({ ok: true, ...(await listKeysJson(ctx.store, keyFlags(ctx.env))) }))
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/keys',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const written = await writeVaultKey(ctx.store, ctx.env, ctx.email, ctx.now, body)
      if (!written.ok) return json({ ok: false, error: written.error }, written.status)
      return json(written)
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/keys\/(?<id>[^/]+)\/rotate$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const out = await rotateVaultKey(ctx.store, ctx.env, ctx.email, ctx.now, param(match, 'id'), body)
      if (!out.ok) return json({ ok: false, error: out.error }, out.status)
      return json(out)
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/keys\/(?<id>[^/]+)\/revoke$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const out = await revokeVaultKey(ctx.store, ctx.email, ctx.now, param(match, 'id'))
      if (!out.ok) return json({ ok: false, error: out.error }, out.status)
      return json(out)
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/summary',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const dash = await buildDashboard(ctx.store, ctx.email, ctx.now)
      return json({
        ok: true,
        live: dash.kpis.live,
        dau: dash.kpis.dau,
        wau: dash.kpis.wau,
        costToday: dash.kpis.costToday,
        hitRate: dash.kpis.cacheHit,
        pending: dash.kpis.pendingDiffs
      })
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/asks',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const asks = await ctx.store.listAsks(100)
      return json({
        ok: true,
        asks: asks.map((a) => ({ ...a, prompt_cipher: undefined, prompt_iv: undefined, question: undefined }))
      })
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: /^\/v1\/admin\/asks\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const row = await ctx.store.getAsk(param(match, 'id'))
      if (!row) return json({ ok: false, error: 'not found' }, 404)
      let question = ''
      if (row.prompt_cipher && row.prompt_iv) {
        question = await decryptPrompt(row.prompt_cipher, row.prompt_iv, ctx.env.OPERATOR_PROMPT_KEY)
      }
      await auditLog(ctx, 'reveal', row.id, 'ask text')
      return json({ ok: true, id: row.id, question })
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/skills/draft',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as { skillId?: string }
      const skillId = body.skillId || 'general'
      const asks = (await ctx.store.listAsks(80)).filter((a) => a.mode === skillId || a.skill_id === skillId)
      const evidence = asks
        .map((a) => a.preview || '')
        .filter(Boolean)
        .slice(0, 8)
      const fromVersion = asks.find((a) => a.skill_version)?.skill_version || '1.1.0'
      const id = crypto.randomUUID()
      await ctx.store.putProposal({
        id,
        skill_id: skillId,
        from_version: fromVersion,
        evidence_json: JSON.stringify(evidence),
        diff: `# unified diff against ${skillId} v${fromVersion}\n# Edit, then Approve. Push is a separate click.\n`,
        rationale: evidence.length
          ? `Clustered ${evidence.length} recent Asks in ${skillId}.`
          : `No recent Asks in ${skillId} yet. Draft is a blank edit.`,
        status: 'pending',
        created_by: ctx.email,
        created_at: ctx.now,
        decided_at: null,
        reject_reason: null
      })
      await auditLog(ctx, 'draft', null, skillId)
      return json({ ok: true, id })
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/skills\/(?<id>[^/]+)\/(?<action>approve|reject|push)$/,
    auth: 'admin',
    handler: async (request, ctx, match) => skillDecision(request, ctx, param(match, 'id'), match.params.action)
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/crm\/(?<id>[^/]+)\/retry$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const row = await ctx.store.getCrm(param(match, 'id'))
      if (!row) return json({ ok: false, error: 'not found' }, 404)
      if (row.status !== 'failed' && row.status !== 'expired') {
        return json({ ok: false, error: 'only Failed or Expired can retry' }, 400)
      }
      await ctx.store.upsertCrm({ ...row, status: 'pending', retry_requested: 1, ts: ctx.now })
      await auditLog(ctx, 'crm-retry', null, row.id)
      return json({ ok: true, autoSend: false })
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/licenses/generate',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const minted = await mintOperatorLicense(ctx, { days: body.days, actor: ctx.email })
      if (!minted.ok) return json({ ok: false, error: minted.error }, minted.status)
      return json({
        ok: true,
        license: minted.token,
        jti: minted.jti,
        last4: minted.last4,
        days: minted.days,
        iat: minted.iat,
        exp: minted.exp
      })
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/licenses/issued',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const rows = (await ctx.store.listIssuedLicenses()).map((r) => ({
        jti: r.jti,
        last4: r.last4,
        days: r.days,
        exp: r.exp,
        revoked: r.revoked,
        createdAt: r.created_at
      }))
      return json(stripSecrets({ ok: true, issued: rows }))
    }
  })
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/licenses',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const dash = await buildDashboard(ctx.store, ctx.email, ctx.now)
      if (dash.licenses.empty) return json({ ok: false, error: LICENSES_EMPTY, empty: true }, 404)
      return json(stripSecrets({ ok: true, licenses: dash.licenses.rows }))
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/licenses',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
      const approval = parseApproval(body.approval)
      if (!deviceId || !approval) return json({ ok: false, error: 'deviceId and approval required' }, 400)
      const ok = await ctx.store.updateSeatApproval(deviceId, approval)
      if (!ok) return json({ ok: false, error: 'seat not found' }, 404)
      await auditLog(ctx, approval === 'approved' ? 'approve-seat' : 'revoke-seat', null, deviceId)
      return json({ ok: true, deviceId, approval })
    }
  })
  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/licenses\/(?<id>[^/]+)\/(?<action>approve|revoke)$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => licenseOrSeatAction(ctx, param(match, 'id'), match.params.action as 'approve' | 'revoke')
  })
}
