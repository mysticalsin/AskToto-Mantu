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
  '/notifications'
] as const

export type AccessCtx = {
  access?: { getIdentity: () => Promise<{ email?: string } | null | undefined> }
}

export type AdminEnv = {
  TEAM_DOMAIN?: string
  POLICY_AUD?: string
}

export type IdentityResult =
  | { status: 'ok'; email: string }
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

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function resolveAdminIdentity(
  request: Request,
  ctx: AccessCtx,
  env: AdminEnv
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
      /* fall through to JWT */
    }
  }
  const jwt = request.headers.get('cf-access-jwt-assertion')
  if (jwt) {
    if (!accessTeamDomain(env.TEAM_DOMAIN)) {
      return { status: 'misconfigured', error: 'Cloudflare Access is misconfigured: TEAM_DOMAIN is unset' }
    }
    if (!env.POLICY_AUD?.trim()) {
      return { status: 'misconfigured', error: 'Cloudflare Access is misconfigured: POLICY_AUD is unset' }
    }
    const email = await verifyAccessJwt(jwt, accessTeamDomain(env.TEAM_DOMAIN)!, env.POLICY_AUD.trim())
    if (email && isAdminEmail(email)) return { status: 'ok', email }
    return { status: 'denied' }
  }
  return { status: 'none' }
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
