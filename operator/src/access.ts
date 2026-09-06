import { hmacHex, timingSafeEqualHex } from './hmac'

export const ADMIN_EMAILS = ['tony.walteur@gmail.com', 'twalteur@amaris.com'] as const

export const SESSION_COOKIE = 'metis_operator_session'

export const CONSOLE_PATHS = [
  '/',
  '/keys',
  '/licenses',
  '/devices',
  '/map',
  '/cloudflare',
  '/cloudflare/connect',
  '/cloudflare/callback',
  '/overview',
  '/events',
  '/profiles',
  '/realtime',
  '/macos',
  '/windows',
  '/skills',
  '/notifications',
  '/rules',
  '/pushes',
  '/users',
  '/login',
  '/dashboards',
  '/insights',
  '/pages',
  '/seo',
  '/sessions',
  '/groups',
  '/cohorts',
  '/settings',
  '/references',
  '/notifications',
  '/session',
  '/connectors',
  '/audit'
] as const

/** Paths Cloudflare Access must Bypass (Service Auth / Everyone Bypass policies).
 *  Worker auth is HMAC (or public health/assets). Keep Zero Trust Bypass policies in sync. */
export const ACCESS_BYPASS_PATHS = [
  '/health',
  '/v1/ingest',
  '/v1/heartbeat',
  '/v1/use',
  '/v1/skills/manifest',
  '/v1/integrations',
  '/assets/*'
] as const

export type AccessCtx = {
  access?: { getIdentity: () => Promise<{ email?: string } | null | undefined> }
}

export type AdminEnv = {
  TEAM_DOMAIN?: string
  POLICY_AUD?: string
  OPERATOR_PROMPT_KEY?: string
  OPERATOR_SESSION_SECRET?: string
}

export type IdentityResult =
  | { status: 'ok'; email: string; sessionIat?: number }
  | { status: 'none' }
  | { status: 'denied' }
  | { status: 'misconfigured'; error: string }

export function normalizeAdminEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isAdminEmail(raw: string): boolean {
  return (ADMIN_EMAILS as readonly string[]).includes(normalizeAdminEmail(raw))
}

export function isConsolePath(pathname: string): boolean {
  return (CONSOLE_PATHS as readonly string[]).includes(pathname)
}

export function isAdminApiPath(pathname: string): boolean {
  return pathname.startsWith('/v1/admin')
}

/** JSON 401 only for /v1/* or Accept: application/json (no HTML preferred). */
export function wantsJson(request: Request): boolean {
  const path = new URL(request.url).pathname
  if (path.startsWith('/v1/')) return true
  const accept = (request.headers.get('accept') || '').toLowerCase()
  if (!accept.includes('application/json')) return false
  if (!accept.includes('text/html')) return true
  return accept.indexOf('application/json') < accept.indexOf('text/html')
}

export function accessTeamDomain(raw?: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'https:') return null
    if (!u.hostname.endsWith('.cloudflareaccess.com')) return null
    if (u.hostname === 'cloudflareaccess.com') return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

export function accessLoginLocation(request: Request, teamDomain: string): string {
  const url = new URL(request.url)
  const login = new URL(`${teamDomain}/cdn-cgi/access/login/${url.host}`)
  login.searchParams.set('redirect_url', url.toString())
  login.searchParams.set('next', url.pathname)
  return login.toString()
}

export function accessMisconfigured(error: string): Response {
  return Response.json({ ok: false, error }, { status: 503 })
}

export function redirectToAccess(request: Request, env: AdminEnv): Response {
  const team = accessTeamDomain(env.TEAM_DOMAIN)
  if (!team) {
    return accessMisconfigured('Cloudflare Access is misconfigured: TEAM_DOMAIN is unset')
  }
  return new Response(null, { status: 302, headers: { Location: accessLoginLocation(request, team) } })
}

/** A session token is valid for at most this long since it was minted. */
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000
/** The console only re-mints (rotates `iat` and re-sends `Set-Cookie`) when the current token has been
 *  alive longer than this, so an active tab is not writing a fresh cookie on every single request. */
export const SESSION_REMINT_AFTER_MS = 60 * 60 * 1000
const SESSION_HKDF_INFO = 'metis-operator-session'

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Derive the session-signing secret from `OPERATOR_PROMPT_KEY` via HKDF-SHA256 so the session cookie
 * never shares key material with prompt encryption, even though both start from the same bound secret.
 * `OPERATOR_SESSION_SECRET`, when an operator sets one, always wins.
 */
export async function deriveSessionSecret(env: AdminEnv): Promise<string | undefined> {
  const explicit = env.OPERATOR_SESSION_SECRET?.trim()
  if (explicit) return explicit
  const raw = env.OPERATOR_PROMPT_KEY?.trim()
  if (!raw) return undefined
  let keyMaterial: Uint8Array
  try {
    keyMaterial = base64ToBytes(raw)
  } catch {
    keyMaterial = new TextEncoder().encode(raw)
  }
  const key = await crypto.subtle.importKey('raw', keyMaterial as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(SESSION_HKDF_INFO) },
    key,
    256
  )
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

function looksLikeJwt(raw: string | null | undefined): raw is string {
  return Boolean(raw && raw.split('.').length === 3)
}

/** CF Access JWT from the assertion header or the CF_Authorization session cookie. */
export function accessJwtFromRequest(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion')?.trim()
  if (looksLikeJwt(header)) return header
  const authorization = cookieValue(request, 'CF_Authorization')
  if (looksLikeJwt(authorization)) return authorization
  const appSession = cookieValue(request, 'CF_AppSession')
  if (looksLikeJwt(appSession)) return appSession
  return null
}

/** `now` is the token's `iat`; pass the original `iat` back in to re-derive the same token deterministically
 *  without rotating the session clock, or the current time to mint (or rotate) a fresh one. */
export async function mintSessionToken(email: string, iat: number, secret: string): Promise<string> {
  const payload = `v1|${iat}|${normalizeAdminEmail(email)}`
  const sig = await hmacHex(secret, `metis-operator-session:${payload}`)
  return `${payload}|${sig}`
}

export function sessionCookieHeader(token: string, now: number): string {
  const iat = Number(token.split('|')[1])
  const remaining = (Number.isFinite(iat) ? iat : now) + SESSION_ABSOLUTE_TTL_MS - now
  const maxAge = Math.max(0, Math.floor(remaining / 1000))
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

export async function mintSessionCookie(email: string, now: number, secret: string): Promise<string> {
  return sessionCookieHeader(await mintSessionToken(email, now, secret), now)
}

export function sessionTokenFromRequest(request: Request): string | null {
  const auth = (request.headers.get('authorization') || '').trim()
  const bearer = /^Bearer\s+(\S+)/i.exec(auth)
  if (bearer?.[1]) {
    try {
      return decodeURIComponent(bearer[1])
    } catch {
      return bearer[1]
    }
  }
  return cookieValue(request, SESSION_COOKIE)
}

export type VerifiedSession = { email: string; iat: number }

export async function verifySessionToken(
  raw: string | null | undefined,
  secret: string | undefined,
  now: number
): Promise<VerifiedSession | null> {
  if (!secret?.trim() || !raw) return null
  const parts = raw.split('|')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  const iat = Number(parts[1])
  const email = normalizeAdminEmail(parts[2] || '')
  const sig = (parts[3] || '').toLowerCase()
  if (!Number.isFinite(iat) || now < iat || now - iat > SESSION_ABSOLUTE_TTL_MS || !isAdminEmail(email) || !sig) {
    return null
  }
  const expected = await hmacHex(secret, `metis-operator-session:v1|${iat}|${email}`)
  if (!timingSafeEqualHex(expected, sig)) return null
  return { email, iat }
}

export async function verifySessionCookie(
  request: Request,
  secret: string | undefined,
  now: number
): Promise<VerifiedSession | null> {
  return verifySessionToken(sessionTokenFromRequest(request), secret, now)
}

export async function resolveAdminIdentity(
  request: Request,
  ctx: AccessCtx,
  env: AdminEnv,
  now = Date.now()
): Promise<IdentityResult> {
  if (ctx.access) {
    try {
      const identity = await ctx.access.getIdentity()
      const email = identity?.email?.trim().toLowerCase()
      if (email) {
        if (isAdminEmail(email)) return { status: 'ok', email }
        return { status: 'denied' }
      }
    } catch {
      /* fall through to JWT / minted session */
    }
  }
  const jwt = accessJwtFromRequest(request)
  if (jwt) {
    if (!accessTeamDomain(env.TEAM_DOMAIN)) {
      return { status: 'misconfigured', error: 'Cloudflare Access is misconfigured: TEAM_DOMAIN is unset' }
    }
    if (!env.POLICY_AUD?.trim()) {
      return { status: 'misconfigured', error: 'Cloudflare Access is misconfigured: POLICY_AUD is unset' }
    }
    const email = await verifyAccessJwt(jwt, accessTeamDomain(env.TEAM_DOMAIN)!, env.POLICY_AUD.trim(), now)
    if (email && isAdminEmail(email)) return { status: 'ok', email }
  }
  const session = await verifySessionCookie(request, await deriveSessionSecret(env), now)
  if (session) return { status: 'ok', email: session.email, sessionIat: session.iat }
  if (jwt) return { status: 'denied' }
  return { status: 'none' }
}

/** Cloudflare Access certs, cached per isolate so an admin click does not re-fetch the JWKS every time. */
const JWKS_TTL_MS = 5 * 60 * 1000
type Jwk = { kid?: string; kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string }
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>()

function b64urlToString(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
}

async function fetchJwks(teamDomain: string, now: number): Promise<Jwk[] | null> {
  const base = teamDomain.replace(/\/$/, '')
  const cached = jwksCache.get(base)
  if (cached && now - cached.at < JWKS_TTL_MS) return cached.keys
  const res = await fetch(`${base}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) return null
  const jwks = (await res.json()) as { keys?: Jwk[] }
  const keys = Array.isArray(jwks.keys) ? jwks.keys : []
  jwksCache.set(base, { at: now, keys })
  return keys
}

/**
 * Verify a Cloudflare Access application token: RS256 signature against the team JWKS, then the claims
 * Access itself documents as mandatory. `exp` is required and must be in the future, `nbf` (when present)
 * in the past, and `iss` must be the team domain. Any claim failing closes the door; this fallback exists
 * for the JWT header/cookie path only and is never weaker than the `ctx.access` binding check.
 */
export async function verifyAccessJwt(token: string, teamDomain: string, aud: string, now = Date.now()): Promise<string | null> {
  try {
    const keys = await fetchJwks(teamDomain, now)
    if (!keys) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = JSON.parse(b64urlToString(parts[0])) as { kid?: string; alg?: string }
    if (header.alg !== 'RS256') return null
    const key = keys.find((k) => k.kid === header.kid)
    if (!key) return null
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const sig = Uint8Array.from(b64urlToString(parts[2]), (c) => c.charCodeAt(0))
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data)
    if (!ok) return null
    const payload = JSON.parse(b64urlToString(parts[1])) as {
      aud?: string | string[]
      email?: string
      identity?: { email?: string }
      exp?: unknown
      nbf?: unknown
      iss?: unknown
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!audiences.includes(aud)) return null
    const nowSec = Math.floor(now / 1000)
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowSec >= payload.exp) return null
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || nowSec < payload.nbf)) return null
    const expectedIss = teamDomain.replace(/\/$/, '')
    if (typeof payload.iss !== 'string' || payload.iss.replace(/\/$/, '') !== expectedIss) return null
    return payload.email?.trim().toLowerCase() || payload.identity?.email?.trim().toLowerCase() || null
  } catch {
    return null
  }
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: 'Access required' }, { status: 401 })
}
