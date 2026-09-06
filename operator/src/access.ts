export const ADMIN_EMAILS = ['tony.walteur@gmail.com', 'twalteur@amaris.com'] as const

export type AccessCtx = {
  access?: { getIdentity: () => Promise<{ email?: string } | null | undefined> }
}

/** Cloudflare Access certs, cached per isolate so an admin click does not re-fetch the JWKS every time. */
const JWKS_TTL_MS = 5 * 60 * 1000
type Jwk = { kid?: string; kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string }
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>()

export async function adminIdentity(
  request: Request,
  ctx: AccessCtx,
  env: { TEAM_DOMAIN?: string; POLICY_AUD?: string },
  now = Date.now()
): Promise<{ email: string } | null> {
  if (ctx.access) {
    try {
      const identity = await ctx.access.getIdentity()
      const email = identity?.email?.trim().toLowerCase()
      if (email && (ADMIN_EMAILS as readonly string[]).includes(email)) return { email }
    } catch {
      /* fall through to JWT */
    }
  }
  const jwt = request.headers.get('cf-access-jwt-assertion')
  if (jwt && env.TEAM_DOMAIN && env.POLICY_AUD) {
    const email = await verifyAccessJwt(jwt, env.TEAM_DOMAIN, env.POLICY_AUD, now)
    if (email && (ADMIN_EMAILS as readonly string[]).includes(email)) return { email }
  }
  return null
}

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
 * Verify a Cloudflare Access application token: RS256 signature against the team JWKS, then the
 * claims Access itself documents as mandatory. `exp` is required and must be in the future, `nbf`
 * (when present) in the past, and `iss` must be the team domain. Any claim failing closes the door;
 * the fallback exists for the JWT header path only and is never weaker than the binding check.
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
    return payload.email?.trim().toLowerCase() ?? null
  } catch {
    return null
  }
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: 'Access required' }, { status: 401 })
}
