/**
 * Microsoft Entra v2 ID-token verification for `POST /v1/enroll` (method `sso`).
 *
 * The desktop proves "this user signed in to the organisation's tenant" by presenting the ID token its
 * MSAL sign-in produced. The Worker never trusts any tenant or client id the device names: the tenant,
 * the accepted client ids and the accepted e-mail domains come only from Worker secrets
 * (`ENROLL_SSO_TENANT_ID`, `ENROLL_SSO_CLIENT_IDS`, `ENROLL_SSO_ALLOWED_DOMAINS`). A Graph access token
 * cannot be verified by a third party, so it is never accepted here.
 *
 * Checks, all of which must pass:
 *   - structure and `alg` exactly `RS256` (via `jwt-rs256.ts`), key chosen by `kid` from the tenant JWKS
 *     (`https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, cached 1 h; one forced refetch
 *     per isolate per 5 min for an unknown `kid`);
 *   - RS256 signature;
 *   - `iss` equals `https://login.microsoftonline.com/{tenant}/v2.0` and `tid` equals the tenant;
 *   - `aud` is one of the allowed client ids;
 *   - `exp` in the future, `nbf` no later than now + 60 s, `iat` present, not in the future beyond 60 s and
 *     no older than 10 minutes (freshness: a stolen older token is useless);
 *   - `oid` present, and the identity e-mail (`preferred_username`, else `email`) belongs to an allowed domain.
 *
 * Single use is the caller's job: this module returns `replayKey` (the `uti` claim, else `jti`, else the
 * SHA-256 of the token) and the route consumes it through `store.takeNonce`, after every other check and
 * after the request signature, so a malformed or badly signed request can never burn a real token.
 */
import { sha256Hex } from './crypto'
import {
  createJwksCache,
  findRsaKey,
  parseJwt,
  rs256Kid,
  verifyRs256Signature,
  type JwksCache,
  type JwksFetch
} from './jwt-rs256'

export const ENTRA_JWKS_TTL_MS = 60 * 60 * 1000
export const ENTRA_FORCED_REFETCH_MIN_MS = 5 * 60 * 1000
/** An ID token older than this is refused even if its `exp` is still ahead. */
export const ENTRA_MAX_IAT_AGE_SEC = 10 * 60
const CLOCK_SKEW_SEC = 60
const ENTRA_AUTHORITY = 'https://login.microsoftonline.com'

export interface EntraEnv {
  ENROLL_SSO_TENANT_ID?: string
  ENROLL_SSO_CLIENT_IDS?: string
  ENROLL_SSO_ALLOWED_DOMAINS?: string
}

export interface SsoConfig {
  tenantId: string
  clientIds: readonly string[]
  domains: readonly string[]
}

/** Why a token was refused. `sso-unavailable` means the issuer's keys could not be fetched (retry later),
 *  never that the token is bad. */
export type EntraFailCode = 'sso-invalid' | 'sso-tenant' | 'sso-domain' | 'sso-stale' | 'sso-unavailable'

export type EntraVerifyResult =
  | {
      ok: true
      oid: string
      email: string
      tid: string
      aud: string
      /** Single-use key for `store.takeNonce`; never the token itself. */
      replayKey: string
    }
  | { ok: false; code: EntraFailCode }

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

function splitList(raw: string | undefined): string[] {
  return Array.from(
    new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

/** Parse the three Worker secrets. Returns null (the route then answers `enroll-unconfigured`) when any
 *  is missing or malformed: a half-configured allowlist must never fall back to "accept anything". */
export function ssoConfigFromEnv(env: EntraEnv): SsoConfig | null {
  const tenantId = (env.ENROLL_SSO_TENANT_ID ?? '').trim().toLowerCase()
  if (!GUID_RE.test(tenantId)) return null
  const clientIds = splitList(env.ENROLL_SSO_CLIENT_IDS)
  if (clientIds.length === 0 || !clientIds.every((id) => GUID_RE.test(id))) return null
  const domains = splitList(env.ENROLL_SSO_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ''))
  if (domains.length === 0 || !domains.every((d) => DOMAIN_RE.test(d))) return null
  return { tenantId, clientIds, domains }
}

export function entraJwksUrl(tenantId: string): string {
  return `${ENTRA_AUTHORITY}/${tenantId}/discovery/v2.0/keys`
}

export function entraIssuer(tenantId: string): string {
  return `${ENTRA_AUTHORITY}/${tenantId}/v2.0`
}

/** Shared per-isolate JWKS cache. Tests pass their own through `opts.cache`. */
const sharedJwks: JwksCache = createJwksCache({
  ttlMs: ENTRA_JWKS_TTL_MS,
  forcedRefetchMinMs: ENTRA_FORCED_REFETCH_MIN_MS
})

export function clearEntraJwksCache(): void {
  sharedJwks.clear()
}

function emailDomain(email: string): string | null {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(email)
  return m ? m[1].toLowerCase() : null
}

function numericClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringClaim(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

export async function verifyEntraIdToken(
  token: string,
  cfg: SsoConfig,
  opts: { now: number; fetchImpl?: JwksFetch; cache?: JwksCache }
): Promise<EntraVerifyResult> {
  const cache = opts.cache ?? sharedJwks
  const parsed = parseJwt(token)
  if (!parsed) return { ok: false, code: 'sso-invalid' }
  const kid = rs256Kid(parsed.header)
  if (!kid) return { ok: false, code: 'sso-invalid' }

  const url = entraJwksUrl(cfg.tenantId)
  let keys = await cache.keys(url, opts.now, opts.fetchImpl)
  if (!keys) return { ok: false, code: 'sso-unavailable' }
  let key = findRsaKey(keys, kid)
  if (!key) {
    // An unknown kid is how an issuer rotates keys. One throttled refetch; still unknown means refuse.
    keys = await cache.refreshForUnknownKid(url, opts.now, opts.fetchImpl)
    key = keys ? findRsaKey(keys, kid) : null
    if (!key) return { ok: false, code: 'sso-invalid' }
  }
  if (!(await verifyRs256Signature(parsed, key))) return { ok: false, code: 'sso-invalid' }

  const claims = parsed.payload
  const nowSec = Math.floor(opts.now / 1000)

  // Tenant first: a validly signed token from another tenant is a different answer than a forged one.
  const tid = stringClaim(claims.tid)
  if (!tid || tid.toLowerCase() !== cfg.tenantId) return { ok: false, code: 'sso-tenant' }
  if (claims.iss !== entraIssuer(cfg.tenantId)) return { ok: false, code: 'sso-invalid' }
  const aud = stringClaim(claims.aud)
  if (!aud || !cfg.clientIds.includes(aud.toLowerCase())) return { ok: false, code: 'sso-invalid' }

  const exp = numericClaim(claims.exp)
  if (exp === null || nowSec >= exp) return { ok: false, code: 'sso-stale' }
  const nbf = numericClaim(claims.nbf)
  if (claims.nbf !== undefined && (nbf === null || nbf > nowSec + CLOCK_SKEW_SEC))
    return { ok: false, code: 'sso-invalid' }
  const iat = numericClaim(claims.iat)
  if (iat === null || iat > nowSec + CLOCK_SKEW_SEC) return { ok: false, code: 'sso-invalid' }
  if (nowSec - iat > ENTRA_MAX_IAT_AGE_SEC) return { ok: false, code: 'sso-stale' }

  const oid = stringClaim(claims.oid)
  if (!oid || !GUID_RE.test(oid)) return { ok: false, code: 'sso-invalid' }
  const rawEmail = stringClaim(claims.preferred_username, 320) ?? stringClaim(claims.email, 320)
  const email = rawEmail?.trim().toLowerCase() ?? null
  const domain = email ? emailDomain(email) : null
  if (!email || !domain || !cfg.domains.includes(domain)) return { ok: false, code: 'sso-domain' }

  const replayKey = stringClaim(claims.uti, 128) ?? stringClaim(claims.jti, 128) ?? (await sha256Hex(token))
  return { ok: true, oid: oid.toLowerCase(), email, tid: tid.toLowerCase(), aud: aud.toLowerCase(), replayKey }
}
