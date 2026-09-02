import { decryptVault, encryptVault } from './crypto'
import { looksLikeSecret } from './redact'
import type { OperatorStore, VaultKeyMeta, VaultKeyRow } from './store'
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

export async function writeVaultKey(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  email: string,
  now: number,
  body: Record<string, unknown>
): Promise<{ ok: true; id: string; last4: string; status: string } | { ok: false; error: string; status: number }> {
  if (!env.OPERATOR_VAULT_KEY) return { ok: false, error: 'vault key missing', status: 500 }
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  if (!isVaultProvider(provider) || isForbiddenVaultProvider(provider)) {
    return { ok: false, error: 'provider not allowed', status: 400 }
  }
  const secret = readSecret(body)
  if (!secret) return { ok: false, error: 'secret required', status: 400 }
  if (looksLikeSecret(provider)) return { ok: false, error: 'provider not allowed', status: 400 }
  const accountId =
    provider === CF_ACCOUNT_PROVIDER && typeof body.accountId === 'string' ? body.accountId.trim() : undefined
  if (provider === CF_ACCOUNT_PROVIDER && !accountId) {
    return { ok: false, error: 'accountId required', status: 400 }
  }
  const label = labelFromBody(body, accountId || provider)
  const last4 = last4OfSecret(secret)
  const enc = await encryptVault(encodeVaultPlaintext(secret, accountId), env.OPERATOR_VAULT_KEY)
  const id = crypto.randomUUID()
  const row: VaultKeyRow = {
    id,
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
  await store.putVaultKey(row)
  await store.audit(crypto.randomUUID(), now, email, 'vault-write', null, `${provider} ·${last4}`)
  await store.insertEvent({
    id: crypto.randomUUID(),
    ts: now,
    kind: 'vault',
    actor: email,
    device_id: null,
    country: null,
    detail: `write ${provider}`
  })
  return { ok: true, id, last4, status: 'active' }
}

export async function rotateVaultKey(
  store: OperatorStore,
  env: { OPERATOR_VAULT_KEY?: string },
  email: string,
  now: number,
  id: string,
  body: Record<string, unknown>
): Promise<{ ok: true; id: string; last4: string; status: string } | { ok: false; error: string; status: number }> {
  if (!env.OPERATOR_VAULT_KEY) return { ok: false, error: 'vault key missing', status: 500 }
  const existing = await store.getVaultKey(id)
  if (!existing) return { ok: false, error: 'not found', status: 404 }
  if (existing.status === 'revoked') return { ok: false, error: 'revoked', status: 400 }
  const secret = readSecret(body)
  if (!secret) return { ok: false, error: 'secret required', status: 400 }
  let accountId: string | undefined
  if (existing.provider === CF_ACCOUNT_PROVIDER) {
    try {
      const prev = decodeVaultPlaintext(await decryptVault(existing.cipher, existing.iv, env.OPERATOR_VAULT_KEY))
      accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : prev.accountId
    } catch {
      accountId = typeof body.accountId === 'string' ? body.accountId.trim() : undefined
    }
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

export async function fundedProviders(store: OperatorStore): Promise<string[]> {
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

