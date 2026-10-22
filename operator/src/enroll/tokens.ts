/**
 * Enrolment tokens (O03). A token is a revocable, enrolment-scope-only credential that a release build
 * embeds so a signed-out install can still report. It is treated as PUBLIC: an installer can be unpacked,
 * so the token is worth very little by design. It can only call `POST /v1/enroll`, only mints 30-day
 * `reporting` licences (no entitlements), is capped per token (devices total, enrolments per UTC day) and
 * rate limited, is bound to one channel (a `qa` or `staging` token is refused by the production Worker),
 * and is revoked from the console, optionally together with every licence it minted.
 *
 * Wire format: `METIS-ENR-1.<kid: 16 hex>.<secret: 43 base64url (256 bits)>`. Only `sha256(secret)` is
 * stored. The kid is a public row id (safe in audit text); the secret is shown exactly once, at creation.
 * The request is signed with HMAC keyed by the whole token string, so the signature gives integrity,
 * freshness and nonce replay protection, but not secrecy (same model as a per-device licence).
 */
import { sha256Hex } from '../crypto'
import { timingSafeEqualHex } from '../hmac'
import type { EnrollTokenRow, OperatorStore } from '../store'

export const ENROLL_TOKEN_PREFIX = 'METIS-ENR-1'
export const ENROLL_TOKEN_HEADER = 'x-metis-enroll'
export const ENROLL_CHANNELS = ['release', 'qa', 'staging'] as const
export type EnrollChannel = (typeof ENROLL_CHANNELS)[number]

/** An auto-enrolled licence never outlives this, whatever a hand-edited row says. */
export const TOKEN_LICENSE_MAX_DAYS = 30
export const ENROLL_TOKEN_TIER = 'reporting'

export const DEFAULT_TOKEN_EXPIRES_DAYS = 180
export const DEFAULT_TOKEN_MAX_DEVICES = 5000
export const DEFAULT_TOKEN_DAILY_CAP = 500

const TOKEN_RE = /^METIS-ENR-1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/
const DAY_MS = 24 * 60 * 60 * 1000

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

/** The channel this Worker honours. `OPERATOR_ENV` unset or `production` is the `release` channel. */
export function workerChannel(env: { OPERATOR_ENV?: string }): EnrollChannel {
  const v = (env.OPERATOR_ENV ?? '').trim().toLowerCase()
  return v === 'staging' || v === 'qa' ? v : 'release'
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function newEnrollToken(): { kid: string; secret: string; token: string } {
  const kidBytes = new Uint8Array(8)
  crypto.getRandomValues(kidBytes)
  const kid = [...kidBytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const secretBytes = new Uint8Array(32)
  crypto.getRandomValues(secretBytes)
  const secret = b64url(secretBytes)
  return { kid, secret, token: `${ENROLL_TOKEN_PREFIX}.${kid}.${secret}` }
}

export function parseEnrollToken(raw: string | null | undefined): { kid: string; secret: string } | null {
  const m = TOKEN_RE.exec((raw ?? '').trim())
  return m ? { kid: m[1], secret: m[2] } : null
}

export type EnrollTokenAuth =
  | { ok: true; row: EnrollTokenRow }
  | { ok: false; code: 'token-invalid' | 'token-revoked' | 'token-expired' }

const DUMMY_HASH = '0'.repeat(64)

/** Authenticity first (kid + secret hash + channel, all answered as one `token-invalid` so a probe learns
 *  nothing about which part failed), then lifecycle. Caps are checked later, atomically, by
 *  `store.claimEnrollTokenSlot`. */
export async function authenticateEnrollToken(
  store: Pick<OperatorStore, 'getEnrollToken'>,
  raw: string | null | undefined,
  env: { OPERATOR_ENV?: string },
  now: number
): Promise<EnrollTokenAuth> {
  const parsed = parseEnrollToken(raw)
  if (!parsed) return { ok: false, code: 'token-invalid' }
  const row = await store.getEnrollToken(parsed.kid)
  const presented = await sha256Hex(parsed.secret)
  // Compare even when the row is missing, so a miss and a bad secret take the same path.
  const hashOk = timingSafeEqualHex(row?.secret_hash ?? DUMMY_HASH, presented)
  if (!row || !hashOk || row.channel !== workerChannel(env)) return { ok: false, code: 'token-invalid' }
  if (row.revoked_at !== null) return { ok: false, code: 'token-revoked' }
  if (row.expires_at <= now) return { ok: false, code: 'token-expired' }
  return { ok: true, row }
}

export interface CreateEnrollTokenInput {
  label: unknown
  channel: unknown
  expiresInDays?: unknown
  maxDevices?: unknown
  dailyCap?: unknown
}

function boundedInt(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === null) return fallback
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null
}

export function cleanTokenLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const label = raw.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim()
  return label.length >= 1 && label.length <= 64 ? label : null
}

export type CreateEnrollTokenResult =
  | { ok: true; row: EnrollTokenRow; token: string }
  | { ok: false; error: string; status: number }

/** Validates, stores the hash, and returns the once-only token string. Tier and licence days are not
 *  inputs: a token can only ever mint 30-day `reporting` licences. */
export async function createEnrollToken(
  store: Pick<OperatorStore, 'putEnrollToken'>,
  input: CreateEnrollTokenInput,
  actor: string,
  now: number
): Promise<CreateEnrollTokenResult> {
  const label = cleanTokenLabel(input.label)
  if (!label) return { ok: false, error: 'label must be 1-64 characters', status: 400 }
  if (typeof input.channel !== 'string' || !(ENROLL_CHANNELS as readonly string[]).includes(input.channel)) {
    return { ok: false, error: 'channel must be release, qa or staging', status: 400 }
  }
  const expiresDays = boundedInt(input.expiresInDays, DEFAULT_TOKEN_EXPIRES_DAYS, 1, 365)
  if (expiresDays === null) return { ok: false, error: 'expiresInDays must be 1-365', status: 400 }
  const maxDevices = boundedInt(input.maxDevices, DEFAULT_TOKEN_MAX_DEVICES, 1, 100_000)
  if (maxDevices === null) return { ok: false, error: 'maxDevices must be 1-100000', status: 400 }
  const dailyCap = boundedInt(input.dailyCap, DEFAULT_TOKEN_DAILY_CAP, 1, 100_000)
  if (dailyCap === null) return { ok: false, error: 'dailyCap must be 1-100000', status: 400 }
  const minted = newEnrollToken()
  const row: EnrollTokenRow = {
    kid: minted.kid,
    secret_hash: await sha256Hex(minted.secret),
    label,
    channel: input.channel,
    tier: ENROLL_TOKEN_TIER,
    license_days: TOKEN_LICENSE_MAX_DAYS,
    max_devices: maxDevices,
    daily_cap: dailyCap,
    enrolled_count: 0,
    created_at: now,
    created_by: actor,
    expires_at: now + expiresDays * DAY_MS,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null
  }
  await store.putEnrollToken(row)
  return { ok: true, row, token: minted.token }
}

export type EnrollTokenStatus = 'active' | 'revoked' | 'expired'

export function enrollTokenStatus(
  row: Pick<EnrollTokenRow, 'revoked_at' | 'expires_at'>,
  now: number
): EnrollTokenStatus {
  if (row.revoked_at !== null) return 'revoked'
  return row.expires_at <= now ? 'expired' : 'active'
}

/** The console view of a token: never the hash, never the secret. */
export function enrollTokenView(row: EnrollTokenRow, enrolledToday: number, now: number) {
  return {
    kid: row.kid,
    label: row.label,
    channel: row.channel,
    tier: row.tier,
    licenseDays: row.license_days,
    maxDevices: row.max_devices,
    dailyCap: row.daily_cap,
    enrolledCount: row.enrolled_count,
    enrolledToday,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    status: enrollTokenStatus(row, now),
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason
  }
}
