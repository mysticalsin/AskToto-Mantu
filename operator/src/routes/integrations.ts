/**
 * Integrations admin routes (plan section 4 D9/D10; task B2): the connector catalog, CRUD for
 * connections, rotate/revoke/delete, and the server-side "Test connection" probe. Every mutation is
 * audited (kind, label, last4 - never the credential); every route is `auth: 'admin'`, so CSRF and Access
 * identity are already enforced by `index.ts` before a handler here ever runs, same as `./admin-core.ts`'s
 * keys routes.
 *
 * The vault encryption (`encryptVault`/`decryptVault`, `OPERATOR_VAULT_KEY`) and `last4OfSecret` are the
 * exact ones `../keys.ts` uses for provider keys; connector credentials get the same treatment.
 *
 * The additive columns this feature needs (`mode`, `allow_writes`, `config_json`, `tools_json`,
 * `last_test_json`, `last_test_at`, `notes`, ...) live in `../connectors/data.ts`, not here or in
 * `../store.ts`/`../d1.ts` - see that module's doc comment for why every mutation below calls
 * `writeIntegrationExtraColumns` again right after `store.putIntegration` whenever `env.DB` is bound.
 */
import { decryptVault, encryptVault } from '../crypto'
import { json } from '../http'
import { last4OfSecret } from '../vault'
import { getConnectorCatalogEntry, publicConnectorCatalog, type ConnectorCatalogEntry } from '../connectors/catalog'
import {
  deleteIntegrationRow,
  INTEGRATION_EXTRA_DEFAULTS,
  readIntegrationExtra,
  withIntegrationExtra,
  writeIntegrationExtraColumns,
  type IntegrationExtraColumns
} from '../connectors/data'
import { probeConnection, type ProbeDeps, type ProbeInput } from '../connectors/probe'
import type { IntegrationRow, OperatorStore } from '../store'
import { defineRoute } from './registry'
import { auditLog, param, type AdminCtx } from './admin-ctx'

const GRANTS_COUNT_LIMIT = 5000
const CONFIG_VALUE_MAX_LENGTH = 500

/** Non-secret identity fields only (email, subdomain, workspace, accountId, baseUrl, ...): a string
 *  value, length-capped, and - when `allowedKeys` is given - restricted to the catalog entry's own
 *  declared field keys (never `credential`, which always goes through the vault instead). Without an
 *  allowlist an admin request body could otherwise stash arbitrary keys/values in `config_json`
 *  indefinitely; this keeps that JSON blob bounded to what the connector actually declared it needs. */
function stringConfig(raw: unknown, allowedKeys?: ReadonlySet<string>): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'credential') continue
    if (allowedKeys && !allowedKeys.has(k)) continue
    if (typeof v === 'string') out[k] = v.trim().slice(0, CONFIG_VALUE_MAX_LENGTH)
  }
  return out
}

function configKeysFor(entry: ConnectorCatalogEntry): Set<string> {
  return new Set(entry.fields.map((f) => f.key).filter((k) => k !== 'credential'))
}

function scopeFromBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const { tiers, groups } = raw as { tiers?: unknown; groups?: unknown }
  const out: Record<string, unknown> = {}
  if (Array.isArray(tiers)) out.tiers = tiers.filter((t): t is string => typeof t === 'string')
  if (Array.isArray(groups)) out.groups = groups.filter((g): g is string => typeof g === 'string')
  return out
}

function parseScopeJson(scopeJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(scopeJson) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Returns the key of the first missing required field (including `credential`, when the catalog entry
 *  marks it required), or null when every requirement is met. */
function missingRequiredField(entry: ConnectorCatalogEntry, config: Record<string, string>, credential: string): string | null {
  for (const field of entry.fields) {
    if (field.key === 'credential') continue
    if (field.required && !(config[field.key] || '').trim()) return field.key
  }
  const credentialField = entry.fields.find((f) => f.key === 'credential')
  if (credentialField?.required && !credential.trim()) return 'credential'
  return null
}

/** `base_url` (the existing column, used for direct-mode desktop delivery) is only meaningful for the
 *  kinds whose catalog fields actually collect one (self-hosted GitLab, the two custom kinds) - every
 *  other kind's request URL is built from `config` at probe/gateway time, not from a single stored
 *  origin, so a fixed public host (HubSpot, Notion, Slack, ...) has nothing useful to put here. */
function deriveBaseUrl(entry: ConnectorCatalogEntry, config: Record<string, string>): string | null {
  if (!entry.fields.some((f) => f.key === 'baseUrl')) return null
  return (config.baseUrl || '').trim() || null
}

async function loadExtras(row: IntegrationRow): Promise<IntegrationExtraColumns> {
  return readIntegrationExtra(row as unknown as Record<string, unknown>)
}

export type IntegrationHealth = 'connected' | 'failing' | 'untested'

/** Derived, never stored: `status` stays `active`/`revoked` only (a transient upstream failure must
 *  never flip `status` to something `integrations-seat.ts`'s `entitledInScopeRows()` does not treat as
 *  `active`, or one bad test would cut a working connector for the whole fleet - see the coordinator's
 *  follow-up after B2). `health` is what the console shows instead: `untested` when no test has ever
 *  run, else `connected`/`failing` from the last stored `ProbeResult.ok`. A row with a corrupt
 *  `last_test_json` (should not happen; `readIntegrationExtra` already guards the column) reads as
 *  `failing` rather than throwing. */
function deriveHealth(extra: Pick<IntegrationExtraColumns, 'last_test_json' | 'last_test_at'>): IntegrationHealth {
  if (!extra.last_test_json || extra.last_test_at == null) return 'untested'
  try {
    const parsed = JSON.parse(extra.last_test_json) as { ok?: unknown }
    return parsed?.ok === true ? 'connected' : 'failing'
  } catch {
    return 'failing'
  }
}

async function integrationSummary(store: OperatorStore, row: IntegrationRow): Promise<Record<string, unknown>> {
  const extra = await loadExtras(row)
  const grants = await store.listIntegrationGrants(row.id, GRANTS_COUNT_LIMIT)
  let lastTest: unknown = null
  if (extra.last_test_json) {
    try {
      lastTest = JSON.parse(extra.last_test_json)
    } catch {
      lastTest = null
    }
  }
  let tools: unknown = null
  if (extra.tools_json) {
    try {
      tools = JSON.parse(extra.tools_json)
    } catch {
      tools = null
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    last4: row.last4,
    status: row.status,
    health: deriveHealth(extra),
    transport: extra.transport,
    authKind: extra.auth_kind,
    headerName: extra.header_name,
    mode: extra.mode,
    allowWrites: extra.allow_writes === 1,
    scope: parseScopeJson(row.scope_json),
    notes: extra.notes,
    tools,
    lastTest,
    lastTestAt: extra.last_test_at,
    uses: row.uses,
    lastUsedAt: row.last_used_at,
    grantsCount: grants.length,
    createdAt: row.created_at,
    createdBy: row.created_by,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at
  }
}

/** Persists `row` through the store (so both the memory store and D1 keep the base columns in sync) and,
 *  when `env.DB` is bound, reapplies the extra columns immediately after - seev `../connectors/data.ts`
 *  for why that second call is required and not optional. */
async function saveIntegration(ctx: AdminCtx, row: IntegrationRow, extra: IntegrationExtraColumns): Promise<IntegrationRow> {
  const merged = withIntegrationExtra(row as unknown as Record<string, unknown>, extra) as unknown as IntegrationRow
  await ctx.store.putIntegration(merged)
  if (ctx.env.DB) await writeIntegrationExtraColumns(ctx.env.DB, row.id, extra)
  return merged
}

function probeDepsFrom(ctx: AdminCtx): ProbeDeps {
  return { fetch: ctx.opts.providerFetch ?? ctx.opts.cfFetch ?? fetch }
}

// No per-route rate limit here: a central per-admin-identity limit on every non-GET admin request is
// being added in operator/src/index.ts (dev-licensing) and covers both test routes below.

export function registerIntegrationsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/connectors/catalog',
    auth: 'admin',
    handler: () => json({ ok: true, catalog: publicConnectorCatalog() })
  })

  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/integrations',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const rows = await ctx.store.listIntegrationRows()
      const integrations = await Promise.all(rows.map((r) => integrationSummary(ctx.store, r)))
      return json({ ok: true, integrations })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/integrations/test',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const kind = typeof body.kind === 'string' ? body.kind : ''
      const entry = getConnectorCatalogEntry(kind)
      if (!entry) return json({ ok: false, error: 'unknown connector kind', code: 'unknown-kind' }, 400)
      if (entry.availability === 'needs-oauth') {
        return json({ ok: false, error: 'this connector needs OAuth, not available yet', code: 'needs-oauth' }, 400)
      }
      const credential = typeof body.credential === 'string' ? body.credential : ''
      const config = stringConfig(body.config, configKeysFor(entry))
      const input: ProbeInput = { credential, config }
      const result = await probeConnection(entry, input, probeDepsFrom(ctx))
      await auditLog(ctx, 'integration-test-draft', null, kind)
      return json({ ok: true, result, health: result.ok ? 'connected' : 'failing' })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: '/v1/admin/integrations',
    auth: 'admin',
    handler: async (request, ctx) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const kind = typeof body.kind === 'string' ? body.kind : ''
      const entry = getConnectorCatalogEntry(kind)
      if (!entry) return json({ ok: false, error: 'unknown connector kind', code: 'unknown-kind' }, 400)
      if (entry.availability === 'needs-oauth') {
        return json({ ok: false, error: 'this connector needs OAuth, not available yet', code: 'needs-oauth' }, 400)
      }
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 120) : ''
      if (!label) return json({ ok: false, error: 'label required' }, 400)
      const credential = typeof body.credential === 'string' ? body.credential.trim() : ''
      const config = stringConfig(body.config, configKeysFor(entry))
      const missing = missingRequiredField(entry, config, credential)
      if (missing) return json({ ok: false, error: `${missing} required`, code: 'missing-field', field: missing }, 400)
      if (!ctx.env.OPERATOR_VAULT_KEY) return json({ ok: false, error: 'vault key unbound', code: 'vault-unbound' }, 503)

      const id = crypto.randomUUID()
      const hasCredential = Boolean(credential)
      const enc = hasCredential ? await encryptVault(credential, ctx.env.OPERATOR_VAULT_KEY) : null
      const row: IntegrationRow = {
        id,
        kind: entry.kind,
        label,
        base_url: deriveBaseUrl(entry, config),
        cipher: enc?.cipher ?? null,
        iv: enc?.iv ?? null,
        last4: hasCredential ? last4OfSecret(credential) : null,
        scope_json: JSON.stringify(scopeFromBody(body.scope)),
        status: 'active',
        created_at: ctx.now,
        created_by: ctx.email,
        rotated_at: null,
        revoked_at: null,
        last_used_at: null,
        uses: 0
      }
      const extra: IntegrationExtraColumns = {
        ...INTEGRATION_EXTRA_DEFAULTS,
        auth_kind: entry.auth,
        header_name: entry.headerName ?? null,
        transport: entry.transport,
        mode: body.mode === 'direct' ? 'direct' : 'brokered',
        allow_writes: body.allowWrites === true ? 1 : 0,
        config_json: JSON.stringify(config),
        notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) || null : null
      }
      const saved = await saveIntegration(ctx, row, extra)
      await auditLog(ctx, 'integration-add', null, `${entry.kind} ${label} ·${row.last4 ?? '----'}`)
      return json({ ok: true, integration: await integrationSummary(ctx.store, saved) })
    }
  })

  defineRoute<AdminCtx>({
    method: 'PATCH',
    pattern: /^\/v1\/admin\/integrations\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      const id = param(match, 'id')
      const existing = await ctx.store.getIntegration(id)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      const entry = getConnectorCatalogEntry(existing.kind)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

      const rowPatch: Partial<IntegrationRow> = {}
      if (typeof body.label === 'string' && body.label.trim()) rowPatch.label = body.label.trim().slice(0, 120)
      if (body.scope !== undefined) rowPatch.scope_json = JSON.stringify(scopeFromBody(body.scope))

      const currentExtra = await loadExtras(existing)
      const extraPatch: Partial<IntegrationExtraColumns> = {}
      if (body.mode === 'direct' || body.mode === 'brokered') extraPatch.mode = body.mode
      if (typeof body.allowWrites === 'boolean') extraPatch.allow_writes = body.allowWrites ? 1 : 0
      if (typeof body.notes === 'string') extraPatch.notes = body.notes.trim().slice(0, 500) || null
      if (body.config !== undefined) {
        const config = stringConfig(body.config, entry ? configKeysFor(entry) : undefined)
        extraPatch.config_json = JSON.stringify(config)
        // Keep the `base_url` column (what direct-mode desktop delivery actually reads) in step with a
        // `config.baseUrl` edit - self-hosted GitLab, custom-mcp and custom-rest all rely on it.
        if (entry) rowPatch.base_url = deriveBaseUrl(entry, config)
      }

      const saved = await saveIntegration(ctx, { ...existing, ...rowPatch }, { ...currentExtra, ...extraPatch })
      await auditLog(ctx, 'integration-update', null, `${existing.kind} ${saved.label}`)
      return json({ ok: true, integration: await integrationSummary(ctx.store, saved) })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/integrations\/(?<id>[^/]+)\/rotate$/,
    auth: 'admin',
    handler: async (request, ctx, match) => {
      if (!ctx.env.OPERATOR_VAULT_KEY) return json({ ok: false, error: 'vault key unbound', code: 'vault-unbound' }, 503)
      const id = param(match, 'id')
      const existing = await ctx.store.getIntegration(id)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      if (existing.status === 'revoked') return json({ ok: false, error: 'revoked' }, 400)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const credential = typeof body.credential === 'string' ? body.credential.trim() : ''
      if (!credential) return json({ ok: false, error: 'credential required' }, 400)
      const enc = await encryptVault(credential, ctx.env.OPERATOR_VAULT_KEY)
      const last4 = last4OfSecret(credential)
      const currentExtra = await loadExtras(existing)
      await saveIntegration(ctx, { ...existing, cipher: enc.cipher, iv: enc.iv, last4, rotated_at: ctx.now }, currentExtra)
      await auditLog(ctx, 'integration-rotate', null, `${existing.kind} ${existing.label} ·${last4}`)
      return json({ ok: true, id, last4, status: existing.status })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/integrations\/(?<id>[^/]+)\/revoke$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const id = param(match, 'id')
      const existing = await ctx.store.getIntegration(id)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      const currentExtra = await loadExtras(existing)
      await saveIntegration(ctx, { ...existing, status: 'revoked', revoked_at: ctx.now, cipher: null, iv: null }, currentExtra)
      await auditLog(ctx, 'integration-revoke', null, `${existing.kind} ${existing.label}`)
      return json({ ok: true, id, status: 'revoked' })
    }
  })

  defineRoute<AdminCtx>({
    method: 'POST',
    pattern: /^\/v1\/admin\/integrations\/(?<id>[^/]+)\/test$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const id = param(match, 'id')
      const existing = await ctx.store.getIntegration(id)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      const entry = getConnectorCatalogEntry(existing.kind)
      if (!entry) return json({ ok: false, error: 'unknown connector kind', code: 'unknown-kind' }, 400)
      if (!ctx.env.OPERATOR_VAULT_KEY) return json({ ok: false, error: 'vault key unbound', code: 'vault-unbound' }, 503)

      const currentExtra = await loadExtras(existing)
      let credential = ''
      if (existing.cipher && existing.iv) {
        try {
          credential = await decryptVault(existing.cipher, existing.iv, ctx.env.OPERATOR_VAULT_KEY)
        } catch {
          credential = ''
        }
      }
      let config: Record<string, string> = {}
      try {
        const parsed = JSON.parse(currentExtra.config_json) as unknown
        config = parsed && typeof parsed === 'object' ? stringConfig(parsed) : {}
      } catch {
        config = {}
      }

      const result = await probeConnection(entry, { credential, config }, probeDepsFrom(ctx))
      // `status` never changes here - only `active`/`revoked` mean anything to `integrations-seat.ts`'s
      // entitledInScopeRows() (strictly `status === 'active'`), and a transient upstream failure must not
      // cut a working connector from the whole fleet just because one Test connection call failed. The
      // outcome instead lives in `last_test_json`/`last_test_at`, surfaced as the derived `health` field
      // (`deriveHealth`) here and on every row from `GET /v1/admin/integrations`. See the coordinator's
      // follow-up after B2 - this replaces the earlier `status: 'active' | 'failing'` behaviour.
      const nextExtra: IntegrationExtraColumns = {
        ...currentExtra,
        last_test_json: JSON.stringify(result),
        last_test_at: ctx.now,
        tools_json: result.tools ? JSON.stringify(result.tools) : currentExtra.tools_json
      }
      await saveIntegration(ctx, existing, nextExtra)
      await auditLog(ctx, 'integration-test', null, `${existing.kind} ${existing.label} ·${existing.last4 ?? '----'}`)
      return json({ ok: true, result, health: deriveHealth(nextExtra) })
    }
  })

  defineRoute<AdminCtx>({
    method: 'DELETE',
    pattern: /^\/v1\/admin\/integrations\/(?<id>[^/]+)$/,
    auth: 'admin',
    handler: async (_request, ctx, match) => {
      const id = param(match, 'id')
      const existing = await ctx.store.getIntegration(id)
      if (!existing) return json({ ok: false, error: 'not found' }, 404)
      if (existing.status !== 'revoked') return json({ ok: false, error: 'revoke before deleting' }, 400)
      // `OperatorStore` (owned by another task) has no delete primitive of its own; the in-memory store
      // used in dev/tests without a bound D1 has nothing this route can call to actually remove the row,
      // so it answers honestly here rather than claiming a deletion that did not happen.
      if (!ctx.env.DB) return json({ ok: false, error: 'delete requires D1', code: 'no-db' }, 501)
      await deleteIntegrationRow(ctx.env.DB, id)
      await auditLog(ctx, 'integration-delete', null, `${existing.kind} ${existing.label}`)
      return json({ ok: true, id })
    }
  })
}
