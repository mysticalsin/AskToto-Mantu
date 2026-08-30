/**
 * planeOAuth.ts — OAuth 2.1 + PKCE connect flow for Plane's hosted MCP server.
 *
 * Same plug-and-play shape as ClickUp (clickupOAuth.ts): one button → system browser → loopback
 * callback → tokens in mcpSecrets → connectMcp. Plane differs from ClickUp in three documented ways
 * (fetched from https://mcp.plane.so/.well-known/oauth-authorization-server, 2026-08-30):
 *   - token_endpoint_auth_methods_supported includes client_secret_post (DCR returns a client_secret)
 *   - grant_types_supported includes refresh_token (so refreshPlaneToken is expected to work)
 *   - MCP endpoint after consent is https://mcp.plane.so/http/mcp (OAuth-bound workspace; no
 *     X-Workspace-slug header — that was only for the PAT/api-key transport)
 *
 * Persistence of tokens / client_secret is the caller's job (main/index.ts mcpPlaneConnect).
 */

import { shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { getSettings, setSettings } from '../store'
import { getMcpClientSecret } from './mcpSecrets'
import { auditLog, mainLog } from '../logger'

const ISSUER = 'https://mcp.plane.so'
const AUTHORIZE_URL = `${ISSUER}/authorize`
const TOKEN_URL = `${ISSUER}/token`
const REGISTER_URL = `${ISSUER}/register`
/** Plane's OAuth MCP endpoint — fixed URL, never user-entered. */
export const PLANE_MCP_ENDPOINT = `${ISSUER}/http/mcp`

const OAUTH_TIMEOUT_MS = 300_000
const FETCH_TIMEOUT_MS = 15_000
const PLANE_SCOPES = 'read write'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export interface PlaneTokenResult {
  ok: boolean
  error?: string
  accessToken?: string
  refreshToken?: string
  /** Present only after a fresh Dynamic Client Registration (first connect on this machine). */
  clientSecret?: string
}

async function postTokenRequest(body: URLSearchParams): Promise<PlaneTokenResult> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json().catch(() => null)) as any
    const accessToken = typeof json?.access_token === 'string' ? json.access_token : ''
    if (!res.ok || !accessToken) {
      const desc = typeof json?.error_description === 'string' ? json.error_description : ''
      const code = typeof json?.error === 'string' ? json.error : ''
      return {
        ok: false,
        error: desc || (code ? `Plane rejected the request (${code}).` : 'Plane rejected the sign-in request.')
      }
    }
    return {
      ok: true,
      accessToken,
      refreshToken: typeof json?.refresh_token === 'string' ? json.refresh_token : undefined
    }
  } catch (e) {
    mainLog.warn('[plane] token request failed', errMsg(e))
    return { ok: false, error: 'Could not reach Plane to complete sign-in. Check your network connection.' }
  }
}

function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<PlaneTokenResult> {
  return postTokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier
    })
  )
}

export async function refreshPlaneToken(refreshToken: string): Promise<PlaneTokenResult> {
  const clientId = (getSettings().planeClientId || '').trim()
  const clientSecret = getMcpClientSecret('plane').trim()
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, error: 'No Plane refresh credentials available.' }
  }
  return postTokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  )
}

export interface PlaneClientCreds {
  clientId: string
  clientSecret: string
  /** True when DCR just issued a new secret the caller must persist. */
  freshlyRegistered: boolean
}

/**
 * Resolve Plane OAuth client credentials: reuse cached client_id + encrypted client_secret when both
 * exist; otherwise Dynamic Client Registration (RFC 7591) and return the new pair for the caller to
 * persist. Returns null when registration fails.
 */
export async function ensurePlaneClientCreds(): Promise<PlaneClientCreds | null> {
  const cachedId = (getSettings().planeClientId || '').trim()
  const cachedSecret = getMcpClientSecret('plane').trim()
  if (cachedId && cachedSecret) {
    return { clientId: cachedId, clientSecret: cachedSecret, freshlyRegistered: false }
  }
  try {
    const res = await fetch(REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Métis',
        redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: PLANE_SCOPES
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) {
      mainLog.warn('[plane] dynamic client registration failed', res.status)
      return null
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json().catch(() => null)) as any
    const clientId = typeof json?.client_id === 'string' ? json.client_id.trim() : ''
    const clientSecret = typeof json?.client_secret === 'string' ? json.client_secret.trim() : ''
    if (!clientId || !clientSecret) return null
    // Cache the public client_id immediately so a crash between here and secret persistence still
    // leaves a recoverable id; the secret is persisted by the caller (mcpPlaneConnect) via mcpSecrets.
    setSettings({ planeClientId: clientId })
    return { clientId, clientSecret, freshlyRegistered: true }
  } catch (e) {
    mainLog.warn('[plane] dynamic client registration request failed', errMsg(e))
    return null
  }
}

function buildAuthorizeUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  u.searchParams.set('scope', PLANE_SCOPES)
  return u.toString()
}

function coarseOAuthFailure(e: unknown): string {
  const msg = errMsg(e)
  if (/timed out/i.test(msg)) return 'timeout'
  if (/No authorization code|access_denied|error_description/i.test(msg)) return 'oauth_denied'
  if (/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|reach Plane/i.test(msg)) return 'network'
  if (/register|client_id/i.test(msg)) return 'registration_failed'
  return 'other'
}

let oauthInFlight = false

export function tryAcquirePlaneTokenLock(): boolean {
  if (oauthInFlight) return false
  oauthInFlight = true
  return true
}

export function releasePlaneTokenLock(): void {
  oauthInFlight = false
}

/**
 * Full interactive OAuth connect. Opens the system browser; on success returns tokens (+ clientSecret
 * when DCR just ran). Never throws.
 */
export async function runPlaneOAuth(): Promise<PlaneTokenResult> {
  if (!tryAcquirePlaneTokenLock()) return { ok: false, error: 'A Plane sign-in is already in progress.' }
  try {
    const creds = await ensurePlaneClientCreds()
    if (!creds) {
      return { ok: false, error: 'Plane did not accept the automatic sign-in registration request. Try again later.' }
    }

    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('hex')

    const captured = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = ''
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const c = url.searchParams.get('code')
        const err = url.searchParams.get('error_description') || url.searchParams.get('error')
        if (!c && !err) {
          res.writeHead(204)
          res.end()
          return
        }
        if (url.searchParams.get('state') !== state) {
          auditLog('plane.oauth.state_mismatch', {})
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Invalid state.')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body style="font-family:system-ui;background:#0b1220;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Métis</h2><p>${c ? 'Plane connected — you can close this window.' : 'Plane sign-in failed.'}</p></div></body></html>`
        )
        clearTimeout(timer)
        server.close()
        if (c) resolve({ code: c, redirectUri })
        else reject(new Error(err || 'No authorization code returned.'))
      })
      server.on('error', reject)
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('Plane sign-in timed out.'))
      }, OAUTH_TIMEOUT_MS)
      server.listen(0, '127.0.0.1', async () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        redirectUri = `http://127.0.0.1:${port}/callback`
        try {
          const authUrl = buildAuthorizeUrl(creds.clientId, redirectUri, challenge, state)
          await shell.openExternal(authUrl)
        } catch (e) {
          clearTimeout(timer)
          server.close()
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    })

    const result = await exchangeCodeForTokens(
      creds.clientId,
      creds.clientSecret,
      captured.code,
      captured.redirectUri,
      verifier
    )
    if (!result.ok) {
      auditLog('plane.oauth.denied', {})
      return result
    }
    return {
      ...result,
      clientSecret: creds.freshlyRegistered ? creds.clientSecret : undefined
    }
  } catch (e) {
    auditLog('plane.oauth.failed', { reason: coarseOAuthFailure(e) })
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    releasePlaneTokenLock()
  }
}
