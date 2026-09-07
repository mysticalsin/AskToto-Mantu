import { describe, expect, it } from 'vitest'
import { ACCESS_BYPASS_PATHS } from './access'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'
import { tokenPatternForTests } from './redact'
import { parseUseBody } from './use'
import { PORTAL_CF_DEEPSEEK_FLASH } from '../../src/shared/ask-routing'

const NOW = 1_725_000_000_000
const SECRET = 'sk-cf-OPERATOR-VAULT-TEST-only-xx99'

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

async function signedRequest(path: string, bodyText: string, nonce = `ask-${Math.random().toString(16).slice(2)}`) {
  const ts = String(NOW)
  const deviceId = 'device-ask'
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
  return new Request(`https://operator.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: sig
    },
    body: bodyText
  })
}

async function approveDevice(store: ReturnType<typeof memoryStore>, deviceId = 'device-ask') {
  await store.upsertSeat({
    device_id: deviceId,
    seat_hash: deviceId,
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
}

function gatewayOkFetch(): typeof fetch {
  return async (input) => {
    const url = String(input)
    if (url.includes('/ai-gateway/gateways')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    return new Response('{"success":false}', { status: 404 })
  }
}

async function addCloudflareKey(store: ReturnType<typeof memoryStore>) {
  const res = await handleRequest(
    new Request('https://operator.test/v1/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'cloudflare', secret: SECRET, accountId: 'acct-test' })
    }),
    env(),
    { access: tony },
    { store, now: NOW, cfFetch: gatewayOkFetch() }
  )
  expect(res.status).toBe(200)
}

function sseUpstream(text = 'hello from CF'): typeof fetch {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\n`,
    'data: [DONE]\n\n'
  ]
  return async () =>
    new Response(frames.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    })
}

describe('G10 Access bypass + rate limit for /v1/ask', () => {
  it('lists /v1/ask next to /v1/use for Cloudflare Access Bypass', () => {
    expect(ACCESS_BYPASS_PATHS).toContain('/v1/ask')
    expect(ACCESS_BYPASS_PATHS).toContain('/v1/use')
  })

  it('unauthenticated POST is HMAC 401 JSON, never an Access redirect', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'cloudflare', model: PORTAL_CF_DEEPSEEK_FLASH, messages: [{ role: 'user', content: 'hi' }] })
      }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.json()).toEqual({ ok: false, error: 'missing HMAC headers' })
  })

  it('rate-limits /v1/ask in the same family as /v1/use', async () => {
    const store = memoryStore()
    await addCloudflareKey(store)
    await approveDevice(store)
    const body = JSON.stringify({
      provider: 'cloudflare',
      model: PORTAL_CF_DEEPSEEK_FLASH,
      messages: [{ role: 'user', content: 'hi' }]
    })
    let limited = 0
    for (let i = 0; i < 121; i++) {
      const res = await handleRequest(await signedRequest('/v1/ask', body, `ask-rl-${i}`), env(), {}, {
        store,
        now: NOW,
        providerFetch: sseUpstream()
      })
      if (res.status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })
})

describe('G5 POST /v1/ask SSE', () => {
  it('rejects a caller-supplied key in the Ask body', () => {
    expect(
      parseUseBody(
        JSON.stringify({
          provider: 'cloudflare',
          model: PORTAL_CF_DEEPSEEK_FLASH,
          apiKey: SECRET,
          messages: [{ role: 'user', content: 'hi' }]
        })
      ).ok
    ).toBe(false)
  })

  it('403s when the seat is not approved and never leaks the vault', async () => {
    const store = memoryStore()
    await addCloudflareKey(store)
    const body = JSON.stringify({
      provider: 'cloudflare',
      model: PORTAL_CF_DEEPSEEK_FLASH,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = await handleRequest(await signedRequest('/v1/ask', body, 'ask-pending'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error?: string }
    expect(json.error).toMatch(/not approved/)
    expect(JSON.stringify(json)).not.toContain(SECRET)
  })

  it('streams CF REST through SSE and never returns the vault secret', async () => {
    const store = memoryStore()
    await addCloudflareKey(store)
    await approveDevice(store)
    const body = JSON.stringify({
      provider: 'cloudflare',
      model: PORTAL_CF_DEEPSEEK_FLASH,
      messages: [{ role: 'user', content: 'Say ok.' }]
    })
    const res = await handleRequest(await signedRequest('/v1/ask', body, 'ask-ok'), env(), {}, {
      store,
      now: NOW,
      providerFetch: sseUpstream('ok from Operator')
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') || '').toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"t":"delta"')
    expect(text).toContain('ok from Operator')
    expect(text).toContain('"t":"done"')
    expect(text).not.toContain(SECRET)
    expect(text).not.toMatch(tokenPatternForTests())
    const asks = await store.listAsks(5)
    expect(asks.some((a) => a.path_tag === 'portal-cf' && a.provider === 'cloudflare')).toBe(true)
  })

  it('502 provider refused includes redacted upstream status + snippet, never the vault secret or prompt', async () => {
    const store = memoryStore()
    await addCloudflareKey(store)
    await approveDevice(store)
    const prompt = 'SECRET_PROMPT_DO_NOT_ECHO this is a long user prompt that must not ship back'
    const body = JSON.stringify({
      provider: 'cloudflare',
      model: PORTAL_CF_DEEPSEEK_FLASH,
      messages: [{ role: 'user', content: prompt }]
    })
    const res = await handleRequest(await signedRequest('/v1/ask', body, 'ask-502'), env(), {}, {
      store,
      now: NOW,
      providerFetch: async (input) => {
        const url = String(input)
        if (url.includes('/ai-gateway/gateways')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 2011, message: `Gateway not found Authorization: Bearer ${SECRET}` }],
            messages: [{ role: 'user', content: prompt }]
          }),
          { status: 400 }
        )
      }
    })
    expect(res.status).toBe(502)
    const json = (await res.json()) as {
      ok: boolean
      error: string
      upstreamStatus?: number
      upstreamSnippet?: string
    }
    expect(json.ok).toBe(false)
    expect(json.error).toContain('provider refused the Operator key')
    expect(json.upstreamStatus).toBe(400)
    expect(json.upstreamSnippet).toContain('Gateway not found')
    expect(json.upstreamSnippet).toContain('2011')
    expect(json.upstreamSnippet?.length).toBeLessThanOrEqual(200)
    const blob = JSON.stringify(json)
    expect(blob).not.toContain(SECRET)
    expect(blob).not.toContain(prompt)
    expect(blob).not.toMatch(/Bearer /i)
    expect(blob).not.toMatch(tokenPatternForTests())
  })
})
