import { reviewedGatewayReply, reviewedGatewayFetch } from './ai-gateway.privacy-fixture'
import { describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_ADMIN_EMAILS, TEST_VAULT_KEY, syntheticProviderKey } from './test-fixtures'
import { tokenPatternForTests } from './redact'
import { parseUseBody, withProviderTimeout } from './use'
import { PORTAL_CF_DEEPSEEK_FLASH, PORTAL_CF_DEEPSEEK_PRO } from '../../src/shared/ask-routing'

const NOW = 1_725_000_000_000
const SECRET = syntheticProviderKey('anthropic')
const SCREENSHOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const ownerAccess = { getIdentity: async () => ({ email: 'owner@example.test' }) }

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
    hostname: 'Example-MacBook-Pro',
    sso_email: 'owner@example.test',
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
    { access: ownerAccess },
    { store, now: NOW }
  )
  expect(res.status).toBe(200)
}

async function addCloudflareKey(store: ReturnType<typeof memoryStore>) {
  const res = await handleRequest(
    new Request('https://operator.test/v1/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'cloudflare', secret: SECRET, accountId: 'acct-test' })
    }),
    env(),
    { access: ownerAccess },
    { store, now: NOW, cfFetch: reviewedGatewayFetch }
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
      error: 'This seat is not approved. The owner must approve this device in Operator before platform keys work.'
    })
  })

  it.each([
    { label: 'an explicit deep Cloudflare request', provider: 'cloudflare', model: PORTAL_CF_DEEPSEEK_PRO, tier: 'deep' },
    { label: 'a legacy Portal Pro Cloudflare request', provider: 'cloudflare', model: PORTAL_CF_DEEPSEEK_PRO },
    { label: 'a base Flash Cloudflare request', provider: 'cloudflare', model: PORTAL_CF_DEEPSEEK_FLASH, tier: 'base' },
    { label: 'a base Anthropic request', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tier: 'base' }
  ] as const)('refuses $label when the server-side tier lacks operator_keys', async ({ provider, model, tier }) => {
    const store = memoryStore()
    if (provider === 'cloudflare') await addCloudflareKey(store)
    else await addAnthropicKey(store)
    await approveDevice(store)
    await store.putTier({
      id: 'metis',
      label: 'Métis',
      entitlements_json: JSON.stringify(['ask']),
      updated_at: NOW
    })
    const providerFetch = vi.fn(async (input) => {
      if (String(input).includes('/ai-gateway/gateways')) {
        return reviewedGatewayReply()
      }
      return provider === 'anthropic'
        ? new Response(JSON.stringify({ content: [{ type: 'text', text: 'unexpected upstream call' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'unexpected upstream call' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const body = JSON.stringify({
      provider,
      model,
      ...(tier ? { tier } : {}),
      messages: [{ role: 'user', content: 'Use the Operator-funded vault key.' }]
    })

    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-not-entitled'), env(), {}, {
      store,
      now: NOW,
      providerFetch
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, code: 'not-entitled' })
    expect(providerFetch).not.toHaveBeenCalled()
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

  it('refuses a cloudflare use when the gateway privacy readback finds an unsafe configuration, and never calls the model', async () => {
    const store = memoryStore()
    await addCloudflareKey(store)
    await approveDevice(store)
    const calls: string[] = []
    const providerFetch: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/ai-gateway/gateways')) {
        return new Response(JSON.stringify({
          success: true, result: { id: 'default', collect_logs: true, cache_ttl: 0, logpush: false }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error('must not call the chat-completions endpoint when privacy is unverified')
    }
    const body = JSON.stringify({
      provider: 'cloudflare',
      model: PORTAL_CF_DEEPSEEK_FLASH,
      tier: 'base',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-unsafe-gateway'), env(), {}, {
      store, now: NOW, providerFetch
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, code: 'GATEWAY_CONFIGURATION_UNSAFE' })
    expect(calls.some((u) => u.includes('/ai/v1/chat/completions'))).toBe(false)
  })

  it('binds the persisted ask row to the caller-supplied clientAskId', async () => {
    const store = memoryStore()
    await addAnthropicKey(store)
    await approveDevice(store)
    const clientAskId = 'client-ask-00000001'
    const body = JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      clientAskId,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const providerFetch: typeof fetch = async () =>
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-client-ask'), env(), {}, {
      store, now: NOW, providerFetch
    })
    expect(res.status).toBe(200)
    expect(await store.getAsk(clientAskId)).toMatchObject({
      device_id: 'device-use',
      provider: 'anthropic',
      outcome: 'answered',
      input_tokens: 5,
      output_tokens: 2
    })
  })

  it('drops fractional or negative provider usage from the response and stores it as null', async () => {
    const store = memoryStore()
    await addAnthropicKey(store)
    await approveDevice(store)
    const clientAskId = 'client-ask-fractional1'
    const body = JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      clientAskId,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const providerFetch: typeof fetch = async () =>
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 12.5, output_tokens: -3 }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    const res = await handleRequest(await signedRequest('/v1/use', body, 'use-fractional'), env(), {}, {
      store, now: NOW, providerFetch
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).not.toHaveProperty('inputTokens')
    expect(json).not.toHaveProperty('outputTokens')
    expect(await store.getAsk(clientAskId)).toMatchObject({ input_tokens: null, output_tokens: null })
  })
})

describe('withProviderTimeout', () => {
  it('honours a shorter caller-supplied signal instead of always widening it to the provider timeout', async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const inner: typeof fetch = async (_input, init) => {
      seenSignal = init?.signal ?? undefined
      return new Response('{}', { status: 200 })
    }
    controller.abort()
    const wrapped = withProviderTimeout(inner)
    await wrapped('https://example.test', { signal: controller.signal })
    expect(seenSignal?.aborted).toBe(true)
  })

  it('still bounds the call by its own timeout when no caller signal is given', async () => {
    let seenSignal: AbortSignal | undefined
    const inner: typeof fetch = async (_input, init) => {
      seenSignal = init?.signal ?? undefined
      return new Response('{}', { status: 200 })
    }
    const wrapped = withProviderTimeout(inner)
    await wrapped('https://example.test', {})
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal?.aborted).toBe(false)
  })
})
