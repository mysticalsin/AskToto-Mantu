/** Issue 108: Cloudflare is a login redirect, not Account ID + token paste. */

export const CF_DASH_LOGIN = 'https://dash.cloudflare.com/login'
export const CF_CONNECT_PATH = '/cloudflare/connect'
export const CF_CALLBACK_PATH = '/cloudflare/callback'

export function isCloudflareConnectPath(pathname: string): boolean {
  return pathname === CF_CONNECT_PATH || pathname === CF_CALLBACK_PATH
}

export function cloudflareLoginLocation(request: Request): string {
  const url = new URL(request.url)
  const login = new URL(CF_DASH_LOGIN)
  login.searchParams.set('redirect_uri', new URL(CF_CALLBACK_PATH, url.origin).toString())
  return login.toString()
}

export function redirectToCloudflareLogin(request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: cloudflareLoginLocation(request) }
  })
}

export function redirectToKeysAfterCloudflareLogin(): Response {
  return new Response(null, { status: 303, headers: { Location: '/#keys' } })
}
