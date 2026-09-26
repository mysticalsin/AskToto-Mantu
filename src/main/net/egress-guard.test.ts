import realHttp from 'node:http'
import realHttps from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import { installEgressGuard, nodeRequestHost, type NodeHttpLike, type WebRequestLike } from './egress-guard'

const untouchedHttpsRequest = realHttps.request

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

function fakeNodeHttp(): { mod: NodeHttpLike; calls: unknown[][] } {
  const calls: unknown[][] = []
  const mod: NodeHttpLike = {
    request: (...args) => {
      calls.push(['request', ...args])
      return 'real-request'
    },
    get: (...args) => {
      calls.push(['get', ...args])
      return 'real-get'
    }
  }
  return { mod, calls }
}

function harness(allow: readonly string[] | null, baseFetchImpl?: (input: unknown, init?: RequestInit) => Promise<Response>) {
  const baseFetch = vi.fn(baseFetchImpl ?? (async () => new Response('ok')))
  let installed: typeof fetch | null = null
  const audit = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn() }
  const wr = fakeWebRequest()
  const http = fakeNodeHttp()
  const https = fakeNodeHttp()
  const handle = installEgressGuard(allow, {
    baseFetch: baseFetch as unknown as typeof fetch,
    setGlobalFetch: (f) => {
      installed = f
    },
    webRequest: wr.webRequest,
    nodeHttp: { http: http.mod, https: https.mod },
    audit,
    log
  })
  return { baseFetch, installed: () => installed, audit, log, wr, http, https, handle }
}

const redirect = (status: number, location: string): Response => new Response(null, { status, headers: { location } })

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

  it('restore puts the base fetch and the http functions back', async () => {
    const h = harness(['graph.microsoft.com'])
    const patchedRequest = h.http.mod.request
    h.handle.restore()
    expect(h.installed()).toBe(h.baseFetch)
    expect(h.http.mod.request).not.toBe(patchedRequest)
    expect(h.http.mod.request('https://evil.example/')).toBe('real-request')
    expect(h.http.calls[0]).toEqual(['request', 'https://evil.example/'])
  })

  it('a missing Chromium hook degrades to fetch-only and says so', () => {
    const audit = vi.fn()
    const log = { info: vi.fn(), warn: vi.fn() }
    const handle = installEgressGuard(['x.example'], {
      baseFetch: (async () => new Response('')) as unknown as typeof fetch,
      setGlobalFetch: () => {},
      webRequest: null,
      nodeHttp: null,
      audit,
      log
    })
    expect(handle.enforcing).toBe(true)
    expect(log.warn.mock.calls.some((c) => String(c[0]).includes('only main-process fetch'))).toBe(true)
    expect(audit).toHaveBeenCalledWith('net.egress.policy', { hosts: 1, chromiumHook: false, httpHook: false })
  })
})

describe('redirects are checked hop by hop (an allowed host cannot bounce the request off the list)', () => {
  it('follows an allowed chain itself with redirect: manual and returns the final response', async () => {
    const seen: string[] = []
    const h = harness(['huggingface.co', '*.hf.co'], async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      seen.push(url)
      expect(init?.redirect).toBe('manual')
      if (url === 'https://huggingface.co/model.bin') return redirect(302, 'https://cdn-lfs.hf.co/blob/1')
      if (url === 'https://cdn-lfs.hf.co/blob/1') return redirect(307, '/blob/2')
      return new Response('weights')
    })
    const res = await h.installed()!('https://huggingface.co/model.bin')
    expect(await res.text()).toBe('weights')
    expect(seen).toEqual(['https://huggingface.co/model.bin', 'https://cdn-lfs.hf.co/blob/1', 'https://cdn-lfs.hf.co/blob/2'])
    expect(h.audit.mock.calls.filter((c) => c[0] === 'net.egress.blocked')).toHaveLength(0)
  })

  it('refuses the hop whose host is off the list, audits that host, and never fetches it', async () => {
    const seen: string[] = []
    const h = harness(['huggingface.co'], async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      seen.push(url)
      return redirect(302, 'https://exfil.example/collect?token=abc')
    })
    await expect(h.installed()!('https://huggingface.co/model.bin')).rejects.toThrow(/exfil.example is not in the managed egress allowlist/)
    expect(seen).toEqual(['https://huggingface.co/model.bin'])
    expect([...h.handle.blocked]).toEqual(['exfil.example'])
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('token=abc')
  })

  it('a 303 (or 301/302 on POST) becomes a bodiless GET, and auth headers do not cross origins', async () => {
    const hops: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = []
    const h = harness(['a.example', 'b.example'], async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      hops.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body })
      if (url.startsWith('https://a.example/')) return redirect(303, 'https://b.example/done')
      return new Response('ok')
    })
    await h.installed()!('https://a.example/submit', {
      method: 'POST',
      body: 'payload',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/plain', 'x-trace': '1' }
    })
    expect(hops).toHaveLength(2)
    expect(hops[1].url).toBe('https://b.example/done')
    expect(hops[1].method).toBe('GET')
    expect(hops[1].body).toBeNull()
    expect(hops[1].headers.get('authorization')).toBeNull()
    expect(hops[1].headers.get('content-type')).toBeNull()
    expect(hops[1].headers.get('x-trace')).toBe('1')
  })

  it('a 307 keeps method, body and same-origin auth; a streaming body cannot be resent', async () => {
    const hops: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = []
    const h = harness(['a.example'], async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      hops.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body })
      if (url === 'https://a.example/v1') return redirect(307, 'https://a.example/v2')
      return new Response('ok')
    })
    const f = h.installed()!
    await f('https://a.example/v1', { method: 'PUT', body: 'payload', headers: { authorization: 'Bearer x' } })
    expect(hops[1]).toMatchObject({ url: 'https://a.example/v2', method: 'PUT', body: 'payload' })
    expect(hops[1].headers.get('authorization')).toBe('Bearer x')
    const stream = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode('x')); c.close() } })
    await expect(f('https://a.example/v1', { method: 'PUT', body: stream, duplex: 'half' } as RequestInit)).rejects.toThrow(/streaming body/)
  })

  it('gives up after 20 hops and leaves redirect: manual / error callers alone', async () => {
    const h = harness(['loop.example'], async () => redirect(302, 'https://loop.example/again'))
    const f = h.installed()!
    await expect(f('https://loop.example/')).rejects.toThrow(/redirect count exceeded/)
    h.baseFetch.mockClear()
    const manual = await f('https://loop.example/', { redirect: 'manual' })
    expect(manual.status).toBe(302)
    expect(h.baseFetch).toHaveBeenCalledTimes(1)
  })
})

describe('node http / https request and get are guarded', () => {
  it('lets allowed hosts through to the real function untouched', () => {
    const h = harness(['login.microsoftonline.com'])
    const cb = (): void => {}
    expect(h.https.mod.request('https://login.microsoftonline.com/common/oauth2/v2.0/token', cb)).toBe('real-request')
    expect(h.https.calls[0]).toEqual(['request', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', cb])
    expect(h.http.mod.get({ hostname: '127.0.0.1', port: 8080, path: '/health' })).toBe('real-get')
    expect(h.http.calls[0][1]).toEqual({ hostname: '127.0.0.1', port: 8080, path: '/health' })
    expect(h.audit.mock.calls.filter((c) => c[0] === 'net.egress.blocked')).toHaveLength(0)
  })

  it('a refused host still goes through the real function but with a lookup that fails and no agent pool', async () => {
    const h = harness(['login.microsoftonline.com'])
    const cb = (): void => {}
    h.https.mod.request('https://evil.example/token', cb)
    h.https.mod.request({ hostname: 'evil.example', path: '/x' })
    h.http.mod.get(new URL('http://evil.example/y'), { headers: { a: '1' } }, cb)
    expect(h.https.calls).toHaveLength(2)
    const [, url, opts, cb1] = h.https.calls[0] as [string, string, { lookup: unknown; agent: unknown }, unknown]
    expect(url).toBe('https://evil.example/token')
    expect(typeof opts.lookup).toBe('function')
    expect(opts.agent).toBe(false)
    expect(cb1).toBe(cb)
    const [, opts2] = h.https.calls[1] as [string, { hostname: string; lookup: unknown }]
    expect(opts2.hostname).toBe('evil.example')
    expect(typeof opts2.lookup).toBe('function')
    const [, , opts3, cb3] = h.http.calls[0] as [string, URL, { headers: unknown; lookup: unknown }, unknown]
    expect(opts3.headers).toEqual({ a: '1' })
    expect(typeof opts3.lookup).toBe('function')
    expect(cb3).toBe(cb)
    const err = await new Promise<Error>((resolve) => {
      ;(opts.lookup as (h: string, o: unknown, c: (e: Error) => void) => void)('evil.example', {}, resolve)
    })
    expect(err).toBeInstanceOf(TypeError)
    expect([...h.handle.blocked]).toEqual(['evil.example'])
    expect(h.audit).toHaveBeenCalledWith('net.egress.blocked', { host: 'evil.example', via: 'http' })
  })

  it('the injected lookup fails with an ENOTFOUND-shaped error naming the policy', async () => {
    const h = harness([])
    h.https.mod.request('https://evil.example/')
    const [, , opts] = h.https.calls[0] as [string, string, { lookup: (h: string, o: unknown, c: (e: Error) => void) => void }]
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => opts.lookup('evil.example', {}, resolve))
    expect(err.code).toBe('ENOTFOUND')
    expect(err.message).toMatch(/evil.example is not in the managed egress allowlist/)
  })

  it('against the real node:https module a refused request errors ENOTFOUND before any socket opens', async () => {
    const audit = vi.fn()
    const handle = installEgressGuard(['login.microsoftonline.com'], {
      baseFetch: (async () => new Response('')) as unknown as typeof fetch,
      setGlobalFetch: () => {},
      webRequest: null,
      nodeHttp: { http: realHttp as unknown as NodeHttpLike, https: realHttps as unknown as NodeHttpLike },
      audit,
      log: { info: vi.fn(), warn: vi.fn() }
    })
    try {
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const req = realHttps.request('https://blocked.invalid/token', { method: 'POST' })
        req.on('error', resolve)
        req.end('grant_type=client_credentials')
      })
      expect(err.code).toBe('ENOTFOUND')
      expect(err.message).toMatch(/blocked.invalid is not in the managed egress allowlist/)
      expect(audit).toHaveBeenCalledWith('net.egress.blocked', { host: 'blocked.invalid', via: 'http' })
    } finally {
      handle.restore()
    }
    expect(realHttps.request).toBe(untouchedHttpsRequest)
  })

  it('nodeRequestHost reads every call shape and lets options override the URL', () => {
    expect(nodeRequestHost(['https://a.example/x'])).toBe('a.example')
    expect(nodeRequestHost([new URL('http://b.example:8080/y')])).toBe('b.example')
    expect(nodeRequestHost([{ host: 'c.example:443', path: '/' }])).toBe('c.example')
    expect(nodeRequestHost([{ hostname: 'D.example', host: 'ignored.example' }])).toBe('d.example')
    expect(nodeRequestHost(['https://a.example/x', { hostname: 'e.example' }])).toBe('e.example')
    expect(nodeRequestHost([{ host: '[::1]:8080' }])).toBe('[::1]')
    expect(nodeRequestHost([{ socketPath: '/tmp/x.sock' }])).toBeNull()
    expect(nodeRequestHost([{ path: '/only' }])).toBeNull()
  })
})
