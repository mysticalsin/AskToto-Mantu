/**
 * Seat-facing integration delivery (plan section 9c "Seat delivery"): `GET /v1/integrations`, HMAC
 * authenticated like heartbeat/ingest/manifest, license-gated, tier-entitled. For a `direct` connection
 * (D8), delivers the decrypted vault credential exactly as before this task, auditing the delivery with
 * an `integration_grants` row and an audit row. For a `brokered` connection (the new default, task B2),
 * the credential never leaves the Worker: the seat instead gets `{ transport, mode: 'brokered', endpoint
 * }` and calls that endpoint once the gateway token exists (B3). Never delivers to an unapproved,
 * unlicensed, or non-entitled seat; never logs a credential.
 */
import { decryptVault } from '../crypto'
import { readIntegrationExtra } from '../connectors/data'
import { seatAuthorizedForKeys } from '../fleet'
import { json } from '../http'
import type { IntegrationRow, OperatorStore, SeatRow } from '../store'
import { resolveTierAndEntitlements } from '../tiers'

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

/** New in task B2: a `brokered` connection carries no credential at all, just enough for the desktop to
 *  know a connection exists and where its gateway endpoint will be once B3 mints a gateway token. */
export interface DeliveredIntegrationBrokered {
  id: string
  kind: string
  label: string
  transport: string
  mode: 'brokered'
  endpoint: string
  scopes: IntegrationScope
}

export type DeliveredIntegration = DeliveredIntegrationDirect | DeliveredIntegrationBrokered

export async function handleIntegrationsSeat(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  deviceId: string,
  now: number
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
