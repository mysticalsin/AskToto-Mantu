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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connectMcp, pushToMcp } from './mcpClient'

const API_KEY = 'test-mcp-key-123'
const LABEL = 'Polo Pre-Sales'
const NO_EXTRA_HEADERS = {}

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
 *  the mock is faithful to how a real multi-client MCP server actually behaves. */
async function startMockMcp(
  requiredHeader?: { name: string; value: string }
): Promise<{ url: string; close: () => Promise<void>; calls: Record<string, unknown>[] }> {
  const calls: Record<string, unknown>[] = []
  const sessions = new Map<string, StreamableHTTPServerTransport>()

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
      if (requiredHeader) {
        const got = req.headers[requiredHeader.name.toLowerCase()]
        if (got !== requiredHeader.value) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'missing required header' }))
          return
        }
      }
      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((e) => (e ? reject(e) : resolve()))
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
    mock = await startMockMcp({ name: 'X-Workspace-slug', value: 'acme-corp' })
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
