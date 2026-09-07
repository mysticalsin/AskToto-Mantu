import { describe, expect, it } from 'vitest'
import {
  CF_CALLBACK_PATH,
  CF_CONNECT_PATH,
  CF_OAUTH_AUTHORIZE,
  CF_OAUTH_COOKIE,
  CF_OAUTH_MISSING,
  CF_OAUTH_TOKEN
} from './cloudflare-connect'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_TEAM_DOMAIN, TEST_VAULT_KEY } from './test-fixtures'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'

const NOW = 1_725_000_000_000
const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }
const TOKEN = 'cf-oauth-access-token-xx42'
const ACCOUNT = '294885a27b3cc0a1cbe5d0ccbe38de4f'

function env(extra: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY,
    TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    CF_OAUTH_CLIENT_ID: 'cf-oauth-client-test',
    CF_OAUTH_CLIENT_SECRET: 'cf-oauth-secret-test',
    ...extra
  }
}

function cfFetch(input: RequestInfo | URL): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href)
  if (url.href === CF_OAUTH_TOKEN || url.pathname.endsWith('/oauth2/token')) {
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: TOKEN, token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  }
  if (url.pathname === '/client/v4/accounts' || url.pathname.endsWith('/accounts')) {
    return Promise.resolve(
      new Response(JSON.stringify({ result: [{ id: ACCOUNT, name: 'Tony' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  }
  if (url.pathname.includes('/ai-gateway/gateways')) {
    return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  }
  if (url.pathname.endsWith('/ai/v1/chat/completions')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok from AI Gateway' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
  }
  return Promise.resolve(new Response('{"success":false}', { status: 404 }))
}

describe('Cloudflare AI Gateway plug-and-play', () => {
  it('identity GET /cloudflare/connect 302s to Cloudflare OAuth, not a paste form', async () => {
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') || ''
    expect(loc.startsWith(CF_OAUTH_AUTHORIZE)).toBe(true)
    expect(loc).toContain('client_id=cf-oauth-client-test')
    expect(loc).toContain(encodeURIComponent('https://operator.test/cloudflare/callback'))
    expect(loc).toContain('response_type=code')
    expect(res.headers.get('set-cookie') || '').toContain(`${CF_OAUTH_COOKIE}=`)
    const body = await res.text()
    expect(body).not.toContain('Account ID')
    expect(body).not.toContain(TOKEN)
  })

  it('fails loud when the OAuth client is missing', async () => {
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env({ CF_OAUTH_CLIENT_ID: '', CF_OAUTH_CLIENT_SECRET: '' }),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: CF_OAUTH_MISSING })
  })

  it('callback exchanges the code and writes AI Gateway + account keys, last4 only', async () => {
    const store = memoryStore()
    const start = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const cookie = (start.headers.get('set-cookie') || '').split(';')[0]
    const loc = new URL(start.headers.get('location') || 'https://x.test')
    const state = loc.searchParams.get('state') || ''
    const cb = await handleRequest(
      new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-1&state=${state}`, {
        headers: { cookie }
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch }
    )
    expect(cb.status).toBe(303)
    expect(cb.headers.get('location')).toBe('/?cf=connected#keys')
    const vault = await store.listVaultMeta()
    expect(vault.map((v) => v.provider).sort()).toEqual(['cloudflare', 'cloudflare-account'])
    expect(vault.every((v) => v.last4 === 'xx42' && v.status === 'active')).toBe(true)
    expect(JSON.stringify(vault)).not.toContain(TOKEN)
    expect(JSON.stringify(await store.listEvents(10))).not.toContain(TOKEN)
  })

  it('authorized seat can /v1/use cloudflare after the provisioned key', async () => {
    const store = memoryStore()
    const start = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const cookie = (start.headers.get('set-cookie') || '').split(';')[0]
    const state = new URL(start.headers.get('location') || 'https://x.test').searchParams.get('state') || ''
    await handleRequest(
      new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-2&state=${state}`, {
        headers: { cookie }
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch }
    )
    await store.upsertSeat({
      device_id: 'device-aig',
      seat_hash: 'device-aig',
      os: 'darwin',
      app_version: '1.8.3',
      first_seen: NOW,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.5,
      lon: -73.5,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'tony.walteur@gmail.com',
      license: 'licensed',
      approval: 'approved'
    })
    const useBody = JSON.stringify({
      provider: 'cloudflare',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const ts = String(NOW)
    const nonce = 'use-aig'
    const deviceId = 'device-aig'
    const res = await handleRequest(
      new Request('https://operator.test/v1/use', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_HMAC_HEADERS.ts]: ts,
          [OPERATOR_HMAC_HEADERS.nonce]: nonce,
          [OPERATOR_HMAC_HEADERS.device]: deviceId,
          [OPERATOR_HMAC_HEADERS.sig]: await hmacHex(
            TEST_INGEST_SECRET,
            ingestCanonical(ts, nonce, deviceId, await sha256Hex(useBody))
          )
        },
        body: useBody
      }),
      env(),
      {},
      { store, now: NOW, providerFetch: cfFetch }
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; text?: string }
    expect(json).toEqual({ ok: true, text: 'ok from AI Gateway', inputTokens: 2, outputTokens: 3 })
    expect(JSON.stringify(json)).not.toContain(TOKEN)
  })

  it('Keys HTML keeps optional OAuth login and paste fields for cloudflare', async () => {
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    ).then((r) => r.text())
    expect(html).toContain('id="cf-connect"')
    expect(html).toContain('data-cf-aig-connect')
    expect(html).toContain('href="/cloudflare/connect"')
    expect(html).toContain('Log in to Cloudflare')
    expect(html).toContain('Cloudflare · AI Gateway')
    expect(html).toContain('Generate license')
    expect(html).not.toContain('data-cf-oauth-missing')
    expect(html).toContain('value="cloudflare"')
    expect(html).toContain('name="accountId"')
    expect(html).toContain('placeholder="API token"')
    expect(html).not.toContain('id="cf-add"')
  })
})
