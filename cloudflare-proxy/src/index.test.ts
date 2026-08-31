import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, {
  resetProxyRateLimits,
  setProxyRateLimitCache,
  PROXY_RL_AUTH_MAX,
  PROXY_RL_UNAUTH_MAX,
  type Env,
  type ProxyRateCache
} from './index'

/**
 * index.test.ts — the Worker's auth boundary and its forwarding contract, proven without a deploy.
 *
 * This shim has exactly two jobs that can hurt someone if they are wrong, and both are checkable in
 * process: it must not become an open relay on the operator's Cloudflare balance, and it must not let
 * the account token back out — not in a response body, not in a header, not by relaying an upstream
 * error that quotes the request. Everything here is one of those two, plus the streaming passthrough
 * that Métis's token-by-token rendering depends on.
 *
 * `fetch` is stubbed rather than mocked at module scope so each case can assert on the exact upstream
 * call that was made (url, headers, body) — a proxy's whole behaviour IS that call.
 *
 * Not covered here, and not claimed: anything that needs the real runtime. Wrangler secret binding,
 * `wrangler deploy`, the live Cloudflare endpoint, and AI Gateway's logging/rate-limit behaviour are
 * verified by deploying, per cloudflare-proxy/README.md. Node's `crypto.subtle` and `ReadableStream`
 * stand in for the Workers implementations here; they are the same web-standard surface this file
 * deliberately restricts itself to, which is why secretsMatch() hashes instead of calling the
 * Workers-only `crypto.subtle.timingSafeEqual`.
 */

const PROXY_KEY = 'metis-proxy-key-for-tests'
const ACCOUNT_TOKEN = 'account-token-for-tests'
const ACCOUNT_ID = 'account-id-for-tests'

const UPSTREAM_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`

function env(overrides: Partial<Env> = {}): Env {
  return {
    CLOUDFLARE_API_TOKEN: ACCOUNT_TOKEN,
    CF_ACCOUNT_ID: ACCOUNT_ID,
    METIS_PROXY_KEY: PROXY_KEY,
    ...overrides
  }
}

const BODY = JSON.stringify({
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true
})

function chatRequest(key: string | null = PROXY_KEY, body = BODY): Request {
  return new Request('https://proxy.example.workers.dev/v1/chat/completions', {
    method: 'POST',
    headers: key === null ? { 'content-type': 'application/json' } : { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body
  })
}

/** Stub global fetch with a canned upstream reply; returns the recorded calls. */
function stubUpstream(reply: Response | (() => Response)): Array<[string, RequestInit]> {
  const calls: Array<[string, RequestInit]> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push([url, init])
      return Promise.resolve(typeof reply === 'function' ? reply() : reply)
    })
  )
  return calls
}

/** A stream the test drives by hand, so "did it buffer?" is observable rather than assumed. */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>
  push: (chunk: string) => void
  close: () => void
} {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    }
  })
  return {
    stream,
    push: (chunk) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetProxyRateLimits()
  setProxyRateLimitCache(null)
})

function memoryRateCache(): ProxyRateCache {
  const map = new Map<string, Response>()
  return {
    async match(request) {
      return map.get(new URL(request.url).pathname)
    },
    async put(request, response) {
      map.set(new URL(request.url).pathname, response)
    }
  }
}

describe('caller authentication', () => {
  it('rejects a request with no Authorization header and never calls Cloudflare', async () => {
    const calls = stubUpstream(new Response('{}', { status: 200 }))

    const res = await worker.fetch(chatRequest(null), env())

    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
    await expect(res.json()).resolves.toMatchObject({ error: { message: 'Invalid proxy key.' } })
  })

  it('rejects a wrong key, and a right key with trailing junk', async () => {
    const calls = stubUpstream(new Response('{}', { status: 200 }))

    for (const key of ['not-the-key', `${PROXY_KEY}x`, PROXY_KEY.slice(0, -1), '']) {
      const res = await worker.fetch(chatRequest(key), env())
      expect(res.status, `key: ${JSON.stringify(key)}`).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })

  it('accepts the exact key and forwards the call', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    const res = await worker.fetch(chatRequest(), env())

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('refuses to serve — and cannot be unlocked by an empty key — when the secrets are unset', async () => {
    const calls = stubUpstream(new Response('{}', { status: 200 }))

    for (const broken of [
      { METIS_PROXY_KEY: '' },
      { CLOUDFLARE_API_TOKEN: '' },
      { CF_ACCOUNT_ID: '' }
    ] satisfies Array<Partial<Env>>) {
      const res = await worker.fetch(chatRequest(''), env(broken))
      expect(res.status, JSON.stringify(broken)).toBe(503)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('multi-key auth (METIS_PROXY_KEYS)', () => {
  const KEYS_JSON = JSON.stringify(['tony:key-for-tony', 'dana:key-for-dana', 'bare-key-no-label'])

  it('single-key mode is unchanged when METIS_PROXY_KEYS is not set', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    const res = await worker.fetch(chatRequest(PROXY_KEY), env())

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('accepts every key listed in METIS_PROXY_KEYS, label form and bare form alike', async () => {
    for (const key of ['key-for-tony', 'key-for-dana', 'bare-key-no-label']) {
      const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

      const res = await worker.fetch(
        chatRequest(key),
        env({ METIS_PROXY_KEY: undefined, METIS_PROXY_KEYS: KEYS_JSON })
      )

      expect(res.status, `key: ${key}`).toBe(200)
      expect(calls, `key: ${key}`).toHaveLength(1)
    }
  })

  it('rejects a key that is not in METIS_PROXY_KEYS, and never calls Cloudflare', async () => {
    const calls = stubUpstream(new Response('{}', { status: 200 }))

    const res = await worker.fetch(
      chatRequest('key-for-someone-else'),
      env({ METIS_PROXY_KEY: undefined, METIS_PROXY_KEYS: KEYS_JSON })
    )

    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('accepts either secret when both METIS_PROXY_KEY and METIS_PROXY_KEYS are configured', async () => {
    for (const key of [PROXY_KEY, 'key-for-dana']) {
      const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

      const res = await worker.fetch(chatRequest(key), env({ METIS_PROXY_KEYS: KEYS_JSON }))

      expect(res.status, `key: ${key}`).toBe(200)
      expect(calls, `key: ${key}`).toHaveLength(1)
    }
  })

  it('fails CLOSED on malformed METIS_PROXY_KEYS — a correct METIS_PROXY_KEY is still refused, not silently accepted', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    const res = await worker.fetch(chatRequest(PROXY_KEY), env({ METIS_PROXY_KEYS: '{ not valid json' }))

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.status).toBeLessThan(600)
    await expect(res.json()).resolves.toMatchObject({ error: { type: 'metis_proxy_config_error' } })
    expect(calls).toHaveLength(0)
  })

  it('fails CLOSED on a METIS_PROXY_KEYS that is valid JSON but not an array of strings', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    for (const bad of ['"just-a-string"', '{"a":"b"}', '[1,2,3]', '[""]', 'null']) {
      const res = await worker.fetch(chatRequest(PROXY_KEY), env({ METIS_PROXY_KEYS: bad }))
      expect(res.status, `payload: ${bad}`).toBeGreaterThanOrEqual(500)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('forwarding to the Cloudflare AI REST API', () => {
  it('injects the account token server-side and never passes the caller key upstream', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    await worker.fetch(chatRequest(), env())

    const [url, init] = calls[0]
    expect(url).toBe(UPSTREAM_URL)
    expect(init.method).toBe('POST')

    const sent = new Headers(init.headers)
    expect(sent.get('authorization')).toBe(`Bearer ${ACCOUNT_TOKEN}`)
    expect(sent.get('content-type')).toBe('application/json')
    // The proxy key is Métis's credential for THIS Worker and has no meaning at Cloudflare; sending it
    // on would put a second live secret into someone else's logs for no reason.
    expect(JSON.stringify([...sent])).not.toContain(PROXY_KEY)
  })

  it('forwards the request body byte for byte', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    await worker.fetch(chatRequest(PROXY_KEY, BODY), env())

    expect(calls[0][1].body).toBe(BODY)
  })

  it('pins an AI Gateway only when the operator set one', async () => {
    const withGateway = stubUpstream(new Response('{}', { status: 200 }))
    await worker.fetch(chatRequest(), env({ CF_AI_GATEWAY_ID: 'metis-gateway' }))
    expect(new Headers(withGateway[0][1].headers).get('cf-aig-gateway-id')).toBe('metis-gateway')

    vi.unstubAllGlobals()
    const withoutGateway = stubUpstream(new Response('{}', { status: 200 }))
    await worker.fetch(chatRequest(), env())
    expect(new Headers(withoutGateway[0][1].headers).get('cf-aig-gateway-id')).toBeNull()
  })

  it('rebuilds the response headers instead of forwarding whatever Cloudflare attached', async () => {
    stubUpstream(
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': '__cf_bm=bot-management-cookie',
          'cf-ray': '8a1b2c3d4e5f6789-CDG',
          'cf-aig-cache-status': 'MISS'
        }
      })
    )

    const res = await worker.fetch(chatRequest(), env())

    // The other half of the leak boundary the test above proves in the request direction: the request
    // headers are built fresh so the caller's key never travels up, and these are built fresh so the
    // operator's edge metadata never travels down. Shortening the return to
    // `new Response(upstream.body, upstream)` — the idiomatic-looking one-liner — passes every other
    // case in this file while shipping the operator's ray ids, gateway cache status and Cloudflare's
    // bot cookie to every Métis install.
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cf-ray')).toBeNull()
    expect(res.headers.get('cf-aig-cache-status')).toBeNull()
    // Only the two this file writes itself survive.
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('streaming', () => {
  it('passes SSE frames through as they arrive instead of buffering the completion', async () => {
    const upstream = controllableStream()
    stubUpstream(
      new Response(upstream.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const res = await worker.fetch(chatRequest(), env())
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    // The proof: the first frame is readable off the response while the upstream stream is still
    // open. A buffering proxy could not answer here — it would still be awaiting close().
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    upstream.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n')
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('"Hel"')

    upstream.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')
    const second = await reader.read()
    expect(decoder.decode(second.value)).toContain('"lo"')

    upstream.push('data: [DONE]\n\n')
    upstream.close()
    const third = await reader.read()
    expect(decoder.decode(third.value)).toContain('[DONE]')
    await expect(reader.read()).resolves.toMatchObject({ done: true })
  })
})

describe('upstream failures', () => {
  const leakedBody = JSON.stringify({
    errors: [{ message: `request rejected: authorization: Bearer ${ACCOUNT_TOKEN}` }]
  })

  it('never relays an upstream error body, and answers 502 when Cloudflare rejects the account token', async () => {
    stubUpstream(new Response(leakedBody, { status: 403 }))

    const res = await worker.fetch(chatRequest(), env())
    const text = await res.text()

    // 502, not 401: the caller's key was fine, so telling Métis "unauthorized" would send it off to
    // re-prompt the user for a credential that is not the problem.
    expect(res.status).toBe(502)
    expect(text).not.toContain(ACCOUNT_TOKEN)
    expect(text).toContain('CLOUDFLARE_API_TOKEN')
    // ...and it must be MARKED as an operator fault. A bare 502 matches Métis's transient-retry
    // pattern, so without the marker this sentence is discarded and the user is told to check their
    // network while the real cause is a secret in this Worker.
    expect(text).toContain('[metis-proxy-config]')
    expect(JSON.parse(text).error.type).toBe('metis_proxy_config_error')
  })

  it('does NOT mark an ordinary upstream outage as an operator fault', () => {
    // The negative that keeps the marker meaningful: a 5xx blip should stay transient and keep
    // retrying. Marking it would turn a 30-second Cloudflare outage into "your operator broke this".
    return (async () => {
      stubUpstream(new Response(leakedBody, { status: 503 }))
      const res = await worker.fetch(chatRequest(), env())
      const text = await res.text()
      expect(res.status).toBe(502)
      expect(text).not.toContain('[metis-proxy-config]')
      expect(JSON.parse(text).error.type).toBe('metis_proxy_error')
    })()
  })

  it('preserves 429 so the client can back off, without echoing the body', async () => {
    stubUpstream(new Response(leakedBody, { status: 429 }))

    const res = await worker.fetch(chatRequest(), env())
    const text = await res.text()

    expect(res.status).toBe(429)
    expect(text).not.toContain(ACCOUNT_TOKEN)
  })

  it('preserves an actionable 4xx and collapses 5xx to 502, both re-stated not relayed', async () => {
    stubUpstream(new Response(leakedBody, { status: 404 }))
    const notFound = await worker.fetch(chatRequest(), env())
    expect(notFound.status).toBe(404)
    expect(await notFound.text()).not.toContain(ACCOUNT_TOKEN)

    vi.unstubAllGlobals()
    stubUpstream(new Response(leakedBody, { status: 503 }))
    const unavailable = await worker.fetch(chatRequest(), env())
    expect(unavailable.status).toBe(502)
    expect(await unavailable.text()).not.toContain(ACCOUNT_TOKEN)
  })

  it('answers 502 without detail when the upstream fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error(`connect ECONNREFUSED while sending Bearer ${ACCOUNT_TOKEN}`)))
    )

    const res = await worker.fetch(chatRequest(), env())
    const text = await res.text()

    expect(res.status).toBe(502)
    expect(text).not.toContain(ACCOUNT_TOKEN)
  })
})

describe('routing', () => {
  it('serves GET /health without a key and without disclosing any secret', async () => {
    const res = await worker.fetch(new Request('https://proxy.example.workers.dev/health'), env())
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ ok: true, configured: true })
    expect(text).not.toContain(ACCOUNT_TOKEN)
    expect(text).not.toContain(ACCOUNT_ID)
    expect(text).not.toContain(PROXY_KEY)
  })

  it('reports configured:false while secrets are still missing', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.example.workers.dev/health'),
      env({ CLOUDFLARE_API_TOKEN: '' })
    )
    await expect(res.json()).resolves.toMatchObject({ ok: true, configured: false })
  })

  it('reports configured:true from METIS_PROXY_KEYS alone, with METIS_PROXY_KEY unset', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.example.workers.dev/health'),
      env({ METIS_PROXY_KEY: undefined, METIS_PROXY_KEYS: JSON.stringify(['a-key']) })
    )
    await expect(res.json()).resolves.toMatchObject({ ok: true, configured: true })
  })

  it('reports configured:false, not true, when METIS_PROXY_KEYS is set but malformed — and discloses no key material or count', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.example.workers.dev/health'),
      env({ METIS_PROXY_KEYS: '{ not valid json' })
    )
    const text = await res.text()

    expect(JSON.parse(text)).toMatchObject({ ok: true, configured: false })
    expect(JSON.parse(text)).not.toHaveProperty('keys')
    expect(JSON.parse(text)).not.toHaveProperty('keyCount')
    expect(text).not.toContain(PROXY_KEY)
  })

  it('rate-limits an authenticated burst before spending the account token', async () => {
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    let limited = 0
    for (let i = 0; i < PROXY_RL_AUTH_MAX + 5; i++) {
      const res = await worker.fetch(chatRequest(), env())
      if (res.status === 429) {
        limited += 1
        const text = await res.text()
        expect(text).not.toContain(ACCOUNT_TOKEN)
        expect(text).not.toContain(PROXY_KEY)
        expect(JSON.parse(text).error.message).toMatch(/Rate limited/)
      } else {
        expect(res.status).toBe(200)
      }
    }
    expect(limited).toBeGreaterThanOrEqual(5)
    expect(calls.length).toBe(PROXY_RL_AUTH_MAX)
  })

  it('rate-limits unauthenticated guesses without calling Cloudflare', async () => {
    const calls = stubUpstream(new Response('{}', { status: 200 }))

    let limited = 0
    for (let i = 0; i < PROXY_RL_UNAUTH_MAX + 5; i++) {
      const res = await worker.fetch(chatRequest('wrong-key'), env())
      if (res.status === 429) limited += 1
      else expect(res.status).toBe(401)
    }
    expect(limited).toBeGreaterThanOrEqual(5)
    expect(calls).toHaveLength(0)
  })

  it('404s an unknown path and 405s the wrong method, never reaching Cloudflare', async () => {
    const calls = stubUpstream(new Response('{}', { status: 200 }))

    const unknown = await worker.fetch(new Request('https://proxy.example.workers.dev/v1/models'), env())
    expect(unknown.status).toBe(404)

    const getChat = await worker.fetch(
      new Request('https://proxy.example.workers.dev/v1/chat/completions'),
      env()
    )
    expect(getChat.status).toBe(405)

    const postHealth = await worker.fetch(
      new Request('https://proxy.example.workers.dev/health', { method: 'POST' }),
      env()
    )
    expect(postHealth.status).toBe(405)

    expect(calls).toHaveLength(0)
  })

  it('shares the authenticated window across isolates via the Cache API', async () => {
    const shared = memoryRateCache()
    setProxyRateLimitCache(shared)
    const calls = stubUpstream(new Response('{"ok":true}', { status: 200 }))

    for (let i = 0; i < PROXY_RL_AUTH_MAX; i++) {
      const res = await worker.fetch(chatRequest(), env())
      expect(res.status).toBe(200)
    }
    resetProxyRateLimits()
    setProxyRateLimitCache(shared)

    const limited = await worker.fetch(chatRequest(), env())
    expect(limited.status).toBe(429)
    expect(calls.length).toBe(PROXY_RL_AUTH_MAX)
  })
})
