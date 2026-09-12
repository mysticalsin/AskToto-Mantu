import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'
import { tokenPatternForTests } from './redact'
import { parseUseBody } from './use'

const NOW = 1_725_000_000_000
const SECRET = 'sk-ant-api03-OPERATOR-VAULT-TEST-only-xx99'
const SCREENSHOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

async function signedRequest(path: string, bodyText: string, nonce = `use-${Math.random().toString(16).slice(2)}`) {
  const ts = String(NOW)
  const deviceId = 'device-use'
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

async function approveDevice(store: ReturnType<typeof memoryStore>, deviceId = 'device-use') {
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

async function addAnthropicKey(store: ReturnType<typeof memoryStore>) {
  const res = await handleRequest(
    new Request('https://operator.test/v1/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', secret: SECRET })
    }),
    env(),
    { access: tony },
    { store, now: NOW }
  )
  expect(res.status).toBe(200)
}

describe('parseUseBody', () => {
  it('rejects missing screenshots, CLI, Dust, and image payloads hidden in text', () => {
    expect(parseUseBody(JSON.stringify({ provider: 'anthropic', model: 'claude', mode: 'vision', messages: [{ role: 'user', content: 'hi' }] })).ok).toBe(false)
    expect(parseUseBody(JSON.stringify({ provider: 'claude-cli', model: 'sonnet', messages: [{ role: 'user', content: 'hi' }] })).ok).toBe(false)
    expect(parseUseBody(JSON.stringify({ provider: 'dust', model: 'agent', messages: [{ role: 'user', content: 'hi' }] })).ok).toBe(false)
    expect(
      parseUseBody(
        JSON.stringify({
          provider: 'cloudflare',
          model: '@cf/meta/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: 'hi' }]
        })
      ).ok
    ).toBe(true)
    expect(
      parseUseBody(
        JSON.stringify({
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'data:image/jpeg;base64,abc' }]
        })
      ).ok
    ).toBe(false)
  })

  it('accepts a bounded explicit PNG screenshot and keeps the latest user question with long history', () => {
    const result = parseUseBody(JSON.stringify({
      provider: 'openai', model: 'gpt-4o-mini', mode: 'vision',
      image: { mimeType: 'image/png', data: SCREENSHOT_PNG },
      messages: [
        ...Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `old question ${i}` })),
        { role: 'user', content: 'Read this screen, not an old question.' }
      ]
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.req).toMatchObject({ image: { mimeType: 'image/png', data: SCREENSHOT_PNG } })
    expect(result.req.messages).toHaveLength(20)
    expect(result.req.messages.at(-1)?.content).toBe('Read this screen, not an old question.')
  })

  it.each([
    ['missing opt-in', { mimeType: 'image/png', data: SCREENSHOT_PNG }, undefined],
    ['wrong mode', { mimeType: 'image/png', data: SCREENSHOT_PNG }, 'answer'],
    ['malformed base64', { mimeType: 'image/png', data: 'not base64!' }, 'vision'],
    ['bad padding', { mimeType: 'image/png', data: SCREENSHOT_PNG.slice(0, -1) }, 'vision'],
    ['data URL', { mimeType: 'image/png', data: `data:image/png;base64,${SCREENSHOT_PNG}` }, 'vision'],
    ['remote URL', { mimeType: 'image/png', data: 'https://example.test/private.png' }, 'vision'],
    ['SVG', { mimeType: 'image/svg+xml', data: SCREENSHOT_PNG }, 'vision'],
    ['MIME mismatch', { mimeType: 'image/jpeg', data: SCREENSHOT_PNG }, 'vision'],
    ['invalid file', { mimeType: 'image/png', data: btoa('a text file is not a screenshot') }, 'vision'],
    ['oversize file', { mimeType: 'image/png', data: 'A'.repeat(5_500_004) }, 'vision']
  ])('rejects %s without returning the image content in an error', (_name, image, mode) => {
    const result = parseUseBody(JSON.stringify({
      provider: 'openai', model: 'gpt-4o-mini', mode, image,
      messages: [{ role: 'user', content: 'Read this screen.' }]
    }))
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(JSON.stringify(result)).not.toContain(SCREENSHOT_PNG)
  })
})

describe('HMAC POST /v1/use', () => {
  it('requires HMAC and never returns a vault secret', async () => {
    const store = memoryStore()
    await addAnthropicKey(store)
    await approveDevice(store)
    const bare = await handleRequest(
      new Request('https://operator.test/v1/use', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(bare.status).toBe(401)
    expect(await bare.json()).toEqual({ ok: false, error: 'missing HMAC headers' })

    const body = JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Say ok.' }]
    })
    const providerFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok from Operator' }],
          usage: { input_tokens: 12, output_tokens: 3 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-ok'), env(), {}, {
      store,
      now: NOW,
      providerFetch
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; text?: string; secret?: string; cipher?: string }
    expect(json).toEqual({ ok: true, text: 'ok from Operator', inputTokens: 12, outputTokens: 3 })
    expect(json).not.toHaveProperty('secret')
    expect(json).not.toHaveProperty('cipher')
    expect(json).not.toHaveProperty('iv')
    expect(json).not.toHaveProperty('last4')
    expect(JSON.stringify(json)).not.toContain(SECRET)
    expect(JSON.stringify(json)).not.toMatch(tokenPatternForTests())
  })

  it('403s loud when the seat is not approved', async () => {
    const store = memoryStore()
    await addAnthropicKey(store)
    const body = JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-pending'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'This seat is not approved. Tony must approve this device in Operator before platform keys work.'
    })
  })

  it('fails closed when the provider is not funded and never echoes the vault row', async () => {
    const store = memoryStore()
    await approveDevice(store)
    const body = JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-empty'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(503)
    const json = (await res.json()) as { error?: string }
    expect(json.error).toBe('Operator cannot issue a use')
    expect(JSON.stringify(json)).not.toContain(SECRET)
  })

  it('writes a token-free use event', async () => {
    const store = memoryStore()
    await addAnthropicKey(store)
    await approveDevice(store)
    const body = JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const providerFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 })
    await handleRequest(await signedRequest('/v1/use', body, 'use-event'), env(), {}, { store, now: NOW, providerFetch })
    const events = await store.listEvents(10)
    expect(events.some((e) => e.kind === 'use' && e.detail === 'use anthropic')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(SECRET)
    expect(JSON.stringify(events)).not.toMatch(tokenPatternForTests())
  })
})
