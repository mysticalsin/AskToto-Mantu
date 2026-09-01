import { sha256Hex } from './crypto'
import { hmacHex, timingSafeEqualHex } from './hmac'

export const ADMIN_EMAILS = ['tony.walteur@gmail.com', 'twalteur@amaris.com'] as const

export const SESSION_COOKIE = 'metis_operator_session'
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

export type AccessCtx = {
  access?: { getIdentity: () => Promise<{ email?: string } | null | undefined> }
}

export type AdminEnv = {
  TEAM_DOMAIN?: string
  POLICY_AUD?: string
  OPERATOR_ADMIN_PASSWORD?: string
}

export function normalizeAdminEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isAdminEmail(raw: string): boolean {
  return (ADMIN_EMAILS as readonly string[]).includes(normalizeAdminEmail(raw))
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

export async function passwordMatches(given: string, secret: string): Promise<boolean> {
  const a = await sha256Hex(given || '\0')
  const b = await sha256Hex(secret || '\0')
  return Boolean(given) && Boolean(secret) && timingSafeEqualHex(a, b)
}

export async function mintSessionCookie(email: string, secret: string, now: number): Promise<string> {
  const exp = now + SESSION_TTL_MS
  const norm = normalizeAdminEmail(email)
  const sig = await hmacHex(secret, `${norm}.${exp}`)
  const value = `${encodeURIComponent(norm)}.${exp}.${sig}`
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function emailFromSessionCookie(
  request: Request,
  secret: string,
  now: number
): Promise<string | null> {
  if (!secret) return null
  const raw = cookieValue(request, SESSION_COOKIE)
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const email = normalizeAdminEmail(decodeURIComponent(parts[0] || ''))
  const exp = Number(parts[1])
  const sig = parts[2] || ''
  if (!isAdminEmail(email) || !Number.isFinite(exp) || exp <= now) return null
  const expected = await hmacHex(secret, `${email}.${exp}`)
  if (!timingSafeEqualHex(sig, expected)) return null
  return email
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || ''
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() !== name) continue
    return part.slice(i + 1).trim()
  }
  return null
}

export async function adminIdentity(
  request: Request,
  ctx: AccessCtx,
  env: AdminEnv,
  now = Date.now()
): Promise<{ email: string } | null> {
  if (ctx.access) {
    try {
      const identity = await ctx.access.getIdentity()
      const email = identity?.email?.trim().toLowerCase()
      if (email && isAdminEmail(email)) return { email }
    } catch {
      /* fall through */
    }
  }
  const jwt = request.headers.get('cf-access-jwt-assertion')
  if (jwt && env.TEAM_DOMAIN && env.POLICY_AUD) {
    const email = await verifyAccessJwt(jwt, env.TEAM_DOMAIN, env.POLICY_AUD)
    if (email && isAdminEmail(email)) return { email }
  }
  if (env.OPERATOR_ADMIN_PASSWORD) {
    const email = await emailFromSessionCookie(request, env.OPERATOR_ADMIN_PASSWORD, now)
    if (email) return { email }
  }
  return null
}

async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<string | null> {
  try {
    const url = `${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`
    const res = await fetch(url)
    if (!res.ok) return null
    const jwks = (await res.json()) as { keys?: { kid?: string; kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string }[] }
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))) as { kid?: string; alg?: string }
    const key = jwks.keys?.find((k) => k.kid === header.kid)
    if (!key) return null
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const sig = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0)
    )
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data)
    if (!ok) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      aud?: string | string[]
      email?: string
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!audiences.includes(aud)) return null
    return payload.email?.trim().toLowerCase() ?? null
  } catch {
    return null
  }
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: 'Access required' }, { status: 401 })
}
