import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { installEgressGuard, type WebRequestLike } from './egress-guard'

vi.mock('electron', () => ({
  session: {
    get defaultSession(): never {
      throw new Error('tests must inject webRequest')
    }
  }
}))
vi.mock('../logger', () => ({
  mainLog: { info: () => {}, warn: () => {} },
  auditLog: () => {}
}))

type Listener = (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function fakeWebRequest(): { webRequest: WebRequestLike; fire: (url: string) => boolean } {
  let listener: Listener | null = null
  return {
    webRequest: {
      onBeforeRequest: (_filter, l) => {
        listener = l
      }
    },
    fire: (url) => {
      let cancel = false
      listener?.({ url }, (r) => {
        cancel = r.cancel
      })
      return cancel
    }
  }
}

function harness(allow: readonly string[] | null) {
  const baseFetch = vi.fn(async () => new Response('ok'))
  let installed: typeof fetch | null = null
  const audit = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }
  const wr = fakeWebRequest()
  const handle = installEgressGuard(allow, {
    baseFetch: baseFetch as unknown as typeof fetch,
    setGlobalFetch: (f) => {
      installed = f
    },
    webRequest: wr.webRequest,
    audit,
    log
  })
  return { baseFetch, installed: () => installed, audit, log, wr, handle }
}

function realFetchGuard(allow: readonly string[]) {
  return installEgressGuard(allow, {
    baseFetch: globalThis.fetch,
    setGlobalFetch: () => {},
    webRequest: null,
    audit: () => {},
    log: { info: () => {}, warn: () => {} }
  })
}

describe('installEgressGuard', () => {
  it('no policy: nothing wrapped, nothing hooked, base fetch untouched', async () => {
    const h = harness(null)
    expect(h.handle.enforcing).toBe(false)
    expect(h.installed()).toBeNull()
    expect(h.wr.fire('https://anything.example/')).toBe(false)
    await h.handle.fetch('https://anything.example/')
    expect(h.baseFetch).toHaveBeenCalledTimes(1)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('policy: allowed hosts pass to the base fetch, others reject with a TypeError like a dead network', async () => {
    const h = harness(['graph.microsoft.com', '*.dust.tt'])
    expect(h.handle.enforcing).toBe(true)
    const f = h.installed()!
    await f('https://graph.microsoft.com/v1.0/me')
    await f('https://eu.dust.tt/api')
    await f('http://127.0.0.1:8080/health')
    expect(h.baseFetch).toHaveBeenCalledTimes(3)
    await expect(f('https://api.openai.com/v1/chat')).rejects.toThrow(TypeError)
    await expect(f(new URL('https://evil.example/'))).rejects.toThrow(/egress allowlist/)
    await expect(f(new Request('https://api.openai.com/other'))).rejects.toThrow(TypeError)
    expect(h.baseFetch).toHaveBeenCalledTimes(3)
    expect([...h.handle.blocked]).toEqual(['api.openai.com', 'evil.example'])
  })

  it('blocks a redirect hop before the redirected host receives the request', async () => {
    let blockedHostHits = 0
    const blockedHost = createServer((_request, response) => {
      blockedHostHits += 1
      response.end('policy bypassed')
    })
    const blockedPort = await listen(blockedHost)
    const allowedHost = createServer((_request, response) => {
      // IPv4-mapped IPv6 reaches the local test transport but is intentionally not one of the policy's
      // explicit loopback spellings. That gives this regression a real, observable blocked destination.
      response.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${blockedPort}/secret` })
      response.end()
    })
    const allowedPort = await listen(allowedHost)

    try {
      const handle = realFetchGuard(['127.0.0.1'])

      await expect(handle.fetch(`http://127.0.0.1:${allowedPort}/start`)).rejects.toThrow(/egress allowlist/)
      expect(blockedHostHits).toBe(0)
      expect([...handle.blocked]).toEqual(['[::ffff:7f00:1]'])
    } finally {
      await Promise.all([close(allowedHost), close(blockedHost)])
    }
  })

  it.each([
    [301, 'POST', 'GET', ''],
    [302, 'POST', 'GET', ''],
    [303, 'PUT', 'GET', ''],
    [307, 'POST', 'POST', 'payload'],
    [308, 'POST', 'POST', 'payload']
  ])('preserves fetch method/body redirect semantics for HTTP %i', async (status, method, expectedMethod, expectedBody) => {
    let received: { method: string; body: string } | null = null
    const server = createServer(async (request, response) => {
      if (request.url === '/start') {
        response.writeHead(status, { location: '/target' })
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received = { method: request.method ?? '', body: Buffer.concat(chunks).toString('utf8') }
      response.end('ok')
    })
    const port = await listen(server)

    try {
      const response = await realFetchGuard([]).fetch(`http://127.0.0.1:${port}/start`, {
        method,
        body: 'payload'
      })
      expect(response.status).toBe(200)
      expect(response.redirected).toBe(true)
      expect(received).toEqual({ method: expectedMethod, body: expectedBody })
    } finally {
      await close(server)
    }
  })

  it('does not forward credentials when a redirect changes origin', async () => {
    let receivedHeaders: IncomingHttpHeaders | null = null
    const target = createServer((request, response) => {
      receivedHeaders = request.headers
      response.end('ok')
    })
    const targetPort = await listen(target)
    const entry = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` })
      response.end()
    })
    const entryPort = await listen(entry)

    try {
      const response = await realFetchGuard([]).fetch(`http://127.0.0.1:${entryPort}/start`, {
        headers: {
          authorization: 'Bearer must-not-leak',
          cookie: 'session=must-not-leak',
          'proxy-authorization': 'Basic must-not-leak'
        }
      })
      expect(response.status).toBe(200)
      const headers = receivedHeaders as IncomingHttpHeaders | null
      expect(headers?.authorization).toBeUndefined()
      expect(headers?.cookie).toBeUndefined()
      expect(headers?.['proxy-authorization']).toBeUndefined()
    } finally {
      await Promise.all([close(entry), close(target)])
    }
  })

  it('honors redirect manual and error modes without contacting the target', async () => {
    let targetHits = 0
    const server = createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/target' })
        response.end()
        return
      }
      targetHits += 1
      response.end('unexpected')
    })
    const port = await listen(server)
    const guardedFetch = realFetchGuard([]).fetch

    try {
      const manual = await guardedFetch(`http://127.0.0.1:${port}/start`, { redirect: 'manual' })
      expect(manual.status).toBe(302)
      expect(targetHits).toBe(0)

      await expect(guardedFetch(`http://127.0.0.1:${port}/start`, { redirect: 'error' })).rejects.toThrow(TypeError)
      expect(targetHits).toBe(0)
    } finally {
      await close(server)
    }
  })

  it('bounds automatic redirects at the fetch-standard limit', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(302, { location: `/hop-${requests}` })
      response.end()
    })
    const port = await listen(server)

    try {
      await expect(realFetchGuard([]).fetch(`http://127.0.0.1:${port}/start`)).rejects.toThrow(TypeError)
      expect(requests).toBe(21)
    } finally {
      await close(server)
    }
  })

  it('cancels a discarded redirect body when policy rejects its destination', async () => {
    let cancelled = 0
    const redirect = new Response(
      new ReadableStream({
        cancel: () => {
          cancelled += 1
        }
      }),
      { status: 302, headers: { location: 'https://blocked.example/target' } }
    )
    const guardedFetch = installEgressGuard(['allowed.example'], {
      baseFetch: (async () => redirect) as typeof fetch,
      setGlobalFetch: () => {},
      webRequest: null,
      audit: () => {},
      log: { info: () => {}, warn: () => {} }
    }).fetch

    await expect(guardedFetch('https://allowed.example/start')).rejects.toThrow(/egress allowlist/)
    expect(cancelled).toBe(1)
  })

  it('does not replay a non-replayable streaming body across a 307 redirect', async () => {
    let targetHits = 0
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the real upload before answering, as an ordinary HTTP server would.
      }
      if (request.url === '/start') {
        response.writeHead(307, { location: '/target' })
        response.end()
        return
      }
      targetHits += 1
      response.end('unexpected')
    })
    const port = await listen(server)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed payload'))
        controller.close()
      }
    })

    try {
      await expect(
        realFetchGuard([]).fetch(`http://127.0.0.1:${port}/start`, {
          method: 'POST',
          body,
          duplex: 'half'
        } as RequestInit)
      ).rejects.toThrow(TypeError)
      expect(targetHits).toBe(0)
    } finally {
      await close(server)
    }
  })

  it('passes per-request transport extensions through the guarded fetch boundary', async () => {
    const dispatcher = {} as RequestInit['dispatcher']
    const seenDispatchers: Array<RequestInit['dispatcher']> = []
    const guardedFetch = installEgressGuard(['allowed.example'], {
      baseFetch: (async (_input, init) => {
        seenDispatchers.push(init?.dispatcher)
        return seenDispatchers.length === 1
          ? new Response(null, { status: 302, headers: { location: '/target' } })
          : new Response('ok')
      }) as typeof fetch,
      setGlobalFetch: () => {},
      webRequest: null,
      audit: () => {},
      log: { info: () => {}, warn: () => {} }
    }).fetch

    await guardedFetch('https://allowed.example/start', { dispatcher })
    expect(seenDispatchers).toEqual([dispatcher, dispatcher])
  })

  it('honors cancellation while waiting for a redirect response', async () => {
    let releaseRequest!: () => void
    const requestArrived = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const server = createServer((_request, response) => {
      releaseRequest()
      setTimeout(() => {
        response.writeHead(302, { location: '/target' })
        response.end()
      }, 100)
    })
    const port = await listen(server)
    const controller = new AbortController()

    try {
      const pending = realFetchGuard([]).fetch(`http://127.0.0.1:${port}/start`, { signal: controller.signal })
      await requestArrived
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await close(server)
    }
  })

  it('audits each blocked host once per session, hostname only', async () => {
    const h = harness([])
    const f = h.installed()!
    await expect(f('https://a.example/one?secret=1')).rejects.toThrow()
    await expect(f('https://a.example/two?secret=2')).rejects.toThrow()
    expect(h.wr.fire('https://a.example/three')).toBe(true)
    const blockedCalls = h.audit.mock.calls.filter((c) => c[0] === 'net.egress.blocked')
    expect(blockedCalls).toHaveLength(1)
    expect(blockedCalls[0][1]).toEqual({ host: 'a.example', via: 'fetch' })
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('secret')
  })

  it('Chromium hook cancels disallowed network URLs and lets non-network schemes through', () => {
    const h = harness(['graph.microsoft.com'])
    expect(h.wr.fire('https://graph.microsoft.com/v1.0/me')).toBe(false)
    expect(h.wr.fire('https://huggingface.co/model.bin')).toBe(true)
    expect(h.wr.fire('file:///app/renderer/index.html')).toBe(false)
    expect(h.wr.fire('devtools://devtools/bundled/x')).toBe(false)
    expect(h.wr.fire('http://localhost:5173/x')).toBe(false)
  })

  it('Chromium hook re-checks and blocks a disallowed redirect hop', () => {
    const h = harness(['allowed.example'])
    expect(h.wr.fire('https://allowed.example/start')).toBe(false)
    expect(h.wr.fire('https://blocked.example/redirect-target')).toBe(true)
    expect([...h.handle.blocked]).toEqual(['blocked.example'])
    expect(h.audit).toHaveBeenCalledWith('net.egress.blocked', { host: 'blocked.example', via: 'chromium' })
  })

  it('restore puts the base fetch back', async () => {
    const h = harness(['graph.microsoft.com'])
    h.handle.restore()
    expect(h.installed()).toBe(h.baseFetch)
  })

  it('a missing Chromium hook degrades to fetch-only and says so', () => {
    const audit = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }
    const handle = installEgressGuard(['x.example'], {
      baseFetch: (async () => new Response('')) as unknown as typeof fetch,
      setGlobalFetch: () => {},
      webRequest: null,
      audit,
      log
    })
    expect(handle.enforcing).toBe(true)
    expect(log.warn.mock.calls.some((c) => String(c[0]).includes('only main-process fetch'))).toBe(true)
    expect(audit).toHaveBeenCalledWith('net.egress.policy', { hosts: 1, chromiumHook: false })
  })
})
