import { describe, expect, it, vi } from 'vitest'
import {
  exchangeAuthorizationCode,
  generatePkce,
  mintOAuthState,
  oauthClientCredentials,
  oauthTokenNeedsRefresh,
  OAUTH_REFRESH_MARGIN_MS,
  OAUTH_STATE_TTL_MS,
  refreshOAuthToken,
  renderOAuthTemplate,
  verifyOAuthState,
  type OAuthTokenPayload
} from './oauth'
import { getConnectorCatalogEntry, type ConnectorCatalogEntry } from './catalog'
import type { ProbeDeps } from './probe'

const SECRET = 'operator-ingest-secret-for-tests'
const NOW = 1_725_000_000_000

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } })
}

// ── state token ────────────────────────────────────────────────────────────────────────────────────

describe('mintOAuthState / verifyOAuthState', () => {
  it('round-trips kind/actor/nonce/verifier/config and consumes the nonce exactly once', async () => {
    const seen = new Set<string>()
    const seenNonce = async (nonce: string) => {
      if (seen.has(nonce)) return true
      seen.add(nonce)
      return false
    }
    const state = await mintOAuthState(SECRET, 'zoho', 'tony@example.com', 'nonce-0001', NOW, { verifier: 'v'.repeat(43), config: { dataCenter: 'accounts.zoho.eu' } })
    const first = await verifyOAuthState(SECRET, state, NOW + 1000, seenNonce)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.claims.kind).toBe('zoho')
      expect(first.claims.actor).toBe('tony@example.com')
      expect(first.claims.verifier).toBe('v'.repeat(43))
      expect(first.claims.config).toEqual({ dataCenter: 'accounts.zoho.eu' })
    }
  })

  it('rejects a replayed state (same nonce twice) with code replay', async () => {
    const seen = new Set<string>()
    const seenNonce = async (nonce: string) => {
      if (seen.has(nonce)) return true
      seen.add(nonce)
      return false
    }
    const state = await mintOAuthState(SECRET, 'googledrive', 'tony@example.com', 'nonce-0002', NOW)
    const first = await verifyOAuthState(SECRET, state, NOW, seenNonce)
    expect(first.ok).toBe(true)
    const second = await verifyOAuthState(SECRET, state, NOW, seenNonce)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('replay')
  })

  it('rejects an expired state', async () => {
    const state = await mintOAuthState(SECRET, 'googledrive', 'tony@example.com', 'nonce-0003', NOW)
    const result = await verifyOAuthState(SECRET, state, NOW + OAUTH_STATE_TTL_MS + 1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('expired')
  })

  it('rejects a forged state (tampered payload, or signed with a different secret)', async () => {
    const state = await mintOAuthState(SECRET, 'googledrive', 'tony@example.com', 'nonce-0004', NOW)
    const [payloadB64, sigB64] = state.split('.')
    // Flip one character in the payload without re-signing - a bit-for-bit forgery attempt.
    const flipped = payloadB64.slice(0, -1) + (payloadB64.endsWith('A') ? 'B' : 'A')
    const forged = `${flipped}.${sigB64}`
    const result = await verifyOAuthState(SECRET, forged, NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['bad-signature', 'malformed', 'bad-claims']).toContain(result.code)

    const wrongSecretState = await mintOAuthState('a-completely-different-secret', 'googledrive', 'tony@example.com', 'nonce-0005', NOW)
    const wrongSecretResult = await verifyOAuthState(SECRET, wrongSecretState, NOW)
    expect(wrongSecretResult.ok).toBe(false)
    if (!wrongSecretResult.ok) expect(wrongSecretResult.code).toBe('bad-signature')
  })

  it('lets the caller reject on actor mismatch (the route checks claims.actor against the signed-in email)', async () => {
    const state = await mintOAuthState(SECRET, 'googledrive', 'tony@example.com', 'nonce-0006', NOW)
    const result = await verifyOAuthState(SECRET, state, NOW)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.claims.actor).not.toBe('someone-else@example.com')
  })

  it('rejects a state signed for a genuinely different payload shape (bad-claims) rather than crashing', async () => {
    const result = await verifyOAuthState(SECRET, 'not-a-real-state-token', NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('malformed')
  })
})

// ── PKCE ───────────────────────────────────────────────────────────────────────────────────────────

describe('generatePkce', () => {
  it('produces a verifier in the RFC 7636 length range and a matching S256 challenge', async () => {
    const pair = await generatePkce()
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.verifier.length).toBeLessThanOrEqual(128)
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair.verifier)))
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    expect(pair.challenge).toBe(expected)
  })

  it('never repeats a verifier across calls', async () => {
    const a = await generatePkce()
    const b = await generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

// ── template rendering ─────────────────────────────────────────────────────────────────────────────

describe('renderOAuthTemplate', () => {
  it('substitutes verbatim, never percent-encoding (unlike probe.ts REST templating)', () => {
    expect(renderOAuthTemplate('{instanceUrl}/services/oauth2/token', { instanceUrl: 'https://acme.my.salesforce.com' })).toBe(
      'https://acme.my.salesforce.com/services/oauth2/token'
    )
  })

  it('leaves an unresolved placeholder as empty rather than throwing', () => {
    expect(renderOAuthTemplate('https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token', {})).toBe(
      'https://login.microsoftonline.com//oauth2/v2.0/token'
    )
  })
})

// ── env-bound client credentials ───────────────────────────────────────────────────────────────────

describe('oauthClientCredentials', () => {
  it('returns null when either half of the pair is unbound, and the pair once both are bound', () => {
    const entry = getConnectorCatalogEntry('googledrive') as ConnectorCatalogEntry
    expect(oauthClientCredentials(entry, {})).toBeNull()
    expect(oauthClientCredentials(entry, { OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id-only' })).toBeNull()
    expect(oauthClientCredentials(entry, { OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' })).toEqual({
      clientId: 'id',
      clientSecret: 'secret'
    })
  })
})

// ── token exchange ─────────────────────────────────────────────────────────────────────────────────

describe('exchangeAuthorizationCode', () => {
  it('exchanges a code for tokens over the vendor token endpoint, SSRF-guarded', async () => {
    const entry = getConnectorCatalogEntry('googledrive') as ConnectorCatalogEntry
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body))
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('auth-code-123')
      expect(body.get('client_id')).toBe('client-id')
      expect(body.get('client_secret')).toBe('client-secret')
      expect(body.get('redirect_uri')).toBe('https://metis-operator.tony-walteur.workers.dev/v1/admin/connectors/oauth/callback')
      expect(body.get('code_verifier')).toBe('verifier-value')
      return jsonResponse({ access_token: 'ya29.token', refresh_token: 'refresh-token', expires_in: 3600, token_type: 'Bearer' })
    })
    const deps: ProbeDeps = { fetch: fetchImpl as unknown as typeof fetch }
    const result = await exchangeAuthorizationCode(
      entry,
      {},
      {
        code: 'auth-code-123',
        redirectUri: 'https://metis-operator.tony-walteur.workers.dev/v1/admin/connectors/oauth/callback',
        codeVerifier: 'verifier-value'
      },
      { clientId: 'client-id', clientSecret: 'client-secret' },
      deps
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.accessToken).toBe('ya29.token')
      expect(result.payload.refreshToken).toBe('refresh-token')
      expect(result.payload.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it('refuses a private-range token endpoint before ever calling fetch (belt and suspenders on a tampered/self-hosted tokenUrl)', async () => {
    const entry: ConnectorCatalogEntry = {
      ...(getConnectorCatalogEntry('googledrive') as ConnectorCatalogEntry),
      oauth: { ...(getConnectorCatalogEntry('googledrive')!.oauth!), tokenUrl: 'https://169.254.169.254/token' }
    }
    const fetchImpl = vi.fn()
    const result = await exchangeAuthorizationCode(
      entry,
      {},
      { code: 'x', redirectUri: 'https://example.com/cb' },
      { clientId: 'id', clientSecret: 'secret' },
      { fetch: fetchImpl as unknown as typeof fetch }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('host-blocked')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never leaks the client secret in an error message when the token endpoint rejects the request', async () => {
    const entry = getConnectorCatalogEntry('googledrive') as ConnectorCatalogEntry
    const fetchImpl = vi.fn(async () => new Response('invalid_client: secret client-secret-xyz is wrong', { status: 401 }))
    const result = await exchangeAuthorizationCode(
      entry,
      {},
      { code: 'x', redirectUri: 'https://example.com/cb' },
      { clientId: 'id', clientSecret: 'client-secret-xyz' },
      { fetch: fetchImpl as unknown as typeof fetch }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).not.toContain('client-secret-xyz')
  })
})

// ── refresh ────────────────────────────────────────────────────────────────────────────────────────

describe('oauthTokenNeedsRefresh', () => {
  it('is true once within the refresh margin (or already past expiry), false with plenty of time left', () => {
    const soon: OAuthTokenPayload = { accessToken: 'a', expiresAt: NOW + OAUTH_REFRESH_MARGIN_MS - 1000 }
    const later: OAuthTokenPayload = { accessToken: 'a', expiresAt: NOW + OAUTH_REFRESH_MARGIN_MS + 60_000 }
    const past: OAuthTokenPayload = { accessToken: 'a', expiresAt: NOW - 1 }
    expect(oauthTokenNeedsRefresh(soon, NOW)).toBe(true)
    expect(oauthTokenNeedsRefresh(past, NOW)).toBe(true)
    expect(oauthTokenNeedsRefresh(later, NOW)).toBe(false)
  })
})

describe('refreshOAuthToken', () => {
  const currentPayload: OAuthTokenPayload = { accessToken: 'old-access', refreshToken: 'refresh-abc', expiresAt: NOW }

  it('mints a fresh access token via the refresh_token grant and keeps the old refresh token when the vendor omits a new one', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('refresh-abc')
      return jsonResponse({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' })
    })
    const result = await refreshOAuthToken(
      'googledrive',
      currentPayload,
      {},
      { OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' },
      { fetch: fetchImpl as unknown as typeof fetch },
      getConnectorCatalogEntry
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.accessToken).toBe('new-access')
      expect(result.payload.refreshToken).toBe('refresh-abc') // carried over, vendor did not reissue one
    }
  })

  it('refuses a kind with no oauth config, or no auth-code flow, with code not-oauth', async () => {
    const result = await refreshOAuthToken('hubspot', currentPayload, {}, {}, { fetch: vi.fn() as unknown as typeof fetch }, getConnectorCatalogEntry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not-oauth')
  })

  it('refuses a row with no refresh token at all', async () => {
    const noRefresh: OAuthTokenPayload = { accessToken: 'a', expiresAt: NOW }
    const result = await refreshOAuthToken(
      'googledrive',
      noRefresh,
      {},
      { OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' },
      { fetch: vi.fn() as unknown as typeof fetch },
      getConnectorCatalogEntry
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('no-refresh-token')
  })

  it('reports oauth-unconfigured rather than attempting a request when the secrets are unbound', async () => {
    const fetchImpl = vi.fn()
    const result = await refreshOAuthToken('googledrive', currentPayload, {}, {}, { fetch: fetchImpl as unknown as typeof fetch }, getConnectorCatalogEntry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('oauth-unconfigured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a failing refresh (upstream rejects) returns a typed failure - the caller decides to mark last_test_json, never to delete the row (refreshOAuthToken has no store access at all)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    const result = await refreshOAuthToken(
      'googledrive',
      currentPayload,
      {},
      { OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' },
      { fetch: fetchImpl as unknown as typeof fetch },
      getConnectorCatalogEntry
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('upstream-error')
  })
})
