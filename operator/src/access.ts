export const ADMIN_EMAILS = ['tony.walteur@gmail.com', 'twalteur@amaris.com'] as const

export type AccessCtx = {
  access?: { getIdentity: () => Promise<{ email?: string } | null | undefined> }
}

export async function adminIdentity(
  request: Request,
  ctx: AccessCtx,
  env: { TEAM_DOMAIN?: string; POLICY_AUD?: string }
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
    const email = await verifyAccessJwt(jwt, env.TEAM_DOMAIN, env.POLICY_AUD)
    if (email && (ADMIN_EMAILS as readonly string[]).includes(email)) return { email }
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
