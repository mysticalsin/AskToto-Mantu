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
const OPENAI_SECRET = 'sk-OPENAI-OPERATOR-VAULT-TEST-only-xx99'
const ANTHROPIC_SECRET = 'sk-ant-api03-OPERATOR-VAULT-TEST-only-xx99'

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

async function signedRequest(
  path: string,
  bodyText: string,
  nonce = `ask-${Math.random().toString(16).slice(2)}`,
  signal?: AbortSignal
) {
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
    body: bodyText,
    signal
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

async function addProviderKey(
  store: ReturnType<typeof memoryStore>,
  provider: 'openai' | 'anthropic',
  secret: string
) {
  const res = await handleRequest(
    new Request('https://operator.test/v1/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, secret })
    }),
    env(),
    { access: tony },
    { store, now: NOW }
  )
  expect(res.status).toBe(200)
}

function upstream(body: BodyInit, contentType = 'text/event-stream; charset=utf-8'): typeof fetch {
  return async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

function events(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
}

async function askProvider(
  provider: 'openai' | 'anthropic',
  providerFetch: typeof fetch,
  nonce: string
): Promise<{ store: ReturnType<typeof memoryStore>; response: Response }> {
  const store = memoryStore()
  await addProviderKey(store, provider, provider === 'openai' ? OPENAI_SECRET : ANTHROPIC_SECRET)
  await approveDevice(store)
  const response = await askProviderWithStore(store, provider, providerFetch, nonce)
  return { store, response }
}

async function askProviderWithStore(
  store: ReturnType<typeof memoryStore>,
  provider: 'openai' | 'anthropic',
  providerFetch: typeof fetch,
  nonce: string,
  signal?: AbortSignal
): Promise<Response> {
  const body = JSON.stringify({
    provider,
    model: provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'Say ok.' }]
  })
  return handleRequest(await signedRequest('/v1/ask', body, nonce, signal), env(), {}, {
    store,
    now: NOW,
    providerFetch
  })
}

function sseUpstream(text = 'hello from CF'): typeof fetch {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
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

describe('truthful provider completion', () => {
  it.each(['secret', 'cipher', 'iv'] as const)(
    'blocks a vault %s split across provider delta events before it can be reconstructed downstream',
    async (protectedField) => {
      const store = memoryStore()
      await addProviderKey(store, 'openai', OPENAI_SECRET)
      await approveDevice(store)
      const row = (await store.listVaultRows())[0]
      const protectedValue = protectedField === 'secret' ? OPENAI_SECRET : row[protectedField]
      const splitAt = Math.floor(protectedValue.length / 2)
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: protectedValue.slice(0, splitAt) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: protectedValue.slice(splitAt) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n'
      ].join('')

      const response = await askProviderWithStore(
        store,
        'openai',
        upstream(frames),
        `ask-openai-split-${protectedField}`
      )
      const got = events(await response.text())
      const reconstructed = got
        .filter((event) => event.t === 'delta')
        .map((event) => String(event.text ?? ''))
        .join('')

      expect(reconstructed).not.toContain(protectedValue)
      expect(got).toContainEqual(expect.objectContaining({ t: 'error' }))
      expect(got.some((event) => event.t === 'done')).toBe(false)
      expect((await store.listAsks(1))[0]?.outcome).toBe('error')
    }
  )

  it('marks an OpenAI stop as complete and preserves usage', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'complete answer' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\n`,
      'data: [DONE]\n\n'
    ].join('')
    const { response, store } = await askProvider('openai', upstream(frames), 'ask-openai-stop')

    expect(response.status).toBe(200)
    expect(events(await response.text())).toContainEqual({
      t: 'done',
      status: 'complete',
      finishReason: 'stop',
      inputTokens: 9,
      outputTokens: 4
    })
    expect((await store.listAsks(1))[0]).toEqual(
      expect.objectContaining({ outcome: 'answered', input_tokens: 9, output_tokens: 4 })
    )
  })

  it.each([
    ['length', 'length'],
    ['EOF without a terminal reason', undefined]
  ])('rejects OpenAI %s after partial output', async (_label, finishReason) => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`,
      ...(finishReason
        ? [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`, 'data: [DONE]\n\n']
        : [])
    ].join('')
    const nonce = finishReason ? 'ask-openai-length' : 'ask-openai-eof'
    const { response, store } = await askProvider('openai', upstream(frames), nonce)
    const got = events(await response.text())

    expect(got).toContainEqual({ t: 'delta', text: 'partial answer' })
    expect(got).toContainEqual(
      expect.objectContaining({
        t: 'error',
        status: 'incomplete',
        finishReason: finishReason ?? 'unexpected_eof',
        retryable: true
      })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('accepts Anthropic end_turn only after message_stop, including a split final event without a newline', async () => {
    const wire = [
      'event: content_block_delta\n',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'complete answer' } })}\n\n`,
      'event: message_delta\n',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`,
      'event: message_stop\n',
      `data: ${JSON.stringify({ type: 'message_stop' })}`
    ].join('')
    const bytes = new TextEncoder().encode(wire)
    const splitAt = bytes.length - 8
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt))
        controller.enqueue(bytes.slice(splitAt))
        controller.close()
      }
    })
    const { response, store } = await askProvider('anthropic', upstream(body), 'ask-anthropic-end-turn')
    const got = events(await response.text())

    expect(got).toContainEqual({
      t: 'done',
      status: 'complete',
      finishReason: 'end_turn',
      outputTokens: 4
    })
    expect((await store.listAsks(1))[0]?.outcome).toBe('answered')
  })

  it.each([
    ['max_tokens', 'max_tokens', true],
    ['missing stop reason', undefined, true],
    ['missing message_stop', 'end_turn', false]
  ])('rejects Anthropic %s after partial output', async (_label, stopReason, includeMessageStop) => {
    const frames = [
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial answer' } })}\n\n`,
      ...(stopReason
        ? [`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } })}\n\n`]
        : []),
      ...(includeMessageStop ? [`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`] : [])
    ].join('')
    const { response, store } = await askProvider(
      'anthropic',
      upstream(frames),
      `ask-anthropic-${stopReason ?? 'missing'}-${String(includeMessageStop)}`
    )
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({
        t: 'error',
        status: 'incomplete',
        finishReason: stopReason ?? 'unexpected_eof',
        retryable: true
      })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it.each([
    [
      'message_stop before its stop reason',
      [
        { type: 'message_stop' },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
      ],
      'out_of_order_terminal'
    ],
    [
      'an abnormal reason followed by a natural reason',
      [
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' }
      ],
      'conflicting_terminal'
    ]
  ] as const)('rejects Anthropic %s', async (_label, terminalPayloads, finishReason) => {
    const frames = [
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial answer' } })}\n\n`,
      ...terminalPayloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    ].join('')
    const { response, store } = await askProvider(
      'anthropic',
      upstream(frames),
      `ask-anthropic-strict-${finishReason}`
    )
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({ t: 'error', status: 'incomplete', finishReason, retryable: true })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('rejects conflicting OpenAI finish reasons instead of accepting the last natural reason', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n'
    ].join('')
    const { response, store } = await askProvider('openai', upstream(frames), 'ask-openai-conflicting-terminal')
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({ t: 'error', status: 'incomplete', finishReason: 'conflicting_terminal' })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('rejects an OpenAI finish reason received after the stream terminal sentinel', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`,
      'data: [DONE]\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    ].join('')
    const { response, store } = await askProvider('openai', upstream(frames), 'ask-openai-out-of-order-terminal')
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({ t: 'error', status: 'incomplete', finishReason: 'out_of_order_terminal' })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('rejects malformed terminal payloads instead of inferring success from HTTP 200', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`,
      'data: {"choices":[{"finish_reason":"stop"}]\n\n'
    ].join('')
    const { response, store } = await askProvider('openai', upstream(frames), 'ask-openai-malformed')
    const got = events(await response.text())

    expect(got).toContainEqual(expect.objectContaining({ t: 'error', status: 'incomplete', retryable: true }))
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('rejects a natural stop that contains no substantive output', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '   ' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n'
    ].join('')
    const { response, store } = await askProvider('openai', upstream(frames), 'ask-openai-empty-stop')
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({ t: 'error', status: 'incomplete', finishReason: 'empty_output', retryable: true })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it.each([
    [
      'openai',
      { choices: [{ message: { content: 'complete buffered answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      'stop'
    ],
    [
      'anthropic',
      { content: [{ type: 'text', text: 'complete buffered answer' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } },
      'end_turn'
    ]
  ] as const)('requires natural completion metadata for buffered %s output', async (provider, payload, finishReason) => {
    const { response, store } = await askProvider(
      provider,
      upstream(JSON.stringify(payload), 'application/json'),
      `ask-${provider}-buffered-complete`
    )
    const got = events(await response.text())

    expect(got).toContainEqual(expect.objectContaining({ t: 'done', status: 'complete', finishReason }))
    expect((await store.listAsks(1))[0]?.outcome).toBe('answered')
  })

  it('rejects a buffered answer without completion metadata', async () => {
    const payload = { choices: [{ message: { content: 'partial buffered answer' } }] }
    const { response, store } = await askProvider(
      'openai',
      upstream(JSON.stringify(payload), 'application/json'),
      'ask-openai-buffered-incomplete'
    )
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({ t: 'error', status: 'incomplete', finishReason: 'unexpected_eof', retryable: true })
    )
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('rejects a buffered Anthropic text block whose text field is not a string', async () => {
    const payload = {
      content: [{ type: 'text', text: { coerced: 'not provider text' } }],
      stop_reason: 'end_turn'
    }
    const { response, store } = await askProvider(
      'anthropic',
      upstream(JSON.stringify(payload), 'application/json'),
      'ask-anthropic-buffered-malformed-text'
    )
    const got = events(await response.text())

    expect(got).toContainEqual(
      expect.objectContaining({ t: 'error', status: 'incomplete', finishReason: 'malformed_payload' })
    )
    expect(got.some((event) => event.t === 'delta')).toBe(false)
    expect(got.some((event) => event.t === 'done')).toBe(false)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('cancels the upstream reader when the downstream client disconnects', async () => {
    let upstreamCancelled = false
    const firstFrame = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstFrame)
      },
      cancel() {
        upstreamCancelled = true
      }
    })
    const { response, store } = await askProvider('openai', upstream(body), 'ask-openai-cancel')
    const reader = response.body!.getReader()

    const cancelled = reader.cancel('client disconnected')
    await Promise.race([cancelled, new Promise((resolve) => setTimeout(resolve, 50))])

    expect(upstreamCancelled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('cancels an in-flight buffered provider body when the downstream client disconnects', async () => {
    let upstreamCancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['))
      },
      cancel() {
        upstreamCancelled = true
      }
    })
    const { response, store } = await askProvider(
      'openai',
      upstream(body, 'application/json'),
      'ask-openai-buffered-cancel'
    )
    const reader = response.body!.getReader()

    await reader.cancel('client disconnected')

    expect(upstreamCancelled).toBe(true)
    expect((await store.listAsks(1))[0]?.outcome).toBe('error')
  })

  it('aborts a pending provider fetch when the signed route request is cancelled before response headers', async () => {
    const store = memoryStore()
    await addProviderKey(store, 'openai', OPENAI_SECRET)
    await approveDevice(store)
    const caller = new AbortController()
    let fetchStarted!: () => void
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve
    })
    let providerSawAbort = false
    const providerFetch: typeof fetch = async (_input, init) => {
      fetchStarted()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            providerSawAbort = true
            reject(new DOMException('cancelled', 'AbortError'))
          },
          { once: true }
        )
      })
    }
    const pending = askProviderWithStore(
      store,
      'openai',
      providerFetch,
      'ask-openai-before-headers-cancel',
      caller.signal
    )
    await started

    caller.abort('client disconnected')
    const response = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))
    ])

    expect(providerSawAbort).toBe(true)
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({ ok: false, error: 'Operator cannot issue a use' })
  })
})
