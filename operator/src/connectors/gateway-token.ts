/**
 * MCP gateway bearer token (plan D8/D10, task B3). Minted once per seat + connection pair, in the
 * heartbeat response and in `GET /v1/integrations` (a brokered row only), and presented by the seat on
 * every `POST /v1/mcp/:id` call as `Authorization: Bearer <token>`. Verified on every gateway call before
 * any upstream fetch (`gateway.ts`); the license, approval, tier entitlement and scope re-checks that
 * follow are `gateway.ts`'s job, not this module's - this module only proves "this token was minted by
 * this Worker, for this device and this connection, and has not expired".
 *
 * Not a JWT: no `alg` header, no third-party library, no alg-confusion surface. A fixed two-part
 * `base64url(JSON claims).base64url(HMAC-SHA256 signature)` format, closer to the skill-pack token
 * `crypto.ts#signSkillPack` already mints the same way.
 *
 * Key derivation: HKDF-SHA256 (RFC 5869) from `OPERATOR_INGEST_SECRET`, info string `"metis-gateway-v1"`,
 * a distinct sub-key rather than the raw ingest secret - a gateway token can never be replayed as, or
 * forged from, an ingest HMAC signature (`hmac.ts`) or vice versa, and rotating the ingest secret
 * invalidates every outstanding gateway token exactly as it invalidates every outstanding heartbeat
 * signature. Built from the same HMAC-SHA256 primitive `hmac.ts#hmacHex` already uses (`crypto.subtle`
 * `'HMAC'`), not SubtleCrypto's separate `'HKDF'` algorithm name - one fewer runtime-specific surface to
 * worry about matching between the Workers runtime and the Node test environment, for a two-call,
 * well-understood construction (HKDF-Extract then one HKDF-Expand block).
 *
 * Claims: `{ device, connection, iat, exp }`. `exp - iat` is always exactly `GATEWAY_TOKEN_TTL_MS`; a
 * caller cannot request a longer lifetime, and a seat refreshes its token on every heartbeat well before
 * the hour is up.
 */
import { bytesToB64url, b64urlToBytes } from '../crypto'
import { DEVICE_ID_RE } from '../hmac'

export const GATEWAY_TOKEN_INFO = 'metis-gateway-v1'
export const GATEWAY_TOKEN_TTL_MS = 60 * 60 * 1000

/** A connection id is a `crypto.randomUUID()` string minted by `routes/integrations.ts` - this is
 *  deliberately a little wider than a strict UUID pattern (same reasoning as `DEVICE_ID_RE`: room for a
 *  future id scheme without a breaking change) while still rejecting anything that could carry a
 *  newline, HTML, or an unbounded length into a D1 primary key or an audit row. */
const CONNECTION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

export interface GatewayTokenClaims {
  device: string
  connection: string
  iat: number
  exp: number
}

export type GatewayTokenResult =
  | { ok: true; claims: GatewayTokenClaims }
  | { ok: false; error: string; code: 'malformed' | 'bad-signature' | 'bad-claims' | 'expired' | 'not-yet-valid' }

const enc = new TextEncoder()

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource))
}

/** RFC 5869 HKDF-SHA256, one 32-byte output block (`length` is never asked for more than that here, so
 *  a second `T(2)` block is never needed). Zero salt (32 zero bytes, `HashLen` per the RFC when the
 *  caller supplies none - here nobody ever will, `OPERATOR_INGEST_SECRET` is itself high-entropy). */
async function hkdfSha256(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const salt = new Uint8Array(32)
  const prk = await hmacSha256(salt, ikm)
  const infoBytes = enc.encode(info)
  const t1Input = new Uint8Array(infoBytes.length + 1)
  t1Input.set(infoBytes, 0)
  t1Input[infoBytes.length] = 1
  const t1 = await hmacSha256(prk, t1Input)
  return t1.slice(0, length)
}

async function deriveGatewayKey(secret: string): Promise<CryptoKey> {
  const keyBytes = await hkdfSha256(enc.encode(secret), GATEWAY_TOKEN_INFO, 32)
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function mintGatewayToken(secret: string, device: string, connection: string, now: number): Promise<string> {
  const claims: GatewayTokenClaims = { device, connection, iat: now, exp: now + GATEWAY_TOKEN_TTL_MS }
  const payloadB64 = bytesToB64url(enc.encode(JSON.stringify(claims)))
  const key = await deriveGatewayKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64) as BufferSource))
  return `${payloadB64}.${bytesToB64url(sig)}`
}

function validClaimsShape(value: unknown): value is GatewayTokenClaims {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.device === 'string' &&
    DEVICE_ID_RE.test(c.device) &&
    typeof c.connection === 'string' &&
    CONNECTION_ID_RE.test(c.connection) &&
    typeof c.iat === 'number' &&
    Number.isFinite(c.iat) &&
    typeof c.exp === 'number' &&
    Number.isFinite(c.exp) &&
    c.exp > c.iat
  )
}

/** A small forward skew tolerance for `iat` only (clock drift between this Worker instance and the one
 *  that minted the token, e.g. right after a deploy) - `exp` gets none: an expired token is expired, full
 *  stop, no grace window a replayed old token could ride. */
const CLOCK_SKEW_MS = 5000

export async function verifyGatewayToken(secret: string, token: string, now: number): Promise<GatewayTokenResult> {
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'malformed gateway token', code: 'malformed' }
  }
  const [payloadB64, sigB64] = parts
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)))
  } catch {
    return { ok: false, error: 'malformed gateway token', code: 'malformed' }
  }
  if (!validClaimsShape(claims)) {
    return { ok: false, error: 'malformed gateway token claims', code: 'bad-claims' }
  }
  let expectedSig: Uint8Array
  let providedSig: Uint8Array
  try {
    const key = await deriveGatewayKey(secret)
    expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64) as BufferSource))
    providedSig = b64urlToBytes(sigB64)
  } catch {
    return { ok: false, error: 'malformed gateway token', code: 'malformed' }
  }
  if (!timingSafeEqualBytes(expectedSig, providedSig)) {
    return { ok: false, error: 'bad gateway token signature', code: 'bad-signature' }
  }
  if (now > claims.exp) {
    return { ok: false, error: 'gateway token expired', code: 'expired' }
  }
  if (now + CLOCK_SKEW_MS < claims.iat) {
    return { ok: false, error: 'gateway token not yet valid', code: 'not-yet-valid' }
  }
  return { ok: true, claims }
}
