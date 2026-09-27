/**
 * mcpClient.test.ts — proves connect/auth/list-tools/call-tool against a REAL Streamable HTTP +
 * bearer-auth server, not just type-checking.
 *
 * The mock server below is built from the MCP TypeScript SDK's own server-side pieces (McpServer +
 * StreamableHTTPServerTransport), listening on a real localhost TCP port — the same Streamable HTTP
 * wire protocol BidStack's and Plane's own MCP endpoints speak. Bearer-token (+ optional extra header)
 * auth is layered on top exactly like those real contracts: the MCP spec/SDK does not enforce auth
 * itself, so the mock's raw http listener checks `Authorization: Bearer <key>` (and, in the dedicated
 * test below, `X-Workspace-slug`) before ever handing the request to the SDK transport.
 *
 * IMPORTANT — scope of what this proves: this validates mcpClient.ts's connect/auth/listTools/callTool
 * logic against a spec-faithful LOCAL mock. It does NOT prove connectivity to a real BidStack or Plane
 * instance (no live reachable instance exists yet). That live check still needs to happen once a real
 * endpoint is reachable.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * M2-0147 — a per-hostname DNS answer queue for the connect-time pin (sessionLookup) tests below.
 * Registered hosts never reach the real resolver; the LAST queued answer repeats once exhausted, and
 * every call is counted so a test can assert the resolver was consulted exactly once per session.
 * Every other hostname passes through to the real node:dns/promises.lookup unchanged.
 *
 * Deliberately does NOT mock plain 'node:dns' (only 'node:dns/promises'): sessionLookup resolves via
 * node:dns/promises, so registered hosts are answered from the queue and counted; a mock of the other
 * module would never be consulted at all.
 */
const dnsHosts = vi.hoisted(
  () => new Map<string, { queue: { address: string; family: number }[][]; calls: number }>()
)

function mockDnsHost(hostname: string, answers: string[][]): void {
  dnsHosts.set(hostname, {
    queue: answers.map((batch) => batch.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))),
    calls: 0
  })
}

function dnsCallCount(hostname: string): number {
  return dnsHosts.get(hostname)?.calls ?? 0
}

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: async (hostname: string, options?: { all?: boolean }) => {
      const entry = dnsHosts.get(hostname)
      if (!entry) return actual.lookup(hostname, options as never)
      const idx = Math.min(entry.calls, entry.queue.length - 1)
      entry.calls += 1
      const addresses = entry.queue[idx]!
      return (options?.all ? addresses : addresses[0]) as never
    }
  }
})

// M2-0222 — the proxy-route matrix below needs install-proxy.ts's real route selection (installProxyAwareFetch,
// routeDispatcher's route state), so it mocks 'electron' and '../logger' exactly like install-proxy.test.ts.
// A per-file vi.mock('electron', ...) here overrides the repo-wide __mocks__/electron.ts (which has no
// `session`), so it must supply every export install-proxy.ts's OWN import touches — just `session`.
const resolveProxy = vi.hoisted(() => vi.fn<(url: string) => Promise<string>>())
vi.mock('electron', () => ({
  session: { defaultSession: { resolveProxy: (url: string) => resolveProxy(url) } }
}))
vi.mock('../logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))

import { installProxyAwareFetch } from '../net/install-proxy'
import { connectMcp, pushToMcp } from './mcpClient'

const API_KEY = 'test-mcp-key-123'
const LABEL = 'Polo Pre-Sales'
const NO_EXTRA_HEADERS = {}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Read + JSON-parse the raw request body (mirrors the `req.body` pre-parsing shown in the SDK's own
 *  Express usage example, without pulling in an express dependency for a test). */
function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

/** Build a real HTTP server backing a minimal MCP server with one "push" tool, gated by a bearer token
 *  and (optionally) a required extra header — faithful to BidStack's and Plane's real /mcp contracts
 *  (auth is enforced by the app layer, not the MCP transport).
 *
 *  Multi-session routing: mcpClient.ts opens a brand-new Client + transport (a fresh "initialize"
 *  handshake) on every connect/push call, exactly as a real MCP client does per short-lived task run.
 *  A real MCP server has to support many such independent client sessions concurrently — the SDK's own
 *  documented pattern is a session-id → transport map, creating a fresh transport on each new
 *  initialize request and routing subsequent requests by the Mcp-Session-Id header. Mirrored here so
 *  the mock is faithful to how a real multi-client MCP server actually behaves.
 *
 *  `intercept`, when given, runs after auth and body parsing and BEFORE the request reaches the real
 *  MCP transport — it returns true when it has already answered the request (e.g. with a redirect),
 *  false to let the mock's normal handling continue. `requests()` counts every request that passed
 *  auth, whether or not `intercept` answered it — used to prove a refused connection never sent one. */
async function startMockMcp(
  options: {
    requiredHeader?: { name: string; value: string }
    intercept?: (req: IncomingMessage, res: ServerResponse, body: unknown) => boolean | Promise<boolean>
  } = {}
): Promise<{ url: string; close: () => Promise<void>; calls: Record<string, unknown>[]; requests: () => number }> {
  const calls: Record<string, unknown>[] = []
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  let requestCount = 0

  const buildServer = (): McpServer => {
    const mcp = new McpServer({ name: 'mcp-mock', version: '1.0.0' })
    mcp.registerTool(
      'push_meeting_recap',
      {
        description: 'Push a meeting recap',
        inputSchema: { title: z.string(), date: z.string(), summary: z.string() }
      },
      async (args) => {
        calls.push(args)
        return { content: [{ type: 'text', text: 'ok' }] }
      }
    )
    return mcp
  }

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      const auth = req.headers['authorization']
      if (auth !== `Bearer ${API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (options.requiredHeader) {
        const got = req.headers[options.requiredHeader.name.toLowerCase()]
        if (got !== options.requiredHeader.value) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'missing required header' }))
          return
        }
      }
      requestCount += 1
      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined
        if (options.intercept && (await options.intercept(req, res, body))) return

        const sid = req.headers['mcp-session-id']
        let transport = typeof sid === 'string' ? sessions.get(sid) : undefined

        if (!transport && req.method === 'POST' && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSid) => sessions.set(newSid, transport as StreamableHTTPServerTransport)
          })
          transport.onclose = () => {
            if (transport?.sessionId) sessions.delete(transport.sessionId)
          }
          await buildServer().connect(transport)
        }

        if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }))
          return
        }
        await transport.handleRequest(req, res, body)
      } catch (e) {
        if (!res.headersSent) res.writeHead(500)
        res.end(String(e))
      }
    })()
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    requests: () => requestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((e) => (e ? reject(e) : resolve()))
      })
  }
}

/** A tiny HTTP server that a refused redirect must never actually reach. `hits` is live (mutated in
 *  place, not snapshotted at creation), and `firstHit` resolves the first time it is hit. */
async function startTrap(): Promise<{
  url: string
  state: { hits: number }
  firstHit: Promise<void>
  close: () => Promise<void>
}> {
  const state = { hits: 0 }
  let resolveFirstHit: () => void = () => {}
  const firstHit = new Promise<void>((r) => {
    resolveFirstHit = r
  })
  const server = createServer((_req, res) => {
    state.hits += 1
    resolveFirstHit()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('trap hit')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/`,
    state,
    firstHit,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
}

/**
 * M2-0222 — a real CONNECT (HTTP tunneling) proxy on 127.0.0.1:0, standing in for both `EnvHttpProxyAgent`'s
 * and `ProxyAgent`'s proxy hop. `targets` records each CONNECT request's `req.url` EXACTLY as requested — the
 * proof point for the fix: a pinned session must tunnel to an address, never to the endpoint's host name.
 *
 * With `refuse` set, every CONNECT is answered with that status and nothing is dialled onward — for proving a
 * proxy's own refusal is reported as the proxy's, not as a bad API key or a down server. Otherwise the proxy
 * dials the requested host:port itself (a real TCP connect — `net.connect` resolves an IP-literal target
 * without touching DNS, which is what a pinned tunnel always sends) and splices the two sockets together.
 */
async function startConnectProxy(refuse?: number): Promise<{
  url: string
  targets: string[]
  close: () => Promise<void>
}> {
  const targets: string[] = []
  // `Duplex`, not `net.Socket`: Node types the http.Server 'connect' event's socket as the more general
  // `stream.Duplex` (it is a real net.Socket at runtime for a plain, non-TLS http.createServer()), and this
  // set holds both that socket and the plain net.Socket `netConnect` opens upstream.
  const sockets = new Set<Duplex>()
  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  }

  const server = createServer()
  server.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? ''
    targets.push(target)
    track(clientSocket)

    if (refuse) {
      clientSocket.end(`HTTP/1.1 ${refuse} Refused\r\n\r\n`)
      return
    }

    const bracketed = target.startsWith('[')
    const lastColon = target.lastIndexOf(':')
    const host = bracketed ? target.slice(1, target.indexOf(']')) : target.slice(0, lastColon)
    const port = Number(target.slice(lastColon + 1))

    const upstream = netConnect(port, host)
    track(upstream)
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    targets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

describe('mcpClient — against a real local Streamable HTTP mock (not a live BidStack/Plane instance)', () => {
  let mock: Awaited<ReturnType<typeof startMockMcp>>

  beforeAll(async () => {
    mock = await startMockMcp()
  })
  afterAll(async () => {
    await mock.close()
  })

  it('connects, authenticates, and discovers the declared tool', async () => {
    const r = await connectMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.tools).toContain('push_meeting_recap')
  })

  it('rejects a wrong API key with a clear auth error, not a crash', async () => {
    const r = await connectMcp(mock.url, 'wrong-key', NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.tools).toBeUndefined()
  })

  it('fails cleanly on an unreachable endpoint (no live server needed for this assertion)', async () => {
    const r = await connectMcp('http://127.0.0.1:1/mcp', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects empty inputs without ever making a network call', async () => {
    const noUrl = await connectMcp('', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(noUrl.ok).toBe(false)
    const noKey = await connectMcp(mock.url, '', NO_EXTRA_HEADERS, LABEL)
    expect(noKey.ok).toBe(false)
  })

  it('rejects a malformed URL with a clear message', async () => {
    const r = await connectMcp('not-a-url', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a valid url/i)
  })

  it('calls a tool end-to-end and the mock server actually receives the args', async () => {
    const args = { title: 'Q3 renewal sync', date: '2026-06-30', summary: 'Discussed renewal terms.' }
    const r = await pushToMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', args, LABEL)
    expect(r.ok).toBe(true)
    expect(mock.calls.at(-1)).toEqual(args)
  })

  it('push fails cleanly against a nonexistent tool name instead of crashing', async () => {
    const r = await pushToMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, 'no_such_tool', { x: 1 }, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('push rejects when required args are missing (schema-invalid call)', async () => {
    const r = await pushToMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', { title: 'only title' }, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('push refuses with no endpoint/key/tool configured, never throwing', async () => {
    await expect(pushToMcp('', API_KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', {}, LABEL)).resolves.toMatchObject({
      ok: false
    })
    await expect(pushToMcp(mock.url, '', NO_EXTRA_HEADERS, 'push_meeting_recap', {}, LABEL)).resolves.toMatchObject({
      ok: false
    })
    await expect(pushToMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, '', {}, LABEL)).resolves.toMatchObject({ ok: false })
  })

  it('refuses a cloud-metadata endpoint without ever making a network call (SSRF guard)', async () => {
    const connect = await connectMcp('http://169.254.169.254/latest/meta-data/', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(connect.ok).toBe(false)
    expect(connect.error).toMatch(/cloud metadata/i)

    const push = await pushToMcp('http://169.254.169.254/', API_KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', {}, LABEL)
    expect(push.ok).toBe(false)
    expect(push.error).toMatch(/cloud metadata/i)
  })

  it('refuses a non-http(s) scheme (e.g. file:) before connecting', async () => {
    const r = await connectMcp('file:///etc/passwd', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/http or https/i)
  })

  it('refuses data: and javascript: URLs before connecting', async () => {
    const data = await connectMcp('data:text/plain,hello', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/http or https/i)

    const js = await connectMcp('javascript:alert(1)', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(js.ok).toBe(false)
    expect(js.error).toMatch(/http or https|not a valid URL/i)
  })

  it('refuses IPv4-mapped IPv6 forms of the cloud-metadata address (SSRF denylist bypass)', async () => {
    // Both forms resolve/route to the same host as 169.254.169.254 — the OS network stack treats an
    // IPv4-mapped IPv6 literal as that IPv4 address, so a plain-string hostname check alone misses them.
    const dotted = await connectMcp('http://[::ffff:169.254.169.254]/latest/meta-data/', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(dotted.ok).toBe(false)
    expect(dotted.error).toMatch(/cloud metadata/i)

    const hex = await connectMcp('http://[::ffff:a9fe:a9fe]/latest/meta-data/', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(hex.ok).toBe(false)
    expect(hex.error).toMatch(/cloud metadata/i)
  })

  it('still allows a legitimate IPv6 localhost endpoint (no over-blocking)', async () => {
    // Guards against a fix that's too broad and blocks every IPv6 address, not just the mapped-metadata form.
    const r = await connectMcp('http://[::1]:1/mcp', API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).not.toMatch(/cloud metadata/i) // refused for being unreachable, not for the SSRF guard
  })

  it('error messages use the connection-specific label, not a hardcoded "Polo Pre-Sales"', async () => {
    const r = await connectMcp('', API_KEY, NO_EXTRA_HEADERS, 'Plane')
    expect(r.error).toMatch(/plane/i)
    expect(r.error).not.toMatch(/polo pre-sales/i)
  })
})

// Plane's hosted PAT endpoint needs a static `X-Workspace-slug` header alongside the bearer token — the
// real transport gap mcpClient.ts's `extraHeaders` parameter exists to close (see McpConnectionSchema).
describe('mcpClient — extraHeaders (Plane-shaped: bearer + X-Workspace-slug)', () => {
  let mock: Awaited<ReturnType<typeof startMockMcp>>

  beforeAll(async () => {
    mock = await startMockMcp({ requiredHeader: { name: 'X-Workspace-slug', value: 'acme-corp' } })
  })
  afterAll(async () => {
    await mock.close()
  })

  it('connects when the required extra header is present', async () => {
    const r = await connectMcp(mock.url, API_KEY, { 'X-Workspace-slug': 'acme-corp' }, 'Plane')
    expect(r.ok).toBe(true)
    expect(r.tools).toContain('push_meeting_recap')
  })

  it('is rejected when the extra header is missing (a plain bearer-only client, like BidStack, would fail here)', async () => {
    const r = await connectMcp(mock.url, API_KEY, {}, 'Plane')
    expect(r.ok).toBe(false)
  })

  it('is rejected when the extra header has the wrong value', async () => {
    const r = await connectMcp(mock.url, API_KEY, { 'X-Workspace-slug': 'wrong-workspace' }, 'Plane')
    expect(r.ok).toBe(false)
  })

  it('pushToMcp also carries extraHeaders on a real call', async () => {
    const args = { title: 'Renewal', date: '2026-06-30', summary: 'Notes.' }
    const r = await pushToMcp(mock.url, API_KEY, { 'X-Workspace-slug': 'acme-corp' }, 'push_meeting_recap', args, 'Plane')
    expect(r.ok).toBe(true)
    expect(mock.calls.at(-1)).toEqual(args)
  })
})

// M2-0147 — the SSRF guard validated the CONFIGURED endpoint's DNS answer once, well before the socket
// actually connected. A rebinding resolver (answer A on the check, answer B moments later on the real
// connect) walked straight past it. The fix pins one session's resolved address at connect time instead.
describe('mcpClient — the DNS-rebinding pin resolves each session once and dials that answer (M2-0147)', () => {
  let mock: Awaited<ReturnType<typeof startMockMcp>>
  let mockPort: number

  beforeAll(async () => {
    mock = await startMockMcp()
    mockPort = Number(new URL(mock.url).port)
  })
  afterAll(async () => {
    await mock.close()
  })

  it('M1a: connectMcp dials the address it validated even when the resolver later answers a metadata address', async () => {
    mockDnsHost('rebind-connect.mcp.test', [['127.0.0.1'], ['169.254.169.254']])
    const r = await connectMcp(`http://rebind-connect.mcp.test:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(true)
    expect(r.tools).toContain('push_meeting_recap')
    // The SDK's event-stream GET needs its own connection beyond the initialize POST — a resolver called
    // once here (not once per connection) proves the pin, not a lucky race against a resolver that never
    // actually changed its answer within the window.
    expect(dnsCallCount('rebind-connect.mcp.test')).toBe(1)
  })

  it('M1b: pushToMcp dials the address it validated even when the resolver later answers a metadata address', async () => {
    mockDnsHost('rebind-push.mcp.test', [['127.0.0.1'], ['169.254.169.254']])
    const args = { title: 'Renewal', date: '2026-06-30', summary: 'Notes.' }
    const r = await pushToMcp(
      `http://rebind-push.mcp.test:${mockPort}/mcp`,
      API_KEY,
      NO_EXTRA_HEADERS,
      'push_meeting_recap',
      args,
      LABEL
    )
    expect(r.ok).toBe(true)
    expect(mock.calls.at(-1)).toEqual(args)
    expect(dnsCallCount('rebind-push.mcp.test')).toBe(1)
  })

  it('M2: refuses a host when ANY resolved address is a cloud metadata address, before any request is sent', async () => {
    // 127.0.0.1 (the real mock server) resolves FIRST — a fix that only checked the address it connects
    // with, rather than every answer, would let this one straight through.
    mockDnsHost('rebind-mixed.mcp.test', [['127.0.0.1', '169.254.169.254']])
    const before = mock.requests()
    const r = await connectMcp(`http://rebind-mixed.mcp.test:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cloud metadata/i)
    expect(mock.requests()).toBe(before)
  })

  it('M3: treats an IPv4-mapped IPv6 answer as the metadata address it maps to', async () => {
    mockDnsHost('rebind-mapped.mcp.test', [['::ffff:169.254.169.254']])
    const before = mock.requests()
    const r = await connectMcp(`http://rebind-mapped.mcp.test:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cloud metadata/i)
    expect(mock.requests()).toBe(before)
  })
})

// MQA-145 — validateEndpointUrl only ever vetted the CONFIGURED URL. fetch defaults to redirect:'follow',
// so a server answering any request with a redirect to a cloud-metadata address (or anywhere else)
// walked straight past a guard whose whole purpose is that this client can never reach one — including
// the SDK's own event-stream GET, which never sees the transport's `requestInit`. Replaces MQA-145's
// original source-regex cover (deleted from mcpClient.audit.test.ts) with the behaviour it was meant to
// prove.
describe("mcpClient — refuses every redirect, including the SDK's own event-stream GET (MQA-145)", () => {
  it('M4: refuses a redirect on the handshake without ever reaching its target, and says to use the final URL', async () => {
    const trap = await startTrap()
    const mock = await startMockMcp({
      intercept: (req, res, body) => {
        if (req.method === 'POST' && isInitializeRequest(body)) {
          res.writeHead(307, { Location: trap.url })
          res.end()
          return true
        }
        return false
      }
    })
    try {
      const r = await connectMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, LABEL)
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/final URL/i)
      expect(trap.state.hits).toBe(0)
    } finally {
      await mock.close()
      await trap.close()
    }
  })

  it("M5: never follows a redirect on the SDK's event-stream GET", async () => {
    const trap = await startTrap()
    let resolveGetAnswered: () => void = () => {}
    const getAnswered = new Promise<void>((r) => {
      resolveGetAnswered = r
    })
    let getRedirects = 0
    const mock = await startMockMcp({
      intercept: async (req, res, body) => {
        if (req.method === 'GET') {
          getRedirects += 1
          res.writeHead(302, { Location: trap.url })
          res.end()
          resolveGetAnswered()
          return true
        }
        // Delay the tools/list POST — the only other request connectMcp makes — until the redirected
        // GET has had its chance to be followed. Answering tools/list right away lets connectMcp
        // return and withClient's `finally` run client.close(), which aborts the still-open event-stream
        // GET; a build that DOES follow the redirect would then only reach the trap by winning a race
        // against that abort, instead of being caught deterministically.
        if (isJSONRPCRequest(body) && body.method === 'tools/list') {
          await Promise.race([getAnswered, delay(2_000)])
          await Promise.race([trap.firstHit, delay(500)])
        }
        return false
      }
    })
    try {
      const r = await connectMcp(mock.url, API_KEY, NO_EXTRA_HEADERS, LABEL)
      // A refused/failed event-stream GET is best-effort (many real MCP servers don't push at all) and
      // must not fail the connection itself — only the redirect-following behaviour is under test here.
      expect(r.ok).toBe(true)
      expect(trap.state.hits).toBe(0)
      expect(getRedirects).toBe(1) // premise: the SDK really did attempt the GET exactly once
    } finally {
      await mock.close()
      await trap.close()
    }
  })
})

// M2-0222 (RF-AUDIT-R3-R1) — M2-0147's pin only covered a socket THIS process dials itself. Through a proxy
// (system route: every host; env route: every host outside NO_PROXY) undici's ProxyAgent resolves and dials
// the target itself, so neither the metadata refusal nor the DNS-rebinding pin ran at all. The fix pins the
// proxy's own tunnel to the address `lookup` resolved instead of letting the proxy resolve the host name.
const PROXY_ROUTE_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const
type ProxyRouteEnvKey = (typeof PROXY_ROUTE_ENV_KEYS)[number]
const PROXY_ENV_KEYS = [...PROXY_ROUTE_ENV_KEYS, 'NO_PROXY', 'no_proxy']
const SOCKS_PROXY_URLS = ['socks5://127.0.0.1:1', 'socks://127.0.0.1:1'] as const
const SOCKS_PROXY_CASES = PROXY_ROUTE_ENV_KEYS.flatMap((envKey, envIndex) =>
  SOCKS_PROXY_URLS.map((proxyUrl, schemeIndex) => [envKey, proxyUrl, envIndex * SOCKS_PROXY_URLS.length + schemeIndex] as const)
)

describe('mcpClient — the metadata refusal and the DNS pin hold on every proxy route (M2-0222)', () => {
  let mock: Awaited<ReturnType<typeof startMockMcp>>
  let mockPort: number
  let proxy: Awaited<ReturnType<typeof startConnectProxy>>
  let savedEnv: Record<string, string | undefined>

  /** Adopt one of direct/env/env+NO_PROXY/system, exactly as installProxyAwareFetch would find it at boot,
   *  then (re)install it as the real route so routeDispatcher()/routeDispatcher(lookup) both follow it. */
  const useRoute = async (
    opts: {
      system?: string
      env?: string
      envKey?: ProxyRouteEnvKey
      noProxy?: string
      extraEnv?: Partial<Record<ProxyRouteEnvKey, string>>
    } = {}
  ): Promise<void> => {
    for (const k of PROXY_ENV_KEYS) delete process.env[k]
    if (opts.env) process.env[opts.envKey ?? 'HTTP_PROXY'] = opts.env
    for (const [key, value] of Object.entries(opts.extraEnv ?? {})) process.env[key] = value
    if (opts.noProxy) process.env.NO_PROXY = opts.noProxy
    resolveProxy.mockResolvedValue(opts.system ? `PROXY ${new URL(opts.system).host}` : 'DIRECT')
    await installProxyAwareFetch()
  }

  // `use` closures read `proxy.url` lazily (at call time, once beforeAll has set it) — the array itself only
  // needs to exist by the time `it.each` reads its shape, not its captured values.
  const ROUTES = [
    { slug: 'direct', tunnels: false, use: () => useRoute({}) },
    { slug: 'env-noproxy', tunnels: false, use: () => useRoute({ env: proxy.url, noProxy: 'mcp.test' }) },
    { slug: 'env', tunnels: true, use: () => useRoute({ env: proxy.url }) },
    { slug: 'system', tunnels: true, use: () => useRoute({ system: proxy.url }) }
  ]

  beforeAll(async () => {
    savedEnv = {}
    for (const k of PROXY_ENV_KEYS) savedEnv[k] = process.env[k]
    mock = await startMockMcp()
    mockPort = Number(new URL(mock.url).port)
    proxy = await startConnectProxy()
  })

  afterAll(async () => {
    for (const k of PROXY_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    await proxy.close()
    await mock.close()
  })

  afterEach(async () => {
    await useRoute({})
  })

  it.each(ROUTES)(
    '$slug: refuses a host resolving to a cloud-metadata address before any tunnel or request',
    async ({ slug, use }) => {
      await use()
      const host = `metadata-${slug}.mcp.test`
      mockDnsHost(host, [['169.254.169.254']])
      const beforeTargets = proxy.targets.length
      const beforeRequests = mock.requests()

      const r = await connectMcp(`http://${host}:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)

      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/cloud metadata/i)
      expect(proxy.targets.length).toBe(beforeTargets)
      expect(mock.requests()).toBe(beforeRequests)
    }
  )

  it.each(ROUTES)(
    '$slug: dials, or tunnels to, only the address it pinned, consulting the resolver once',
    async ({ slug, tunnels, use }) => {
      await use()
      const host = `rebind-${slug}.mcp.test`
      mockDnsHost(host, [['127.0.0.1'], ['169.254.169.254']])
      const beforeTargets = proxy.targets.length

      const r = await connectMcp(`http://${host}:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)

      expect(r.ok).toBe(true)
      expect(r.tools).toContain('push_meeting_recap')
      expect(dnsCallCount(host)).toBe(1)
      const newTargets = proxy.targets.slice(beforeTargets)
      expect([...new Set(newTargets)]).toEqual(tunnels ? [`127.0.0.1:${mockPort}`] : [])
    }
  )

  it('system: tunnels to the IPv4 answer when the host also has an IPv6 one', async () => {
    await useRoute({ system: proxy.url })
    const host = 'dual-system.mcp.test'
    mockDnsHost(host, [['::1', '127.0.0.1']])
    const beforeTargets = proxy.targets.length

    const r = await connectMcp(`http://${host}:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)

    expect(r.ok).toBe(true)
    // Deduped for the same reason as the "consulting the resolver once" case above: the Streamable HTTP
    // transport keeps its GET SSE stream open while it sends POSTs, so one connectMcp() call legitimately
    // tunnels more than once (one pooled connection per concurrent request). The property this proves is
    // that every one of those tunnels landed on the pinned IPv4 answer, never the IPv6 one — not that the
    // transport happened to open exactly one connection.
    expect([...new Set(proxy.targets.slice(beforeTargets))]).toEqual([`127.0.0.1:${mockPort}`])
  })

  it('system: a proxy that refuses the pinned tunnel is named in the error, not the API key or the server', async () => {
    const refusingProxy = await startConnectProxy(403)
    try {
      await useRoute({ system: refusingProxy.url })
      const host = 'refused-system.mcp.test'
      mockDnsHost(host, [['127.0.0.1']])

      const r = await connectMcp(`http://${host}:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)

      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/proxy refused/i)
      expect(r.error).not.toMatch(/API key|server is running/i)
      expect(refusingProxy.targets).toEqual([`127.0.0.1:${mockPort}`])
    } finally {
      await refusingProxy.close()
    }
  })

  it.each(SOCKS_PROXY_CASES)(
    'env %s %s proxy is refused with an actionable message and sends nothing',
    async (envKey, proxyUrl, caseIndex) => {
      await useRoute({ env: proxyUrl, envKey })
      const host = `socks-route-${caseIndex}.mcp.test`
      mockDnsHost(host, [['127.0.0.1']])
      const before = mock.requests()

      const r = await connectMcp(`http://${host}:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)

      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/SOCKS/)
      expect(mock.requests()).toBe(before)
    }
  )

  it('env: an HTTP_PROXY SOCKS route is refused even when HTTPS_PROXY selects env boot mode', async () => {
    await useRoute({ env: proxy.url, envKey: 'HTTPS_PROXY', extraEnv: { HTTP_PROXY: 'socks5://127.0.0.1:1' } })
    const host = 'socks-mixed-env.mcp.test'
    mockDnsHost(host, [['127.0.0.1']])
    const beforeRequests = mock.requests()
    const beforeTargets = proxy.targets.length

    const r = await connectMcp(`http://${host}:${mockPort}/mcp`, API_KEY, NO_EXTRA_HEADERS, LABEL)

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/SOCKS/)
    expect(mock.requests()).toBe(beforeRequests)
    expect(proxy.targets.length).toBe(beforeTargets)
  })
})
