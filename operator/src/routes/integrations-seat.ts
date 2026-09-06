/**
 * Seat-facing integration delivery (plan section 9c "Seat delivery"): `GET /v1/integrations`, HMAC
 * authenticated like heartbeat/ingest/manifest, license-gated, tier-entitled. For a `direct` connection
 * (D8), delivers the decrypted vault credential exactly as before this task, auditing the delivery with
 * an `integration_grants` row and an audit row. For a `brokered` connection (the new default, task B2),
 * the credential never leaves the Worker: the seat instead gets `{ transport, mode: 'brokered', endpoint,
 * gatewayToken }` (task B3) - a 1 hour bearer token bound to this device and this connection, minted
 * fresh on every pull the same way the heartbeat response mints one, so a seat's desktop client (which
 * refreshes on every heartbeat) never has to hold a stale one for long. Never delivers to an unapproved,
 * unlicensed, or non-entitled seat; never logs a credential.
 */
import { decryptVault, encryptVault } from '../crypto'
import { readIntegrationExtra, writeIntegrationExtraColumns } from '../connectors/data'
import type { D1DatabaseLike } from '../d1'
import { mintGatewayToken } from '../connectors/gateway-token'
import { getConnectorCatalogEntry } from '../connectors/catalog'
import { oauthTokenNeedsRefresh, refreshOAuthToken, type OAuthTokenPayload } from '../connectors/oauth'
import { seatAuthorizedForKeys } from '../fleet'
import { json } from '../http'
import { last4OfSecret } from '../vault'
import type { IntegrationRow, OperatorStore, SeatRow } from '../store'
import { resolveTierAndEntitlements } from '../tiers'

function decodeOAuthPayload(plaintext: string): OAuthTokenPayload | null {
  try {
    const parsed = JSON.parse(plaintext) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    if (typeof p.accessToken !== 'string' || typeof p.expiresAt !== 'number') return null
    return {
      accessToken: p.accessToken,
      refreshToken: typeof p.refreshToken === 'string' ? p.refreshToken : undefined,
      expiresAt: p.expiresAt,
      tokenType: typeof p.tokenType === 'string' ? p.tokenType : undefined
    }
  } catch {
    return null
  }
}

function parseConfigJson(configJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(configJson) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/**
 * Refreshes an auth-code-flow `direct`-mode connection's access token when it is within 5 minutes of
 * expiry (task item 4) before delivering it to a seat - `brokered` mode never reaches this at all, since
 * the seat only ever gets a gateway token, never the connector's own credential. Pure with respect to the
 * *decision*: `oauth.ts#refreshOAuthToken` makes the actual token-endpoint call; this wrapper is the one
 * piece of storage glue (re-encrypt, persist, audit) that lives here because it is the seat-delivery path,
 * not `oauth.ts`, that owns "when" to call it. A refresh failure marks `last_test_json` failing and
 * returns the *old*, still-decrypted access token (better an expiring token attempt than none at all -
 * the vendor, not this Worker, is the final word on whether it still works) - the row itself is never
 * touched beyond that JSON field, in particular never deleted.
 */
export async function refreshDirectOAuthCredential(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string; DB?: D1DatabaseLike },
  row: IntegrationRow,
  payload: OAuthTokenPayload,
  configJson: string,
  now: number,
  fetchImpl: typeof fetch
): Promise<string> {
  if (!oauthTokenNeedsRefresh(payload, now)) return payload.accessToken
  const config = parseConfigJson(configJson)
  const result = await refreshOAuthToken(row.kind, payload, config, env, { fetch: fetchImpl }, getConnectorCatalogEntry)
  const currentExtra = readIntegrationExtra(row as unknown as Record<string, unknown>)
  if (!result.ok) {
    await store.audit(crypto.randomUUID(), now, row.created_by ?? 'system', 'integration-oauth-refresh-failed', null, `${row.kind} ${result.error.code}`)
    const failingExtra = { ...currentExtra, last_test_json: JSON.stringify({ ok: false, latencyMs: 0, summary: '', error: result.error }), last_test_at: now }
    // HIGH fix: a failing refresh must never touch cipher/iv. `row` is this call's own in-memory
    // snapshot, taken before the refresh attempt - if a *concurrent* refresh for the same connection
    // already succeeded and persisted a new cipher/iv (and, for an auth-code grant, the vendor may have
    // already invalidated the old refresh_token once the new one was issued), calling
    // store.putIntegration with this stale row would silently overwrite that fresh ciphertext with the
    // old one, permanently breaking the connection. When D1 is bound, writeIntegrationExtraColumns is a
    // targeted UPDATE of the extra columns only (`../connectors/data.ts`) - it never touches cipher/iv,
    // so a concurrent success's ciphertext survives. The memory store has no equivalent partial-update
    // primitive, so putIntegration is kept there as the fallback; that store is single-threaded
    // test/dev use only; there is no concurrent request to race against in the first place. (A
    // success-versus-success race - two overlapping refreshes that both succeed - still has no
    // compare-and-swap guard either way; that needs a primitive in d1.ts/store.ts, which this task does
    // not own - see the report.)
    if (env.DB) {
      await writeIntegrationExtraColumns(env.DB, row.id, failingExtra)
    } else {
      await store.putIntegration({ ...row, ...failingExtra } as unknown as IntegrationRow)
    }
    return payload.accessToken
  }
  if (!env.OPERATOR_VAULT_KEY) return payload.accessToken
  const enc = await encryptVault(JSON.stringify(result.payload), env.OPERATOR_VAULT_KEY)
  const updated: IntegrationRow = { ...row, cipher: enc.cipher, iv: enc.iv, last4: last4OfSecret(result.payload.accessToken) }
  await store.putIntegration({ ...updated, ...currentExtra } as unknown as IntegrationRow)
  if (env.DB) await writeIntegrationExtraColumns(env.DB, row.id, currentExtra)
  await store.audit(crypto.randomUUID(), now, row.created_by ?? 'system', 'integration-oauth-refreshed', null, row.kind)
  return result.payload.accessToken
}

export interface IntegrationScope {
  tiers?: string[]
  groups?: string[]
}

export function parseIntegrationScope(raw: string): IntegrationScope {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const { tiers, groups } = parsed as IntegrationScope
    return {
      tiers: Array.isArray(tiers) ? tiers.filter((t) => typeof t === 'string') : undefined,
      groups: Array.isArray(groups) ? groups.filter((g) => typeof g === 'string') : undefined
    }
  } catch {
    return {}
  }
}

/** Empty scope (no `tiers`, no `groups`) means every entitled seat; otherwise the seat's resolved
 *  tier, or membership in one of the listed groups (by device id or SSO email), must match. */
async function seatInScope(
  store: Pick<OperatorStore, 'listGroupMembers'>,
  scope: IntegrationScope,
  seat: Pick<SeatRow, 'device_id' | 'sso_email'>,
  tier: string | null
): Promise<boolean> {
  const tiers = scope.tiers ?? []
  const groups = scope.groups ?? []
  if (!tiers.length && !groups.length) return true
  if (tier && tiers.includes(tier)) return true
  for (const groupId of groups) {
    const members = await store.listGroupMembers(groupId)
    const matched = members.some(
      (m) =>
        (m.kind === 'device' && m.member === seat.device_id) ||
        (m.kind === 'email' && seat.sso_email != null && m.member.toLowerCase() === seat.sso_email.toLowerCase())
    )
    if (matched) return true
  }
  return false
}

async function entitledInScopeRows(
  store: Pick<OperatorStore, 'listIntegrationRows' | 'listGroupMembers'>,
  seat: Pick<SeatRow, 'device_id' | 'sso_email'>,
  tier: string | null
): Promise<IntegrationRow[]> {
  const rows = (await store.listIntegrationRows()).filter((r) => r.status === 'active')
  const out: IntegrationRow[] = []
  for (const row of rows) {
    if (await seatInScope(store, parseIntegrationScope(row.scope_json), seat, tier)) out.push(row)
  }
  return out
}

/** Max `rotated_at ?? created_at` across the integrations this seat's tier/group is entitled to, 0
 *  if none. Carried on every heartbeat so the desktop knows to re-pull `/v1/integrations`. */
export async function computeIntegrationsVersion(
  store: Pick<OperatorStore, 'listIntegrationRows' | 'listGroupMembers'>,
  seat: Pick<SeatRow, 'device_id' | 'sso_email'>,
  tier: string | null
): Promise<number> {
  const rows = await entitledInScopeRows(store, seat, tier)
  return rows.reduce((max, r) => Math.max(max, r.rotated_at ?? r.created_at), 0)
}

const NOT_ENTITLED = { ok: false, error: 'seat not entitled', code: 'not-entitled' } as const

/** Unchanged from before task B2: a `direct` connection's decrypted credential and base URL. */
export interface DeliveredIntegrationDirect {
  id: string
  kind: string
  label: string
  baseUrl: string | null
  credential: string
  scopes: IntegrationScope
}

/** A `brokered` connection carries no credential at all: just enough for the desktop to know a
 *  connection exists, where its gateway endpoint is, and the bearer token (task B3) to call it with. */
export interface DeliveredIntegrationBrokered {
  id: string
  kind: string
  label: string
  transport: string
  mode: 'brokered'
  endpoint: string
  gatewayToken: string
  scopes: IntegrationScope
}

export type DeliveredIntegration = DeliveredIntegrationDirect | DeliveredIntegrationBrokered

export async function handleIntegrationsSeat(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string; OPERATOR_INGEST_SECRET: string; DB?: D1DatabaseLike },
  deviceId: string,
  now: number,
  /** Injected for the OAuth refresh's token-endpoint call (task item 4) - defaults to the ambient
   *  `fetch` so `index.ts`'s existing 4-argument call site needs no change; tests pass a fake here
   *  directly (this route predates `HandleOpts.providerFetch` reaching this deep, and adding it there
   *  would touch `index.ts`, which this task does not own). */
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (!env.OPERATOR_VAULT_KEY) return json({ ok: false, error: 'vault key unbound' }, 503)
  const seat = await store.getSeat(deviceId)
  if (!seat) return json(NOT_ENTITLED, 403)
  if (!(await seatAuthorizedForKeys(store, seat, now))) return json(NOT_ENTITLED, 403)
  const { tier, entitlements } = await resolveTierAndEntitlements(store, seat, now)
  if (!entitlements.includes('integrations')) return json(NOT_ENTITLED, 403)

  const rows = await entitledInScopeRows(store, seat, tier)
  const delivered: DeliveredIntegration[] = []
  for (const row of rows) {
    const extra = readIntegrationExtra(row as unknown as Record<string, unknown>)
    if (extra.mode === 'direct') {
      if (!row.cipher || !row.iv) continue
      let credential: string
      try {
        credential = await decryptVault(row.cipher, row.iv, env.OPERATOR_VAULT_KEY)
      } catch {
        continue
      }
      // An auth-code OAuth connection's ciphertext decrypts to the OAuthTokenPayload JSON, not a bare
      // token - unwrap it, refreshing first when the access token is within 5 minutes of expiry (task
      // item 4). A static-credential kind's decrypted value is never valid JSON shaped like this, so
      // `decodeOAuthPayload` returning null here is the overwhelmingly common, expected case.
      const oauthEntry = getConnectorCatalogEntry(row.kind)
      if (oauthEntry?.oauth?.flow === 'auth-code') {
        const payload = decodeOAuthPayload(credential)
        if (payload) credential = await refreshDirectOAuthCredential(store, env, row, payload, extra.config_json, now, fetchImpl)
      }
      delivered.push({
        id: row.id,
        kind: row.kind,
        label: row.label,
        baseUrl: row.base_url,
        credential,
        scopes: parseIntegrationScope(row.scope_json)
      })
    } else {
      delivered.push({
        id: row.id,
        kind: row.kind,
        label: row.label,
        transport: extra.transport ?? 'rest',
        mode: 'brokered',
        endpoint: `/v1/mcp/${row.id}`,
        gatewayToken: await mintGatewayToken(env.OPERATOR_INGEST_SECRET, deviceId, row.id, now),
        scopes: parseIntegrationScope(row.scope_json)
      })
    }
    await store.insertIntegrationGrant({ id: crypto.randomUUID(), integration_id: row.id, device_id: deviceId, ts: now })
    await store.bumpIntegrationUse(row.id, now)
    await store.audit(crypto.randomUUID(), now, deviceId, 'integration-delivered', null, row.id)
  }
  const version = rows.reduce((max, r) => Math.max(max, r.rotated_at ?? r.created_at), 0)
  return json({ ok: true, version, integrations: delivered })
}
