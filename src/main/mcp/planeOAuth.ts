/**
 * planeOAuth.ts — OAuth 2.1 + PKCE connect flow for Plane's hosted MCP server.
 *
 * Mirrors clickupOAuth.ts (PKCE, CSRF state, loopback 127.0.0.1, 300s timeout, single-flight) — INCLUDING
 * its DCR posture: bind the loopback server first, then register a FRESH confidential client scoped to
 * THIS run's exact `http://127.0.0.1:<port>/callback`, every Connect.
 *
 * runPlaneOAuth() itself never persists anything (settings.planeClientId, mcpSecrets, or the tokens):
 * it only proves the user granted access and hands the freshly-registered client back to the caller
 * alongside the tokens it minted. Persisting the client without also persisting the tokens it was
 * issued with — or vice versa — pairs a refresh token with a client it doesn't match, since a refresh
 * token only works with the client that requested it. The caller (main/index.ts's mcpPlaneConnect
 * handler, via savePlaneClientAndTokens below) saves the two together, in one step, only once it has
 * independently confirmed the access token actually works end-to-end with a live connectMcp probe —
 * a successful token exchange here proves Plane accepted the client, not that the connection is live.
 *
 * GROUND TRUTH (fetched 2026-09-26, live):
 *   authorization_endpoint: https://mcp.plane.so/authorize
 *   token_endpoint:         https://mcp.plane.so/token
 *   registration_endpoint:  https://mcp.plane.so/register
 *   grant_types_supported:  ["authorization_code", "refresh_token"]
 *   code_challenge_methods_supported: ["S256"]
 *   token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]
 *
 * Unlike mcp.clickup.com (which 401s "redirect_uri is not registered for this client" the instant
 * `/authorize` sees a redirect_uri outside the registered set), a live probe of mcp.plane.so found
 * `/authorize` returns 302-to-consent for a client registered with `http://127.0.0.1/callback` even when
 * called with an entirely different, unregistered `http://127.0.0.1:<port>/callback` — i.e. Plane does
 * NOT reject an unlisted loopback redirect_uri at the authorize step the way ClickUp does (OBSERVED,
 * 2026-09-26; the token-exchange step could not be probed the same way — it needs a completed interactive
 * login, which no automated/CI environment can provide — so a stricter check there remains ASSUMED-safe
 * rather than OBSERVED). Registering fresh per run regardless is still the right call: it is proven safe
 * (this run's own redirect_uri is always in the set DCR was just called with), and it removes the
 * portless/ported asymmetry entirely rather than leaving it load-bearing on an unverified assumption.
 *
 * Official hosted MCP URLs (never user-entered):
 *   OAuth (Connect): https://mcp.plane.so/http/mcp
 *   PAT (Advanced):  https://mcp.plane.so/http/api-key/mcp
 *
 * Workspace is chosen on Plane's login page. No slug on first-run Connect.
 */

import { shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { getSettings, setSettings } from '../store'
import { auditLog, mainLog } from '../logger'
import { getMcpClientSecret, setMcpClientSecret, setMcpApiKey, setMcpRefreshToken } from './mcpSecrets'

const ISSUER = 'https://mcp.plane.so'
const AUTHORIZE_URL = `${ISSUER}/authorize`
const TOKEN_URL = `${ISSUER}/token`
const REGISTER_URL = `${ISSUER}/register`

/** Official OAuth MCP — Connect pins this. Workspace is bound at login. */
export const PLANE_MCP_OAUTH_ENDPOINT = `${ISSUER}/http/mcp`
/** Official PAT MCP — Advanced key path pins this. Never shown as a field. */
export const PLANE_MCP_PAT_ENDPOINT = `${ISSUER}/http/api-key/mcp`

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

export interface TokenResult {
  ok: boolean
  error?: string
  accessToken?: string
  refreshToken?: string
  /** Only set by a successful runPlaneOAuth() — the client that minted accessToken/refreshToken above,
   *  returned (never persisted) so the caller can save client and tokens together. Absent from
   *  refreshPlaneToken()'s result: a refresh never changes which client the tokens are paired with. */
  clientId?: string
  clientSecret?: string
}

const PLANE_REDIRECT_MISMATCH =
  'Plane rejected this sign-in because the callback address does not match the one Métis registered. Click Connect again.'
const PLANE_INVALID_CLIENT = 'Plane did not recognize this sign-in client. Click Connect again.'
const PLANE_GENERIC = 'Plane rejected the sign-in request.'

/**
 * Map a Plane OAuth error code/description to a single human sentence — mirrors
 * humanizeClickupOAuthError. A plain-text `error_description` (e.g. from a rejected/expired refresh
 * token) passes through unchanged; only a missing or JSON-shaped description falls back to a generic
 * "Plane rejected the request (<code>)" sentence, so a raw JSON blob is never shown to the user.
 */
export function humanizePlaneOAuthError(code: string, description = ''): string {
  const hay = `${code} ${description}`.toLowerCase()
  if (/redirect_uri/.test(hay) || /not registered/.test(hay)) return PLANE_REDIRECT_MISMATCH
  if (code === 'invalid_client' || /invalid_client/.test(hay)) return PLANE_INVALID_CLIENT
  const desc = description.trim()
  if (!desc || desc.startsWith('{') || desc.startsWith('[')) {
    if (/access_denied/.test(hay)) return 'Plane sign-in was denied.'
    return code ? `Plane rejected the request (${code}).` : PLANE_GENERIC
  }
  return desc
}

async function postTokenRequest(body: URLSearchParams): Promise<TokenResult> {
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
      return { ok: false, error: humanizePlaneOAuthError(code, desc) }
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
): Promise<TokenResult> {
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

export async function refreshPlaneToken(refreshToken: string): Promise<TokenResult> {
  const clientId = (getSettings().planeClientId || '').trim()
  const clientSecret = getMcpClientSecret('plane').trim()
  if (!clientId || !clientSecret || !refreshToken) return { ok: false, error: 'No Plane refresh token available.' }
  return postTokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  )
}

/**
 * Persist a Plane client together with the token pair it was just used to mint — in this one call, so
 * neither is ever written without the other. Callers must save the two together only once they have
 * independently confirmed the access token actually works (see main/index.ts's mcpPlaneConnect handler,
 * which calls this only after a connectMcp probe of that token has succeeded): saving the client any
 * earlier, or the tokens without the client that minted them, can pair a refresh token with a client it
 * was never issued to — refreshPlaneToken() above always sends whatever pair was last saved here.
 */
export function savePlaneClientAndTokens(
  client: { clientId: string; clientSecret: string },
  tokens: { accessToken: string; refreshToken: string }
): void {
  setSettings({ planeClientId: client.clientId })
  setMcpClientSecret('plane', client.clientSecret)
  setMcpApiKey('plane', tokens.accessToken)
  setMcpRefreshToken('plane', tokens.refreshToken)
}

/**
 * Dynamic Client Registration (RFC 7591) for THIS run's exact loopback redirect_uri — mirrors
 * registerClickupClient. Always POSTs a fresh confidential client, never reuses a cached client_id/secret
 * for `/authorize` or the token exchange: see the file header (P4-F2) for why a one-time cache bound to a
 * fixed portless URI is wrong regardless of how strictly Plane validates it. Returns the credentials to
 * the caller without persisting them — persistence is entirely the caller's responsibility (see the file
 * header and savePlaneClientAndTokens); this function and runPlaneOAuth never write to settings or
 * mcpSecrets. Returns null when registration fails; callers must not fabricate a client.
 */
async function registerPlaneClient(redirectUri: string): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const res = await fetch(REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Métis',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post'
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
    return { clientId, clientSecret }
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
  if (/register|client_id|client_secret/i.test(msg)) return 'registration_failed'
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

export async function runPlaneOAuth(): Promise<TokenResult> {
  if (!tryAcquirePlaneTokenLock()) return { ok: false, error: 'A Plane sign-in is already in progress.' }
  try {
    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('hex')
    // Set inside server.listen()'s callback once registerPlaneClient() succeeds — mirrors
    // clickupOAuth.ts's `let clientId = ''`. The promise below only resolves after that assignment (any
    // earlier failure rejects instead), so both are non-empty by the time they're read after the await.
    let clientId = ''
    let clientSecret = ''

    const captured = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = ''
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const c = url.searchParams.get('code')
        const errCode = url.searchParams.get('error') || ''
        const errDesc = url.searchParams.get('error_description') || ''
        if (!c && !errCode && !errDesc) {
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
          `<html><body style="font-family:system-ui;background:#1a0033;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Métis</h2><p>${c ? 'Plane connected — you can close this window.' : 'Plane sign-in failed.'}</p></div></body></html>`
        )
        clearTimeout(timer)
        server.close()
        if (c) resolve({ code: c, redirectUri })
        else reject(new Error(humanizePlaneOAuthError(errCode, errDesc || 'No authorization code returned.')))
      })
      server.on('error', reject)
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('Plane sign-in timed out.'))
      }, OAUTH_TIMEOUT_MS)
      server.listen(0, '127.0.0.1', async () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        // Literal 127.0.0.1, not 'localhost' — see clickupOAuth.ts's identical comment (Windows can
        // resolve 'localhost' to ::1 first, stalling or dropping the browser's callback).
        redirectUri = `http://127.0.0.1:${port}/callback`
        try {
          const registered = await registerPlaneClient(redirectUri)
          if (!registered) {
            clearTimeout(timer)
            server.close()
            reject(new Error('Plane did not accept the automatic sign-in registration request. Try again later.'))
            return
          }
          clientId = registered.clientId
          clientSecret = registered.clientSecret
          const authUrl = buildAuthorizeUrl(clientId, redirectUri, challenge, state)
          await shell.openExternal(authUrl)
        } catch (e) {
          clearTimeout(timer)
          server.close()
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    })

    const result = await exchangeCodeForTokens(clientId, clientSecret, captured.code, captured.redirectUri, verifier)
    if (!result.ok) {
      auditLog('plane.oauth.denied', {})
      return result
    }
    // Never persist here: a successful token exchange only proves Plane accepted this client — it does
    // not prove the access token works end-to-end (the caller still runs a live connectMcp probe). Hand
    // the client back alongside the tokens instead, so the caller can save both together only once that
    // probe has also succeeded — see savePlaneClientAndTokens and the file header.
    return { ...result, clientId, clientSecret }
  } catch (e) {
    auditLog('plane.oauth.failed', { reason: coarseOAuthFailure(e) })
    return { ok: false, error: humanizePlaneOAuthError('', e instanceof Error ? e.message : String(e)) }
  } finally {
    releasePlaneTokenLock()
  }
}
