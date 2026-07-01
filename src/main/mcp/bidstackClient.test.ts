/**
 * bidstackClient.test.ts — proves connect/auth/list-tools/call-tool against a REAL Streamable HTTP +
 * bearer-auth server, not just type-checking.
 *
 * The mock server below is built from the MCP TypeScript SDK's own server-side pieces (McpServer +
 * StreamableHTTPServerTransport), listening on a real localhost TCP port — the same Streamable HTTP
 * wire protocol BidStack's own MCP endpoint speaks. Bearer-token auth is layered on top exactly like
 * BidStack's own contract: the MCP spec/SDK does not enforce auth itself, so the mock's raw http
 * listener checks `Authorization: Bearer <key>` before ever handing the request to the SDK transport —
 * mirroring how BidStack's backend gates its /mcp endpoint.
 *
 * IMPORTANT — scope of what this proves: this validates bidstackClient.ts's connect/auth/listTools/
 * callTool logic against a spec-faithful LOCAL mock. It does NOT prove connectivity to Tony's real
 * BidStack instance (no live reachable instance exists yet — see the Phase 3 plan). That live check
 * still needs to happen once a real BidStack endpoint is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connectBidstack, pushToBidstack } from './bidstackClient'

const API_KEY = 'test-bidstack-key-123'

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

/** Build a real HTTP server backing a minimal MCP server with one "push" tool, gated by a bearer token —
 *  faithful to BidStack's real /mcp contract (auth is enforced by the app layer, not the MCP transport).
 *
 *  Multi-session routing: bidstackClient.ts opens a brand-new Client + transport (a fresh "initialize"
 *  handshake) on every connect/push call, exactly as a real MCP client does per short-lived task run.
 *  A real MCP server has to support many such independent client sessions concurrently — the SDK's own
 *  documented pattern is a session-id → transport map, creating a fresh transport on each new
 *  initialize request and routing subsequent requests by the Mcp-Session-Id header. Mirrored here so
 *  the mock is faithful to how a real multi-client MCP server (like BidStack's) actually behaves. */
async function startMockBidstack(): Promise<{ url: string; close: () => Promise<void>; calls: Record<string, unknown>[] }> {
  const calls: Record<string, unknown>[] = []
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const buildServer = (): McpServer => {
    const mcp = new McpServer({ name: 'bidstack-mock', version: '1.0.0' })
    mcp.registerTool(
      'push_meeting_recap',
      {
        description: 'Push a meeting recap into BidStack',
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

describe('bidstackClient — against a real local Streamable HTTP mock (not Tony\'s real BidStack)', () => {
  let mock: Awaited<ReturnType<typeof startMockBidstack>>

  beforeAll(async () => {
    mock = await startMockBidstack()
  })
  afterAll(async () => {
    await mock.close()
  })

  it('connects, authenticates, and discovers the declared tool', async () => {
    const r = await connectBidstack(mock.url, API_KEY)
    expect(r.ok).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.tools).toContain('push_meeting_recap')
  })

  it('rejects a wrong API key with a clear auth error, not a crash', async () => {
    const r = await connectBidstack(mock.url, 'wrong-key')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(r.tools).toBeUndefined()
  })

  it('fails cleanly on an unreachable endpoint (no live BidStack needed for this assertion)', async () => {
    const r = await connectBidstack('http://127.0.0.1:1/mcp', API_KEY)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects empty inputs without ever making a network call', async () => {
    const noUrl = await connectBidstack('', API_KEY)
    expect(noUrl.ok).toBe(false)
    const noKey = await connectBidstack(mock.url, '')
    expect(noKey.ok).toBe(false)
  })

  it('rejects a malformed URL with a clear message', async () => {
    const r = await connectBidstack('not-a-url', API_KEY)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a valid url/i)
  })

  it('calls a tool end-to-end and the mock server actually receives the args', async () => {
    const args = { title: 'Q3 renewal sync', date: '2026-06-30', summary: 'Discussed renewal terms.' }
    const r = await pushToBidstack(mock.url, API_KEY, 'push_meeting_recap', args)
    expect(r.ok).toBe(true)
    expect(mock.calls.at(-1)).toEqual(args)
  })

  it('push fails cleanly against a nonexistent tool name instead of crashing', async () => {
    const r = await pushToBidstack(mock.url, API_KEY, 'no_such_tool', { x: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('push rejects when required args are missing (schema-invalid call)', async () => {
    const r = await pushToBidstack(mock.url, API_KEY, 'push_meeting_recap', { title: 'only title' })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('push refuses with no endpoint/key/tool configured, never throwing', async () => {
    await expect(pushToBidstack('', API_KEY, 'push_meeting_recap', {})).resolves.toMatchObject({ ok: false })
    await expect(pushToBidstack(mock.url, '', 'push_meeting_recap', {})).resolves.toMatchObject({ ok: false })
    await expect(pushToBidstack(mock.url, API_KEY, '', {})).resolves.toMatchObject({ ok: false })
  })
})
