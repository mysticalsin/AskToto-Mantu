/**
 * Operator-issued seat license (METIS-OP-1).
 * HMAC-SHA256 with OPERATOR_INGEST_SECRET. Not the Fly ATK- / JWS product.
 */

export const OPERATOR_LICENSE_PREFIX = 'METIS-OP-1'
export const OPERATOR_LICENSE_MAX = 200
export const OPERATOR_LICENSE_DAYS = [1, 7, 30, 90, 365] as const

export type OperatorLicenseClaims = {
  jti: string
  iat: number
  exp: number
}

export type OperatorLicenseParsed = OperatorLicenseClaims & { sig: string }

export type OperatorLicenseFail = { ok: false; error: 'invalid' | 'expired' }
export type OperatorLicenseOk = { ok: true; claims: OperatorLicenseClaims }

const enc = new TextEncoder()

export function isOperatorLicenseKey(key: string): boolean {
  return key.trim().startsWith(`${OPERATOR_LICENSE_PREFIX}.`)
}

export function operatorLicenseCanonical(jti: string, iat: number, exp: number): string {
  return `${OPERATOR_LICENSE_PREFIX}.${jti}.${iat}.${exp}`
}

/**
 * Domain separator for the per-seat ingest key derived from a license token.
 *
 * A seat used to need OPERATOR_INGEST_SECRET -- the Worker's own signing secret -- pasted into
 * Settings before it could talk to the Operator at all, which made a license key on its own useless:
 * there was no way to activate a seat with the thing generated for it. Every seat also shared one
 * secret, so any seat could sign a heartbeat claiming any other seat's license id.
 *
 * Both problems go away if the license IS the credential. The token's signature is a deterministic
 * HMAC over `jti.iat.exp` (see `generateOperatorLicense`), and the Worker stores those three claims,
 * so it can rebuild the exact token from its own secret and derive the same key the seat did. The
 * seat only ever holds its own token, and can therefore only ever sign as itself.
 *
 * Keyed with the token and messaged with this constant, rather than the reverse: the token is the
 * secret here, and the constant is the label saying what the derived key is for.
 */
export const OPERATOR_SEAT_KEY_INFO = 'metis-seat-key-v1'

export function parseOperatorLicenseDays(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 365) return null
  return n
}

export function parseLicenseId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return /^[a-f0-9]{16}$/.test(v) ? v : null
}

export function operatorLicenseLast4(token: string): string {
  const alnum = token.replace(/[^a-zA-Z0-9]/g, '')
  return alnum.slice(-4)
}

export function parseOperatorLicense(token: string): OperatorLicenseParsed | null {
  const raw = token.trim()
  if (!raw || raw.length > OPERATOR_LICENSE_MAX) return null
  const parts = raw.split('.')
  if (parts.length !== 5) return null
  const [prefix, jti, iatRaw, expRaw, sig] = parts
  if (prefix !== OPERATOR_LICENSE_PREFIX) return null
  if (!/^[a-f0-9]{16}$/.test(jti)) return null
  if (!/^[A-Za-z0-9_-]{20,86}$/.test(sig)) return null
  const iat = Number(iatRaw)
  const exp = Number(expRaw)
  if (!Number.isInteger(iat) || !Number.isInteger(exp) || exp <= iat) return null
  return { jti, iat, exp, sig }
}

export function bytesToB64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function hmacSha256B64url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return bytesToB64url(sig)
}

export function newLicenseJti(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateOperatorLicense(
  secret: string,
  opts: { days: number; now?: number; jti?: string }
): Promise<{ token: string; claims: OperatorLicenseClaims; last4: string; days: number }> {
  const days = parseOperatorLicenseDays(opts.days)
  if (!days) throw new Error('days must be 1-365')
  if (!secret.trim()) throw new Error('missing operator ingest secret')
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000)
  const claims: OperatorLicenseClaims = {
    jti: (opts.jti || newLicenseJti()).toLowerCase(),
    iat: nowSec,
    exp: nowSec + days * 24 * 60 * 60
  }
  const canonical = operatorLicenseCanonical(claims.jti, claims.iat, claims.exp)
  const sig = await hmacSha256B64url(secret, canonical)
  const token = `${canonical}.${sig}`
  return { token, claims, last4: operatorLicenseLast4(token), days }
}

/**
 * Rebuild the exact token that was handed out for a set of stored claims.
 *
 * The signature is a deterministic HMAC over `jti.iat.exp` and nothing else, and `issued_licenses`
 * stores all three, so the Worker can reproduce a token it never kept a copy of. That is what lets
 * a license act as its own credential: the seat holds the token, the Worker can re-derive it, and
 * both sides reach the same per-seat key without the token or the ingest secret crossing the wire.
 *
 * Callers must confirm the result against the stored `key_hash` before trusting it -- see
 * `seatKeyForLicense` in operator/src/licenses/seat-key.ts.
 */
export async function rebuildOperatorLicenseToken(
  secret: string,
  claims: OperatorLicenseClaims
): Promise<string> {
  const canonical = operatorLicenseCanonical(claims.jti, claims.iat, claims.exp)
  return `${canonical}.${await hmacSha256B64url(secret, canonical)}`
}

/**
 * The per-seat ingest key derived from a license token, as hex.
 *
 * WebCrypto side (Worker). The desktop computes the identical bytes with node:crypto in
 * src/main/operator-hmac-sign.ts; operator/src/seat-key.parity.test.ts proves the two agree, which
 * is the property the whole scheme rests on.
 */
export async function operatorSeatKeyFromLicense(token: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(OPERATOR_SEAT_KEY_INFO)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyOperatorLicense(
  secret: string,
  token: string,
  now = Date.now()
): Promise<OperatorLicenseOk | OperatorLicenseFail> {
  const parsed = parseOperatorLicense(token)
  if (!parsed || !secret.trim()) return { ok: false, error: 'invalid' }
  const canonical = operatorLicenseCanonical(parsed.jti, parsed.iat, parsed.exp)
  const expected = await hmacSha256B64url(secret, canonical)
  if (!timingSafeEqualStr(expected, parsed.sig)) return { ok: false, error: 'invalid' }
  if (parsed.exp * 1000 <= now) return { ok: false, error: 'expired' }
  return { ok: true, claims: { jti: parsed.jti, iat: parsed.iat, exp: parsed.exp } }
}
