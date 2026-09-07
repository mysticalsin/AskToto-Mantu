import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'
import { tokenPatternForTests } from './redact'
import { FORBIDDEN_VAULT_PROVIDERS } from './vault'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

describe('admin keys write / rotate / revoke', () => {
  it('adds a key, returns last4 only, and never echoes the secret', async () => {
    const store = memoryStore()
    const secret = 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-xx99'
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', label: 'Tony cloud', secret })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const written = (await res.json()) as { ok: boolean; id: string; last4: string; secret?: string }
    expect(written.ok).toBe(true)
    expect(written.last4).toBe('xx99')
    expect(written).not.toHaveProperty('secret')
    expect(JSON.stringify(written)).not.toContain(secret)
    expect(JSON.stringify(written)).not.toMatch(/cipher|\"iv\"/)

    const list = await handleRequest(
      new Request('https://operator.test/v1/admin/keys'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const body = (await list.json()) as {
      vault: { provider: string; last4: string; status: string }[]
      vaultBound: boolean
      oauthBound: boolean
    }
    expect(body.vaultBound).toBe(true)
    expect(body.vault).toEqual([
      expect.objectContaining({ provider: 'anthropic', last4: 'xx99', status: 'active' })
    ])
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(JSON.stringify(body)).not.toMatch(/\"cipher\"|\"iv\"/)

    const home = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toMatch(/text\/html/)
    const html = await home.text()
    expect(html).toContain('··xx99')
    expect(html).not.toContain(secret)
    expect(html).not.toContain('Seats keep their own keys')
    expect(html).toContain('Add an API')
    expect(html).toContain('id="key-add"')
    expect(html).toContain('id="cf-connect"')
    expect(html).toContain('href="/cloudflare/connect"')
    expect(html).toContain('data-cf-oauth-missing')
    expect(html).toContain('CF_OAUTH_CLIENT_ID')
    expect(body.oauthBound).toBe(false)
    expect(html).toContain('<th>Rotate</th>')
    expect(html).toContain('<th>Revoke</th>')
    expect(html).toContain('data-rotate=')
    expect(html).toContain('data-revoke=')
    expect(html).toContain('value="cloudflare"')
    expect(html).toContain('name="accountId"')
    expect(html).toContain('placeholder="API token"')
    expect(html).not.toContain('id="cf-add"')
    expect(html).toContain('data-page="keys"')
    expect(html).toContain('data-page="map"')
  })

  it('accepts provider=cloudflare with accountId and shows last4 only', async () => {
    const store = memoryStore()
    const secret = 'cf-api-token-TESTKEYONLY-not-a-real-secret-66fd'
    const accountId = '294885a27b3cc0a1cbe5d0ccbe38de4f'
    const missing = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cloudflare', label: 'Workers AI', secret })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ ok: false, error: 'accountId required' })

    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cloudflare', label: 'Workers AI', secret, accountId })
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch: async () => new Response('{"success":true}', { status: 200 }) }
    )
    expect(res.status).toBe(200)
    const written = (await res.json()) as { ok: boolean; last4: string; secret?: string; accountId?: string }
    expect(written.ok).toBe(true)
    expect(written.last4).toBe('66fd')
    expect(written).not.toHaveProperty('secret')
    expect(written).not.toHaveProperty('accountId')
    expect(JSON.stringify(written)).not.toContain(secret)
    expect(JSON.stringify(written)).not.toContain(accountId)

    const list = await handleRequest(
      new Request('https://operator.test/v1/admin/keys'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const body = (await list.json()) as { vault: { provider: string; last4: string; status: string }[] }
    expect(body.vault).toEqual([
      expect.objectContaining({ provider: 'cloudflare', last4: '66fd', status: 'active' })
    ])
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(JSON.stringify(body)).not.toMatch(/\"cipher\"|\"iv\"/)

    const home = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const html = await home.text()
    expect(html).toContain('··66fd')
    expect(html).toContain('cloudflare')
    expect(html).not.toContain(secret)
  })

  it('paste provider=cloudflare + accountId calls ensureDefaultAiGateway before Ask can run', async () => {
    const store = memoryStore()
    const secret = 'cf-api-token-TESTKEYONLY-not-a-real-secret-66fd'
    const accountId = '294885a27b3cc0a1cbe5d0ccbe38de4f'
    const gatewayPosts: { url: string; auth?: string; body?: string }[] = []
    const cfFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/ai-gateway/gateways')) {
        gatewayPosts.push({
          url,
          auth: init && typeof init === 'object' && 'headers' in init
            ? String((init.headers as Record<string, string>).authorization || '')
            : '',
          body: typeof init?.body === 'string' ? init.body : ''
        })
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response('{"success":false}', { status: 404 })
    }
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cloudflare', label: 'Workers AI', secret, accountId })
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch }
    )
    expect(res.status).toBe(200)
    expect(gatewayPosts).toHaveLength(1)
    expect(gatewayPosts[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`
    )
    expect(gatewayPosts[0]?.body).toBe(JSON.stringify({ id: 'default', name: 'default' }))
    expect(gatewayPosts[0]?.auth).toBe(`Bearer ${secret}`)
    const written = JSON.stringify(await res.json())
    expect(written).not.toContain(secret)
    expect(written).not.toContain(accountId)
    expect(written).not.toMatch(tokenPatternForTests())
  })

  it('anthropic paste does not call AI Gateway ensure', async () => {
    const store = memoryStore()
    const cfFetch = async () => {
      throw new Error('ensureDefaultAiGateway must not run for non-cloudflare paste')
    }
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          label: 'Tony cloud',
          secret: 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-xx99'
        })
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch: cfFetch as typeof fetch }
    )
    expect(res.status).toBe(200)
  })

  it('rejects CLI and Dust as vault providers', async () => {
    const store = memoryStore()
    for (const provider of FORBIDDEN_VAULT_PROVIDERS) {
      const res = await handleRequest(
        new Request('https://operator.test/v1/admin/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, secret: 'not-a-cli-token' })
        }),
        env(),
        { access: tony },
        { store, now: NOW }
      )
      expect(res.status, provider).toBe(400)
    }
    expect((await store.listVaultMeta()).length).toBe(0)
  })

  it('rotates and revokes with last4 only, and funds heartbeat from active LLM rows', async () => {
    const store = memoryStore()
    const created = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', secret: 'sk-proj-oldkey-abcd' })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const id = ((await created.json()) as { id: string }).id
    const rotated = await handleRequest(
      new Request(`https://operator.test/v1/admin/keys/${id}/rotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 'sk-proj-newkey-wxyz' })
      }),
      env(),
      { access: tony },
      { store, now: NOW + 1 }
    )
    const rot = (await rotated.json()) as { last4: string; secret?: string }
    expect(rot.last4).toBe('wxyz')
    expect(rot).not.toHaveProperty('secret')

    const { hmacHex } = await import('./hmac')
    const { sha256Hex } = await import('./crypto')
    const { ingestCanonical, OPERATOR_HMAC_HEADERS } = await import('../../src/shared/operator-hmac')
    const bodyText = JSON.stringify({ os: 'darwin', appVersion: '1.8.2' })
    const ts = String(NOW + 2)
    const nonce = 'keys-hb'
    const deviceId = 'device-keys'
    const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
    const beat = await handleRequest(
      new Request('https://operator.test/v1/heartbeat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_HMAC_HEADERS.ts]: ts,
          [OPERATOR_HMAC_HEADERS.nonce]: nonce,
          [OPERATOR_HMAC_HEADERS.device]: deviceId,
          [OPERATOR_HMAC_HEADERS.sig]: sig
        },
        body: bodyText
      }),
      env(),
      {},
      { store, now: NOW + 2 }
    )
    const hb = (await beat.json()) as { fundedProviders?: string[]; approved?: boolean }
    expect(hb.approved).toBe(false)
    expect(hb.fundedProviders).toEqual([])

    const approved = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/device-keys/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      env(),
      { access: tony },
      { store, now: NOW + 2 }
    )
    expect(approved.status).toBe(200)
    const beat2 = await handleRequest(
      new Request('https://operator.test/v1/heartbeat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_HMAC_HEADERS.ts]: String(NOW + 3),
          [OPERATOR_HMAC_HEADERS.nonce]: 'keys-hb-2',
          [OPERATOR_HMAC_HEADERS.device]: deviceId,
          [OPERATOR_HMAC_HEADERS.sig]: await hmacHex(
            TEST_INGEST_SECRET,
            ingestCanonical(String(NOW + 3), 'keys-hb-2', deviceId, await sha256Hex(bodyText))
          )
        },
        body: bodyText
      }),
      env(),
      {},
      { store, now: NOW + 3 }
    )
    const hb2 = (await beat2.json()) as { fundedProviders?: string[]; approved?: boolean }
    expect(hb2.approved).toBe(true)
    expect(hb2.fundedProviders).toEqual(['openai'])

    const revoked = await handleRequest(
      new Request(`https://operator.test/v1/admin/keys/${id}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }),
      env(),
      { access: tony },
      { store, now: NOW + 3 }
    )
    expect(((await revoked.json()) as { status: string }).status).toBe('revoked')
    const events = await store.listEvents(10)
    const blob = JSON.stringify(events)
    expect(blob).not.toMatch(tokenPatternForTests())
    expect(blob).not.toContain('sk-proj-newkey')
    expect(blob).not.toContain('sk-proj-oldkey')
  })

  it('mints a session cookie on Access console GET that authorizes POST /v1/admin/keys', async () => {
    const store = memoryStore()
    const home = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(home.status).toBe(200)
    const setCookie = home.headers.get('set-cookie') || ''
    expect(setCookie).toContain('metis_operator_session=')
    expect(setCookie).toContain('tony.walteur%40gmail.com')
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Lax/)
    const sessionPair = setCookie.split(';')[0]
    const token = home.headers.get('X-Metis-Session') || ''
    expect(token).toMatch(/^v1\|/)
    expect(token).toContain('tony.walteur@gmail.com')
    const html = await home.text()
    expect(html).not.toContain('name="metis-session"')
    expect(html).not.toContain(token)

    const who = await handleRequest(
      new Request('https://operator.test/session'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(who.status).toBe(200)
    const whoJson = (await who.json()) as { ok: boolean; session: string }
    expect(whoJson.ok).toBe(true)
    expect(whoJson.session).toMatch(/^v1\|/)
    expect(who.headers.get('X-Metis-Session')).toBe(whoJson.session)

    const created = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionPair },
        body: JSON.stringify({
          provider: 'anthropic',
          label: 'qa-walk',
          secret: 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-zz42'
        })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(created.status).toBe(200)
    const written = (await created.json()) as { ok: boolean; last4: string; error?: string }
    expect(written.ok).toBe(true)
    expect(written.last4).toBe('zz42')
    expect(written.error).toBeUndefined()

    const viaBearer = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          provider: 'anthropic',
          label: 'qa-walk-bearer',
          secret: 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-aa77'
        })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(viaBearer.status).toBe(200)
    expect(((await viaBearer.json()) as { last4: string }).last4).toBe('aa77')

    const forged = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'metis_operator_session=v1|9999999999999|tony.walteur@gmail.com|deadbeef'
        },
        body: JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-api03-TESTKEYONLY-nope' })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(forged.status).toBe(401)
    expect(await forged.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('requires Tony identity and never serves keys to a stranger', async () => {
    const denied = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-nope' })
      }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(denied.status).toBe(401)
    const other = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-nope' })
      }),
      env(),
      { access: { getIdentity: async () => ({ email: 'other@example.com' }) } },
      { store: memoryStore(), now: NOW }
    )
    expect(other.status).toBe(401)
  })
})
