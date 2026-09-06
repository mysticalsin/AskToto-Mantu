import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { decryptVault } from '../crypto'
import { memoryStore } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from '../test-fixtures'
import { readIntegrationExtra } from '../connectors/data'
import { mintOAuthState } from '../connectors/oauth'

const NOW = 1_725_000_000_000
const ORIGIN = 'https://operator.test'
const CALLBACK = `${ORIGIN}/v1/admin/connectors/oauth/callback`

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY,
    ...overrides
  } as Env
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function get(path: string): Request {
  return new Request(`${ORIGIN}${path}`)
}

describe('GET /v1/admin/connectors/:kind/oauth/start', () => {
  it('401s without Access identity', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/googledrive/oauth/start'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
  })

  it('400s a kind that has no OAuth config at all', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/hubspot/oauth/start'), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'not-oauth' })
  })

  it('400s a client-credentials kind (no browser flow exists for it)', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/salesforce/oauth/start'), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'not-oauth' })
  })

  it('503s naming the exact missing env vars when the OAuth client is unconfigured', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/googledrive/oauth/start'), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; missing: string[] }
    expect(body.code).toBe('oauth-unconfigured')
    expect(body.missing).toEqual(['OAUTH_GOOGLEDRIVE_CLIENT_ID', 'OAUTH_GOOGLEDRIVE_CLIENT_SECRET'])
  })

  it('503s naming only the one missing half when the other is already bound', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      get('/v1/admin/connectors/googledrive/oauth/start'),
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'client-id-only' }),
      { access: tony },
      { store, now: NOW }
    )
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(['OAUTH_GOOGLEDRIVE_CLIENT_SECRET'])
  })

  it('400s when a required tenant field (Zoho data centre) is missing from the query string', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      get('/v1/admin/connectors/zoho/oauth/start'),
      env({ OAUTH_ZOHO_CLIENT_ID: 'id', OAUTH_ZOHO_CLIENT_SECRET: 'secret' }),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'missing-field' })
  })

  it('302s to the vendor consent page with client_id, redirect_uri, scope, and state - PKCE params for a kind that supports it', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      get('/v1/admin/connectors/googledrive/oauth/start'),
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'g-client-id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'g-client-secret' }),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') || '')
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('client_id')).toBe('g-client-id')
    expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('scope')).toContain('drive.file')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('state')).toBeTruthy()

    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-oauth-start')).toBe(true)
  })

  it('templates the tenant field into the authorize URL host for a kind that needs one (Zoho)', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      get('/v1/admin/connectors/zoho/oauth/start?dataCenter=accounts.zoho.eu'),
      env({ OAUTH_ZOHO_CLIENT_ID: 'z-id', OAUTH_ZOHO_CLIENT_SECRET: 'z-secret' }),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') || '')
    expect(location.origin).toBe('https://accounts.zoho.eu')
    expect(location.pathname).toBe('/oauth/v2/auth')
  })
})

describe('GET /v1/admin/connectors/oauth/callback', () => {
  it('401s without Access identity', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/oauth/callback?code=x&state=y'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
  })

  it('shows a failure page (never a raw JSON 500) when the vendor reports ?error=', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/oauth/callback?error=access_denied'), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('Connection failed')
    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-oauth-failed')).toBe(true)
  })

  it('rejects a forged state (bad signature) with a failure page, never storing a row', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/oauth/callback?code=abc&state=not-a-real-state'), env(), { access: tony }, { store, now: NOW })
    const html = await res.text()
    expect(html).toContain('Connection failed')
    expect(await store.listIntegrationRows()).toHaveLength(0)
  })

  it('rejects a replayed state (the same state used twice)', async () => {
    const store = memoryStore()
    const state = await mintOAuthState(TEST_INGEST_SECRET, 'googledrive', 'tony.walteur@gmail.com', crypto.randomUUID(), NOW)
    const e = env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' })
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const first = await handleRequest(get(`/v1/admin/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`), e, { access: tony }, { store, now: NOW, providerFetch: fakeFetch })
    expect((await first.text())).toContain('Connected')
    const second = await handleRequest(get(`/v1/admin/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`), e, { access: tony }, { store, now: NOW + 1, providerFetch: fakeFetch })
    expect((await second.text())).toContain('Connection failed')
    expect(await store.listIntegrationRows()).toHaveLength(1) // only the first exchange ever stored a row
  })

  it('rejects a state minted for a different admin actor', async () => {
    const store = memoryStore()
    const state = await mintOAuthState(TEST_INGEST_SECRET, 'googledrive', 'someone-else@example.com', crypto.randomUUID(), NOW)
    const res = await handleRequest(
      get(`/v1/admin/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`),
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' }),
      { access: tony },
      { store, now: NOW }
    )
    const html = await res.text()
    expect(html).toContain('Connection failed')
    expect(html).toContain('different signed-in admin')
    expect(await store.listIntegrationRows()).toHaveLength(0)
  })

  it('rejects an expired state', async () => {
    const store = memoryStore()
    const state = await mintOAuthState(TEST_INGEST_SECRET, 'googledrive', 'tony.walteur@gmail.com', crypto.randomUUID(), NOW - 11 * 60_000)
    const res = await handleRequest(
      get(`/v1/admin/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`),
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' }),
      { access: tony },
      { store, now: NOW }
    )
    const html = await res.text()
    expect(html).toContain('invalid or has expired')
  })

  it('successfully exchanges the code and stores the tokens encrypted, mode brokered, last4 of the access token only - never the raw token in any JSON', async () => {
    const store = memoryStore()
    const nonce = crypto.randomUUID()
    const state = await mintOAuthState(TEST_INGEST_SECRET, 'googledrive', 'tony.walteur@gmail.com', nonce, NOW)
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body))
      expect(body.get('client_secret')).toBe('g-client-secret')
      return new Response(
        JSON.stringify({ access_token: 'ya29.super-secret-access-token', refresh_token: 'refresh-super-secret', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    const res = await handleRequest(
      get(`/v1/admin/connectors/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`),
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'g-client-id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'g-client-secret' }),
      { access: tony },
      { store, now: NOW, providerFetch: fakeFetch }
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Connected')
    expect(html).not.toContain('ya29.super-secret-access-token')
    expect(html).not.toContain('refresh-super-secret')

    const rows = await store.listIntegrationRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('googledrive')
    expect(row.status).toBe('active')
    expect(row.last4).toBe(row.last4 && 'oken') // last4 of "...access-token"
    expect(row.cipher).not.toContain('ya29')
    expect(row.iv).toBeTruthy()
    const extra = readIntegrationExtra(row as unknown as Record<string, unknown>)
    expect(extra.mode).toBe('brokered')

    const decrypted = await decryptVault(row.cipher!, row.iv!, TEST_VAULT_KEY)
    expect(JSON.parse(decrypted)).toMatchObject({ accessToken: 'ya29.super-secret-access-token', refreshToken: 'refresh-super-secret' })

    const audit = await store.listAudit(10)
    const connected = audit.find((a) => a.action === 'integration-oauth-connected')
    expect(connected).toBeTruthy()
    expect(connected!.detail).not.toContain('ya29')
    expect(connected!.detail).not.toContain('refresh-super-secret')
  })

  it('a failed exchange (upstream rejects the code) shows a failure page and stores nothing', async () => {
    const store = memoryStore()
    const state = await mintOAuthState(TEST_INGEST_SECRET, 'googledrive', 'tony.walteur@gmail.com', crypto.randomUUID(), NOW)
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    const res = await handleRequest(
      get(`/v1/admin/connectors/oauth/callback?code=bad-code&state=${encodeURIComponent(state)}`),
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' }),
      { access: tony },
      { store, now: NOW, providerFetch: fakeFetch }
    )
    const html = await res.text()
    expect(html).toContain('Connection failed')
    expect(await store.listIntegrationRows()).toHaveLength(0)
  })
})
