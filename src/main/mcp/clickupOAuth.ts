/**
 * clickupOAuth.ts — OAuth 2.1 + PKCE connect flow for ClickUp's MCP server.
 *
 * Structurally mirrors src/main/auth.ts's signIn(): PKCE verifier/challenge, a CSRF state nonce, an
 * ephemeral node:http server bound to 127.0.0.1 on a dynamic port, shell.openExternal to the system
 * browser, a hard 300s timeout, and a single-flight guard against a second concurrent flow. It is NOT
 * MSAL-based — ClickUp is a plain OAuth 2.1 authorization server (raw fetch() to its token endpoint),
 * so the PKCE/state/loopback mechanics are hand-rolled here with Node's own crypto (RFC 7636) rather
 * than reusing @azure/msal-node's CryptoProvider, which is Microsoft-specific.
 *
 * This module owns ONLY the OAuth handshake (proving the user granted access, handing back a token
 * pair). It never persists a token itself — the caller (main/index.ts's mcpClickupConnect handler)
 * stores the access token via mcp/mcpSecrets.ts's generic setMcpApiKey('clickup', ...), exactly like a
 * pasted BidStack/Plane key, and the refresh token via its setMcpRefreshToken('clickup', ...). The
 * resulting access token then flows through the existing generic mcp/mcpClient.ts (connectMcp/pushToMcp)
 * unmodified — a ClickUp OAuth token is a plain bearer token like any other connection's key.
 *
 * GROUND TRUTH (fetched from https://mcp.clickup.com/.well-known/oauth-authorization-server, 2026-08-14):
 *   authorization_endpoint: https://mcp.clickup.com/oauth/authorize
 *   token_endpoint:         https://mcp.clickup.com/oauth/token
 *   registration_endpoint:  https://mcp.clickup.com/oauth/register   (RFC 7591 Dynamic Client Registration)
 *   grant_types_supported:  ["authorization_code"]   — NO refresh_token grant advertised
 *   code_challenge_methods_supported: ["S256"]
 *   token_endpoint_auth_methods_supported: ["none"]  — public client, no client_secret
 *
 * DCR redirect_uri / loopback port: ClickUp does NOT honor RFC 8252 §7.3 port-flexible loopback.
 * Live mcp.clickup.com (re-verified 2026-08-31) hashes the registered redirect_uris into the
 * client_id JWT (`uri_hashes`) and exact-matches /authorize's redirect_uri:
 *   - POST /oauth/register with http://127.0.0.1/callback → 200, client_id issued (public, no secret).
 *   - GET /oauth/authorize with that client_id + http://127.0.0.1:<ephemeral>/callback → 401 JSON
 *     {"error":"invalid_client","error_description":"redirect_uri is not registered for this client"}.
 *   - Same client_id + the exact registered URI, or a fresh client registered with the ported URI → 302
 *     to ClickUp's consent page.
 * So each Connect run binds the loopback server first, then DCR-registers a fresh client with
 * redirect_uris exactly equal to this run's `http://127.0.0.1:<port>/callback`. A cached client_id
 * (especially a leftover portless one) is never reused for /authorize. The new client_id is stored
 * only so a later refresh can send it; the next interactive Connect registers again.
 *
 * Failures return a typed { ok:false, error } with a human sentence — never the raw JSON blob, never
 * a crash. Tokens are never logged.
 */

import { shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { getSettings, setSettings } from '../store'
import { auditLog, mainLog } from '../logger'

const ISSUER = 'https://mcp.clickup.com'
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
const TOKEN_URL = `${ISSUER}/oauth/token`
const REGISTER_URL = `${ISSUER}/oauth/register`
/** ClickUp's MCP endpoint — always this fixed URL, never user-entered. Fed straight into the generic
 *  connectMcp/pushToMcp in mcpClient.ts once a token exists. */
export const CLICKUP_MCP_ENDPOINT = `${ISSUER}/mcp`

const OAUTH_TIMEOUT_MS = 300_000
const FETCH_TIMEOUT_MS = 15_000
const CLICKUP_SCOPES = 'read write'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** RFC 7636 PKCE: a high-entropy verifier (32 random bytes → 43-char base64url, within the 43-128
 *  allowed length) and its S256 challenge — the only method ClickUp's discovery doc advertises. */
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
}

const CLICKUP_REDIRECT_MISMATCH =
  'ClickUp rejected this sign-in because the callback address does not match the one Métis registered. Click Connect again.'
const CLICKUP_INVALID_CLIENT = 'ClickUp did not recognize this sign-in client. Click Connect again.'
const CLICKUP_GENERIC = 'ClickUp rejected the sign-in request.'

/**
 * Map a ClickUp OAuth error code/description to a single human sentence. Live /authorize mismatch
 * returns the JSON blob `{"error":"invalid_client","error_description":"redirect_uri is not
 * registered for this client"}` in the browser; we never pass that blob (or any raw JSON) through to
 * Brain. Safe to call with either half empty.
 */
export function humanizeClickupOAuthError(code: string, description = ''): string {
  const hay = `${code} ${description}`.toLowerCase()
  if (/redirect_uri/.test(hay) || /not registered/.test(hay)) return CLICKUP_REDIRECT_MISMATCH
  if (code === 'invalid_client' || /invalid_client/.test(hay)) return CLICKUP_INVALID_CLIENT
  const desc = description.trim()
  if (!desc || desc.startsWith('{') || desc.startsWith('[')) {
    if (/access_denied/.test(hay)) return 'ClickUp sign-in was denied.'
    return code ? `ClickUp rejected the request (${code}).` : CLICKUP_GENERIC
  }
  return desc
}

/** POST helper shared by the code exchange and the refresh exchange — same endpoint, same error
 *  handling, different grant. Never throws: every failure path returns { ok: false, error }. */
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
      return { ok: false, error: humanizeClickupOAuthError(code, desc) }
    }
    return {
      ok: true,
      accessToken,
      refreshToken: typeof json?.refresh_token === 'string' ? json.refresh_token : undefined
    }
  } catch (e) {
    mainLog.warn('[clickup] token request failed', errMsg(e))
    return { ok: false, error: 'Could not reach ClickUp to complete sign-in. Check your network connection.' }
  }
}

function exchangeCodeForTokens(clientId: string, code: string, redirectUri: string, verifier: string): Promise<TokenResult> {
  return postTokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier
    })
  )
}

/**
 * Exchange a stored refresh token for a fresh access token. ClickUp's live discovery doc lists only
 * `authorization_code` under grant_types_supported (no `refresh_token`), so this is expected to fail
 * with an `unsupported_grant_type`-shaped rejection today — callers (index.ts's mcp:push handler for
 * clickup-kind connections) treat any failure here identically to "no refresh token available": surface
 * reconnect-required, never crash or retry forever. Kept as a real implementation (not a stub) so this
 * activates automatically the moment ClickUp adds refresh support server-side, with no client-side change.
 */
export async function refreshClickupToken(refreshToken: string): Promise<TokenResult> {
  const clientId = (getSettings().clickupClientId || '').trim()
  if (!clientId || !refreshToken) return { ok: false, error: 'No ClickUp refresh token available.' }
  return postTokenRequest(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
  )
}

/**
 * Dynamic Client Registration (RFC 7591) for THIS run's exact loopback redirect_uri. Always POSTs a
 * fresh client — never reuses getSettings().clickupClientId — because ClickUp exact-matches the
 * registered URI (see file header). A leftover portless/mismatched cached id is overwritten only
 * after a usable client_id comes back, so a failed DCR does not wipe a still-valid refresh client.
 * Returns null when registration fails; callers must not fabricate a client_id.
 */
async function registerClickupClient(redirectUri: string): Promise<string | null> {
  try {
    const res = await fetch(REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Métis',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) {
      mainLog.warn('[clickup] dynamic client registration failed', res.status)
      return null
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json().catch(() => null)) as any
    const clientId = typeof json?.client_id === 'string' ? json.client_id.trim() : ''
    if (!clientId) return null
    setSettings({ clickupClientId: clientId })
    return clientId
  } catch (e) {
    mainLog.warn('[clickup] dynamic client registration request failed', errMsg(e))
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
  u.searchParams.set('scope', CLICKUP_SCOPES)
  return u.toString()
}

/** Bucket a failure into a small, fixed category for the audit log — mirrors auth.ts's
 *  coarseSignInFailure. Never the raw message, which can carry request/response detail. */
function coarseOAuthFailure(e: unknown): string {
  const msg = errMsg(e)
  if (/timed out/i.test(msg)) return 'timeout'
  if (/No authorization code|access_denied|error_description/i.test(msg)) return 'oauth_denied'
  if (/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|reach ClickUp/i.test(msg)) return 'network'
  if (/register|client_id/i.test(msg)) return 'registration_failed'
  return 'other'
}

// Single-flight guard — mirrors auth.ts's signInInFlight: a loopback server + external browser launch
// per call means a second concurrent flow would spawn a second server/browser window and race on the
// (only ever in-memory, until the caller persists it) captured code. ALSO shared with index.ts's
// mcp:push handler's background 401 → refresh path for clickup-kind connections — a background refresh
// and a user-initiated Reconnect must never both persist tokens around the same time.
let oauthInFlight = false

/**
 * Synchronous check-then-set guard (no `await` between check and set, so no TOCTOU window even under
 * concurrent IPC calls). Returns false if the lock is already held by another in-flight operation —
 * the caller must not proceed with its own token write in that case, and must eventually call
 * releaseClickupTokenLock() if it returned true.
 */
export function tryAcquireClickupTokenLock(): boolean {
  if (oauthInFlight) return false
  oauthInFlight = true
  return true
}

/** Release the lock acquired via tryAcquireClickupTokenLock(). Only call this after successfully
 *  acquiring it (in a try/finally). */
export function releaseClickupTokenLock(): void {
  oauthInFlight = false
}

/**
 * Run the full interactive OAuth connect flow and resolve with the granted tokens. Persistence
 * (storing the tokens, marking the connection `connected`, listing tools) is the caller's job — see
 * main/index.ts's mcpClickupConnect handler — this function only proves the user granted access and
 * hands back the token pair. Never throws; every failure path returns { ok: false, error }.
 */
export async function runClickupOAuth(): Promise<TokenResult> {
  if (!tryAcquireClickupTokenLock()) return { ok: false, error: 'A ClickUp sign-in is already in progress.' }
  try {
    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('hex')
    let clientId = ''

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
          auditLog('clickup.oauth.state_mismatch', {})
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Invalid state.')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body style="font-family:system-ui;background:#1a0033;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Métis</h2><p>${c ? 'ClickUp connected — you can close this window.' : 'ClickUp sign-in failed.'}</p></div></body></html>`
        )
        clearTimeout(timer)
        server.close()
        if (c) resolve({ code: c, redirectUri })
        else reject(new Error(humanizeClickupOAuthError(errCode, errDesc || 'No authorization code returned.')))
      })
      server.on('error', reject)
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('ClickUp sign-in timed out.'))
      }, OAUTH_TIMEOUT_MS)
      server.listen(0, '127.0.0.1', async () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        // Literal 127.0.0.1, not 'localhost' — on Windows 'localhost' can resolve to ::1 first, and the
        // browser's callback to an address the server never bound stalls or drops the code (see auth.ts).
        redirectUri = `http://127.0.0.1:${port}/callback`
        try {
          const registered = await registerClickupClient(redirectUri)
          if (!registered) {
            clearTimeout(timer)
            server.close()
            reject(new Error('ClickUp did not accept the automatic sign-in registration request. Try again later.'))
            return
          }
          clientId = registered
          const authUrl = buildAuthorizeUrl(clientId, redirectUri, challenge, state)
          await shell.openExternal(authUrl)
        } catch (e) {
          clearTimeout(timer)
          server.close()
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    })

    const result = await exchangeCodeForTokens(clientId, captured.code, captured.redirectUri, verifier)
    if (!result.ok) {
      auditLog('clickup.oauth.denied', {})
      return result
    }
    return result
  } catch (e) {
    auditLog('clickup.oauth.failed', { reason: coarseOAuthFailure(e) })
    return { ok: false, error: humanizeClickupOAuthError('', e instanceof Error ? e.message : String(e)) }
  } finally {
    releaseClickupTokenLock()
  }
}
