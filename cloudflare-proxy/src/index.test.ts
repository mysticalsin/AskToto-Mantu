import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from './index'

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
  model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
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
})

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
})
