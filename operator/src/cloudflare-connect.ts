/** Cloudflare · AI Gateway: OAuth login, then Operator provisions vault keys. No paste. */

import { ensureDefaultAiGateway } from './ai-gateway'
import { writeVaultKey } from './keys'
import type { OperatorStore } from './store'
import { CF_ACCOUNT_PROVIDER } from './vault'

export { ensureDefaultAiGateway }

export const CF_DASH_LOGIN = 'https://dash.cloudflare.com/login'
export const CF_OAUTH_AUTHORIZE = 'https://dash.cloudflare.com/oauth2/auth'
export const CF_OAUTH_TOKEN = 'https://dash.cloudflare.com/oauth2/token'
export const CF_CONNECT_PATH = '/cloudflare/connect'
export const CF_CALLBACK_PATH = '/cloudflare/callback'
export const CF_OAUTH_COOKIE = 'metis_cf_oauth'
export const CF_OAUTH_MISSING = 'Cloudflare OAuth is not configured. Set CF_OAUTH_CLIENT_ID and CF_OAUTH_CLIENT_SECRET.'
export const CF_OAUTH_SCOPES = [
  'account:read',
  'user:read',
  'workers-ai:run',
  'ai-gateway:read',
  'ai-gateway:edit',
  'workers:read',
  'd1:read'
].join(' ')

export type CloudflareOAuthEnv = {
  CF_OAUTH_CLIENT_ID?: string
  CF_OAUTH_CLIENT_SECRET?: string
  CF_OAUTH_AUTHORIZE_URL?: string
  CF_OAUTH_TOKEN_URL?: string
  CF_OAUTH_SCOPES?: string
  CF_ACCOUNT_ID?: string
  OPERATOR_VAULT_KEY?: string
}

export function isCloudflareConnectPath(pathname: string): boolean {
  return pathname === CF_CONNECT_PATH || pathname === CF_CALLBACK_PATH
}

export function oauthClientId(env: CloudflareOAuthEnv): string {
  return (env.CF_OAUTH_CLIENT_ID || '').trim()
}

export function oauthClientSecret(env: CloudflareOAuthEnv): string {
  return (env.CF_OAUTH_CLIENT_SECRET || '').trim()
}

export function oauthConfigured(env: CloudflareOAuthEnv): boolean {
  return Boolean(oauthClientId(env) && oauthClientSecret(env))
}

export function callbackUrl(request: Request): string {
  return new URL(CF_CALLBACK_PATH, new URL(request.url).origin).toString()
}

export function cloudflareAuthorizeLocation(request: Request, env: CloudflareOAuthEnv, state: string): string {
  const authorize = new URL((env.CF_OAUTH_AUTHORIZE_URL || CF_OAUTH_AUTHORIZE).trim() || CF_OAUTH_AUTHORIZE)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', oauthClientId(env))
  authorize.searchParams.set('redirect_uri', callbackUrl(request))
  authorize.searchParams.set('scope', (env.CF_OAUTH_SCOPES || CF_OAUTH_SCOPES).trim() || CF_OAUTH_SCOPES)
  authorize.searchParams.set('state', state)
  return authorize.toString()
}

/** Legacy helper: dash login is not the happy path. OAuth authorize is. */
export function cloudflareLoginLocation(request: Request, env: CloudflareOAuthEnv = {}, state = 'state'): string {
  if (oauthConfigured(env)) return cloudflareAuthorizeLocation(request, env, state)
  return new URL(CF_DASH_LOGIN).toString()
}

export function newOAuthState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function oauthStateCookie(state: string): string {
  return `${CF_OAUTH_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
}

export function clearOAuthStateCookie(): string {
  return `${CF_OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function readOAuthStateCookie(request: Request): string | null {
  const raw = request.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === CF_OAUTH_COOKIE) {
      const v = rest.join('=').trim()
      return /^[a-f0-9]{32}$/.test(v) ? v : null
    }
  }
  return null
}

export function keysAfterConnect(result: 'connected' | 'failed' | 'denied' | 'need-oauth'): string {
  return `/?cf=${result}#keys`
}

export function redirectToCloudflareLogin(request: Request, env: CloudflareOAuthEnv = {}): Response {
  if (!oauthConfigured(env)) {
    return new Response(JSON.stringify({ ok: false, error: CF_OAUTH_MISSING }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    })
  }
  const state = newOAuthState()
  return new Response(null, {
    status: 302,
    headers: {
      Location: cloudflareAuthorizeLocation(request, env, state),
      'Set-Cookie': oauthStateCookie(state)
    }
  })
}

export function redirectToKeysAfterCloudflareLogin(result: 'connected' | 'failed' | 'denied' | 'need-oauth' = 'connected'): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: keysAfterConnect(result), 'Set-Cookie': clearOAuthStateCookie() }
  })
}

export async function exchangeCloudflareOAuthCode(
  request: Request,
  env: CloudflareOAuthEnv,
  code: string,
  fetchImpl: typeof fetch
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const tokenUrl = (env.CF_OAUTH_TOKEN_URL || CF_OAUTH_TOKEN).trim() || CF_OAUTH_TOKEN
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(request),
    client_id: oauthClientId(env),
    client_secret: oauthClientSecret(env)
  })
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null
  const token = json && typeof json.access_token === 'string' ? json.access_token.trim() : ''
  if (!res.ok || !token) return { ok: false, error: 'oauth token exchange failed' }
  return { ok: true, token }
}

export async function resolveCloudflareAccount(
  token: string,
  env: CloudflareOAuthEnv,
  fetchImpl: typeof fetch
): Promise<{ ok: true; accountId: string; name: string } | { ok: false; error: string }> {
  const pinned = (env.CF_ACCOUNT_ID || '').trim()
  const res = await fetchImpl('https://api.cloudflare.com/client/v4/accounts?per_page=20', {
    headers: { authorization: `Bearer ${token}` }
  })
  const json = (await res.json().catch(() => null)) as {
    result?: { id?: unknown; name?: unknown }[]
  } | null
  const rows = Array.isArray(json?.result) ? json.result : []
  const match = pinned
    ? rows.find((r) => typeof r.id === 'string' && r.id === pinned)
    : rows.find((r) => typeof r.id === 'string' && r.id.trim())
  const accountId = match && typeof match.id === 'string' ? match.id.trim() : pinned
  if (!accountId) return { ok: false, error: 'no Cloudflare account on this login' }
  const name = match && typeof match.name === 'string' && match.name.trim() ? match.name.trim() : accountId
  return { ok: true, accountId, name }
}

export async function provisionCloudflareKeys(
  store: OperatorStore,
  env: CloudflareOAuthEnv,
  email: string,
  now: number,
  creds: { token: string; accountId: string; name: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; last4: string } | { ok: false; error: string; status: number }> {
  const account = await writeVaultKey(
    store,
    env,
    email,
    now,
    {
      provider: CF_ACCOUNT_PROVIDER,
      accountId: creds.accountId,
      token: creds.token,
      label: creds.name
    },
    fetchImpl
  )
  if (!account.ok) return account
  const gateway = await writeVaultKey(
    store,
    env,
    email,
    now,
    {
      provider: 'cloudflare',
      accountId: creds.accountId,
      token: creds.token,
      label: 'AI Gateway'
    },
    fetchImpl
  )
  if (!gateway.ok) return gateway
  return { ok: true, last4: gateway.last4 }
}

export async function handleCloudflareCallback(
  request: Request,
  env: CloudflareOAuthEnv,
  store: OperatorStore,
  email: string,
  now: number,
  fetchImpl: typeof fetch
): Promise<Response> {
  if (!oauthConfigured(env)) return redirectToKeysAfterCloudflareLogin('need-oauth')
  const url = new URL(request.url)
  if (url.searchParams.get('error')) return redirectToKeysAfterCloudflareLogin('denied')
  const code = (url.searchParams.get('code') || '').trim()
  const state = (url.searchParams.get('state') || '').trim()
  const cookie = readOAuthStateCookie(request)
  if (!code || !state || !cookie || state !== cookie) return redirectToKeysAfterCloudflareLogin('denied')
  const exchanged = await exchangeCloudflareOAuthCode(request, env, code, fetchImpl)
  if (!exchanged.ok) return redirectToKeysAfterCloudflareLogin('failed')
  const account = await resolveCloudflareAccount(exchanged.token, env, fetchImpl)
  if (!account.ok) return redirectToKeysAfterCloudflareLogin('failed')
  await ensureDefaultAiGateway(exchanged.token, account.accountId, fetchImpl)
  const written = await provisionCloudflareKeys(
    store,
    env,
    email,
    now,
    {
      token: exchanged.token,
      accountId: account.accountId,
      name: account.name
    },
    fetchImpl
  )
  if (!written.ok) return redirectToKeysAfterCloudflareLogin('failed')
  return redirectToKeysAfterCloudflareLogin('connected')
}
