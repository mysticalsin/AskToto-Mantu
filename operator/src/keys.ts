import {
  GatewayPrivacyError,
  isCloudflareVaultPaste,
  verifyDefaultGatewayPrivacy,
  type GatewayPrivacyErrorCode
} from './ai-gateway'
import { PROVIDERS, type ProviderDef, type ProviderId } from '../../src/shared/providers'
import { decryptVault, encryptVault } from './crypto'
import { looksLikeSecret } from './redact'
import { seatAuthorizedForKeys } from './fleet'
import type { OperatorStore, SeatRow, VaultKeyMeta, VaultKeyRow } from './store'
import {
  CF_ACCOUNT_PROVIDER,
  decodeVaultPlaintext,
  encodeVaultPlaintext,
  fundedProvidersFromMeta,
  isForbiddenVaultProvider,
  isVaultProvider,
  last4OfSecret
} from './vault'

export type KeysFlags = {
  ingestBound: boolean
  promptBound: boolean
  skillBound: boolean
  vaultBound: boolean
  oauthBound: boolean
}

export type KeysListResponse = KeysFlags & {
  vault: VaultKeyMeta[]
}

export function publicVaultMeta(row: VaultKeyMeta): VaultKeyMeta {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    last4: row.last4,
    status: row.status,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    revokedAt: row.revokedAt
  }
}

export async function listKeysJson(store: OperatorStore, flags: KeysFlags): Promise<KeysListResponse> {
  const vault = (await store.listVaultMeta()).map(publicVaultMeta)
  return { ...flags, vault }
}

function labelFromBody(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.label === 'string' && body.label.trim() && !looksLikeSecret(body.label)) {
    return body.label.trim().slice(0, 80)
  }
  return fallback
}

function readSecret(body: Record<string, unknown>): string {
  if (typeof body.secret === 'string' && body.secret.trim()) return body.secret.trim()
  if (typeof body.token === 'string' && body.token.trim()) return body.token.trim()
  return ''
}

export type VaultKeyFailure = { ok: false; error: string; status: number; code?: GatewayPrivacyErrorCode }

/** A failed privacy check must leave the previous working credential intact — the caller
 * runs this before touching the vault, never after. Distinguishes a missing gateway
 * (REVIEW_REQUIRED) from logging left on (CONFIGURATION_UNSAFE) or a token without
 * permission (CHECK_DENIED) instead of collapsing every case into the same 503.
 */
async function verifyGatewayPrivacyForVault(
  secret: string,
  accountId: string,
  fetchImpl: typeof fetch
): Promise<{ ok: true } | VaultKeyFailure> {
  try {
    await verifyDefaultGatewayPrivacy(secret, accountId, fetchImpl)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: 'Cloudflare gateway privacy is not verified; no vault changes were made.',
      status: 503,
      code: error instanceof GatewayPrivacyError ? error.code : undefined
    }
  }
}

/** Validates, privacy-checks and encrypts one vault write without touching the store, so several
 *  rows (Cloudflare's gateway + account) can all be prepared before any of them is persisted. */
async function prepareVaultKeyRow(
  env: { OPERATOR_VAULT_KEY?: string },
  email: string,
  now: number,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<{ ok: true; row: VaultKeyRow } | VaultKeyFailure> {
  if (!env.OPERATOR_VAULT_KEY) return { ok: false, error: 'vault key missing', status: 500 }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  if (!isVaultProvider(provider) || isForbiddenVaultProvider(provider)) {
    return { ok: false, error: 'provider not allowed', status: 400 }
  }
  const secret = readSecret(body)
  if (!secret) return { ok: false, error: 'secret required', status: 400 }
  if (looksLikeSecret(provider)) return { ok: false, error: 'provider not allowed', status: 400 }
  const needsAccount = provider === CF_ACCOUNT_PROVIDER || provider === 'cloudflare'
  const accountId = needsAccount && typeof body.accountId === 'string' ? body.accountId.trim() : undefined
  if (needsAccount && !accountId) {
    return { ok: false, error: 'accountId required', status: 400 }
  }
  if (isCloudflareVaultPaste(provider, accountId) && accountId) {
    const privacy = await verifyGatewayPrivacyForVault(secret, accountId, fetchImpl)
    if (!privacy.ok) return privacy
  }
  const label = labelFromBody(body, accountId || provider)
  const last4 = last4OfSecret(secret)
  const enc = await encryptVault(encodeVaultPlaintext(secret, accountId), env.OPERATOR_VAULT_KEY)
  const row: VaultKeyRow = {
    id: crypto.randomUUID(),
    provider,
    label,
    last4,
    cipher: enc.cipher,
    iv: enc.iv,
    status: 'active',
    created_at: now,
    created_by: email,
    rotated_at: null,
    revoked_at: null
  }
  return { ok: true, row }
}

export type VaultKeyWrite = { id: string; last4: string; status: string }

/** One 'vault-write' audit row's detail for every row this call writes, matching the single-row
 *  format (`provider ·last4`) exactly when there is only one. */
function vaultWriteAuditDetail(rows: VaultKeyRow[]): string {
  return rows.map((row) => `${row.provider} ·${row.last4}`).join(', ')
}

/** One 'vault' event's detail for every row this call writes, matching the single-row format
 *  (`write provider`) exactly when there is only one. */
function vaultWriteEventDetail(rows: VaultKeyRow[]): string {
  return `write ${rows.map((row) => row.provider).join(', ')}`
}

/** Writes several vault rows as one D1 transaction: every row is validated, privacy-checked and
 *  encrypted first, then all rows commit together with exactly one audit row and one event, or
 *  none of it does. Cloudflare provisioning uses this so a failure on the account row can never
 *  strand its gateway row (or vice versa) or a misleading audit/event without its rows; a
 *  single-row write (`writeVaultKey`) goes through here too, so there is exactly one persistence
 *  path. */
export async function writeVaultKeysAtomically(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  email: string,
  now: number,
  bodies: Record<string, unknown>[],
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; rows: VaultKeyWrite[] } | VaultKeyFailure> {
  const rows: VaultKeyRow[] = []
  for (const body of bodies) {
    const prepared = await prepareVaultKeyRow(env, email, now, body, fetchImpl)
    if (!prepared.ok) return prepared
    rows.push(prepared.row)
  }
  // Each row supersedes every other active row of its provider, including earlier rows in this
  // call, so exactly one active row per provider survives.
  await store.putVaultKeys(
    rows,
    { id: crypto.randomUUID(), ts: now, actor: email, detail: vaultWriteAuditDetail(rows) },
    {
      id: crypto.randomUUID(),
      ts: now,
      kind: 'vault',
      actor: email,
      device_id: null,
      country: null,
      detail: vaultWriteEventDetail(rows)
    }
  )
  return { ok: true, rows: rows.map((row) => ({ id: row.id, last4: row.last4, status: row.status })) }
}

export async function writeVaultKey(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  email: string,
  now: number,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; id: string; last4: string; status: string } | VaultKeyFailure> {
  const written = await writeVaultKeysAtomically(store, env, email, now, [body], fetchImpl)
  if (!written.ok) return written
  return { ok: true, ...written.rows[0] }
}

export async function rotateVaultKey(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  email: string,
  now: number,
  id: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; id: string; last4: string; status: string } | VaultKeyFailure> {
  if (!env.OPERATOR_VAULT_KEY) return { ok: false, error: 'vault key missing', status: 500 }
  const existing = await store.getVaultKey(id)
  if (!existing) return { ok: false, error: 'not found', status: 404 }
  if (existing.status === 'revoked') return { ok: false, error: 'revoked', status: 400 }
  const secret = readSecret(body)
  if (!secret) return { ok: false, error: 'secret required', status: 400 }
  const isCloudflareProvider = existing.provider === CF_ACCOUNT_PROVIDER || existing.provider === 'cloudflare'
  let accountId: string | undefined
  if (isCloudflareProvider) {
    try {
      const prev = decodeVaultPlaintext(await decryptVault(existing.cipher, existing.iv, env.OPERATOR_VAULT_KEY))
      accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : prev.accountId
    } catch {
      accountId = typeof body.accountId === 'string' ? body.accountId.trim() : undefined
    }
  }
  if (isCloudflareProvider && !accountId) {
    return { ok: false, error: 'accountId required', status: 400 }
  }
  if (isCloudflareVaultPaste(existing.provider, accountId) && accountId) {
    const privacy = await verifyGatewayPrivacyForVault(secret, accountId, fetchImpl)
    if (!privacy.ok) return privacy
  }
  const last4 = last4OfSecret(secret)
  const enc = await encryptVault(encodeVaultPlaintext(secret, accountId), env.OPERATOR_VAULT_KEY)
  await store.putVaultKey({
    ...existing,
    last4,
    cipher: enc.cipher,
    iv: enc.iv,
    status: 'active',
    rotated_at: now
  })
  await store.audit(crypto.randomUUID(), now, email, 'vault-rotate', null, `${existing.provider} ·${last4}`)
  await store.insertEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: 'vault',
    actor: email,
    device_id: null,
    country: null,
    detail: `rotate ${existing.provider}`
  })
  return { ok: true, id: existing.id, last4, status: 'active' }
}

export async function revokeVaultKey(
  store: OperatorStore,
  email: string,
  now: number,
  id: string
): Promise<{ ok: true; id: string; status: 'revoked' } | { ok: false; error: string; status: number }> {
  const existing = await store.getVaultKey(id)
  if (!existing) return { ok: false, error: 'not found', status: 404 }
  await store.putVaultKey({
    ...existing,
    status: 'revoked',
    revoked_at: now
  })
  // Belt and suspenders on top of the status flip: the ciphertext for a revoked key has no reason to
  // still exist.
  await store.clearVaultSecret(id)
  await store.audit(crypto.randomUUID(), now, email, 'vault-revoke', null, `${existing.provider} ·${existing.last4}`)
  await store.insertEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: 'vault',
    actor: email,
    device_id: null,
    country: null,
    detail: `revoke ${existing.provider}`
  })
  return { ok: true, id: existing.id, status: 'revoked' }
}

/** The one "provider not allowed for an Operator-funded call" guard shared by `/v1/ask` and `/v1/use`:
 *  only a catalogued HTTP provider can be called with a vaulted key, never a CLI, Dust or local one. */
export function operatorCallableProvider(provider: string): ProviderDef | null {
  const def = provider in PROVIDERS ? PROVIDERS[provider as ProviderId] : null
  if (!def || def.kind === 'cli' || def.kind === 'dust' || def.kind === 'local') return null
  return def
}

export async function fundedProviders(
  store: OperatorStore,
  seat?: SeatRow | null,
  now = Date.now()
): Promise<string[]> {
  if (seat && !(await seatAuthorizedForKeys(store, seat, now))) return []
  return fundedProvidersFromMeta(await store.listVaultMeta())
}

export async function activeCloudflareAccount(
  store: OperatorStore,
  vaultKey: string | undefined
): Promise<{ accountId: string; token: string } | null> {
  if (!vaultKey) return null
  const rows = await store.listVaultRows()
  const row = rows.find((r) => r.provider === CF_ACCOUNT_PROVIDER && r.status === 'active')
  if (!row) return null
  try {
    const plain = decodeVaultPlaintext(await decryptVault(row.cipher, row.iv, vaultKey))
    if (!plain.secret) return null
    return { accountId: plain.accountId || row.label, token: plain.secret }
  } catch {
    return null
  }
}

