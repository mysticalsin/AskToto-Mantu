/**
 * mcpClient.audit.test.ts — regression cover for the audited defects in the generalized MCP client
 * (formerly bidstackClient.audit.test.ts, before mcpClient.ts generalized past BidStack).
 *
 * The sibling mcpClient.test.ts drives a REAL local Streamable HTTP mock and is the right place for
 * wire-protocol behaviour. It cannot cover this file's subject: CONNECT_TIMEOUT_MS / CALL_TIMEOUT_MS
 * are module constants, so proving a stalled request is actually bounded against a live server would
 * mean a 15s/30s wall-clock wait per assertion (and a 60s one to demonstrate the regression). So the
 * SDK Client is stubbed here instead, and the assertions pin the exact request-level contract the fix
 * establishes — that the bound rides on tools/list and tools/call, not on `initialize` alone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sdk = vi.hoisted(() => ({
  // Typed to the SDK's real call shapes rather than inferred from the stub bodies. Inference gave these
  // zero-parameter tuples, so every assertion below that reads the params or the { signal } options —
  // which is the entire point of this suite, since it exists to prove the abort signal and audit metadata
  // are passed — was a type error against calls production makes on every MCP request.
  connect: vi.fn(async (_transport?: unknown, _opts?: { signal?: AbortSignal; timeout?: number }) => undefined),
  listTools: vi.fn(async (_params?: unknown, _opts?: { signal?: AbortSignal; timeout?: number }) => ({
    tools: [{ name: 'push_meeting_recap' }]
  })),
  callTool: vi.fn(async (_params?: unknown, _resultSchema?: unknown, _opts?: { signal?: AbortSignal; timeout?: number }) => ({
    content: [{ type: 'text', text: 'ok' }]
  })),
  close: vi.fn(async () => undefined)
}))

// Stubbing the SDK Client is what makes the timeout contract observable: the real client only reveals
// its per-request bound by stalling for the full DEFAULT_REQUEST_TIMEOUT_MSEC (60s).
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = sdk.connect
    listTools = sdk.listTools
    callTool = sdk.callTool
    close = sdk.close
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, _init?: unknown) {}
  }
}))

import { connectMcp, pushToMcp } from './mcpClient'

const URL_OK = 'http://127.0.0.1:4001/mcp'
const KEY = 'test-mcp-key-123'
const LABEL = 'Polo Pre-Sales'
const NO_EXTRA_HEADERS = {}

describe('mcpClient — audited defects', () => {
  beforeEach(() => {
    sdk.connect.mockClear()
    sdk.listTools.mockClear()
    sdk.callTool.mockClear()
    sdk.close.mockClear()
    sdk.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
  })

  // MQA-065 — the SDK forwards connect()'s options to the `initialize` request only, so tools/list
  // ran unbounded at the SDK's own 60s default instead of the 15s this module advertises.
  it('MQA-065: bounds tools/list with the same abort signal and timeout as connect', async () => {
    const r = await connectMcp(URL_OK, KEY, NO_EXTRA_HEADERS, LABEL)
    expect(r.ok).toBe(true)

    expect(sdk.listTools).toHaveBeenCalledTimes(1)
    const [params, opts] = sdk.listTools.mock.calls[0]
    expect(params).toBeUndefined() // tools/list takes no params — the bound rides in the 2nd argument
    expect(opts?.timeout).toBe(15_000)
    expect(opts?.signal).toBeInstanceOf(AbortSignal)
    // Same controller as the connect leg: one timer bounds the whole round-trip, not two independent ones.
    const connectOpts = sdk.connect.mock.calls[0][1]
    expect(opts?.signal).toBe(connectOpts?.signal)
  })

  // MQA-065 — a CRM write is the realistic stall (slow DB, loaded host, buffering proxy): initialize
  // completes fast, then tools/call hangs.
  it('MQA-065: bounds tools/call with the same abort signal and timeout as connect', async () => {
    const args = { title: 'Q3 renewal sync', date: '2026-06-30', summary: 'Discussed renewal terms.' }
    const r = await pushToMcp(URL_OK, KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', args, LABEL)
    expect(r.ok).toBe(true)

    expect(sdk.callTool).toHaveBeenCalledTimes(1)
    const [params, resultSchema, opts] = sdk.callTool.mock.calls[0] as [
      unknown,
      unknown,
      { signal?: AbortSignal; timeout?: number }
    ]
    expect(params).toEqual({ name: 'push_meeting_recap', arguments: args })
    expect(resultSchema).toBeUndefined() // leaves the SDK's own CallToolResultSchema default in place
    expect(opts?.timeout).toBe(30_000)
    expect(opts?.signal).toBeInstanceOf(AbortSignal)
    const connectOpts = sdk.connect.mock.calls[0][1]
    expect(opts?.signal).toBe(connectOpts?.signal)
  })

  // MQA-065 — the SDK's RequestTimeout carries no 'abort' substring, so it used to land in the
  // unknown-reason branch and send the user to re-check an API key that was never the problem.
  it('MQA-065: reports an SDK request timeout as a timeout, not an unknown failure', async () => {
    sdk.callTool.mockRejectedValueOnce(new Error('MCP error -32001: Request timed out'))

    const r = await pushToMcp(URL_OK, KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', { title: 't' }, LABEL)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out connecting to polo pre-sales/i)
    expect(r.error).toMatch(/reachable/i)
    expect(r.error).not.toMatch(/unknown reason/i)
    expect(r.error).not.toMatch(/api key/i)
  })

  // MQA-065 — the timeout branch must not swallow the auth/network classifications that already worked.
  it('MQA-065: still classifies auth and network failures distinctly from a timeout', async () => {
    sdk.callTool.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))
    const auth = await pushToMcp(URL_OK, KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', {}, LABEL)
    expect(auth.error).toMatch(/rejected the api key/i)

    sdk.callTool.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
    const net = await pushToMcp(URL_OK, KEY, NO_EXTRA_HEADERS, 'push_meeting_recap', {}, LABEL)
    expect(net.error).toMatch(/could not reach polo pre-sales/i)
  })

  it('a second connection kind (e.g. Plane) gets its own label in every error branch', async () => {
    sdk.callTool.mockRejectedValueOnce(new Error('MCP error -32001: Request timed out'))
    const timeout = await pushToMcp(URL_OK, KEY, { 'X-Workspace-slug': 'acme' }, 'push_meeting_recap', {}, 'Plane')
    expect(timeout.error).toMatch(/timed out connecting to plane/i)

    sdk.callTool.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))
    const auth = await pushToMcp(URL_OK, KEY, { 'X-Workspace-slug': 'acme' }, 'push_meeting_recap', {}, 'Plane')
    expect(auth.error).toMatch(/plane rejected the api key/i)
  })
})

// MQA-145 — validateEndpointUrl checks the CONFIGURED url and only that one. fetch defaults to
// redirect:'follow', so a 302 to a cloud-metadata address would sail past the guard whose whole purpose
// is that this client can never reach one. The transport refuses redirects instead.
describe('MQA-145: the SSRF guard cannot be walked around with a redirect', () => {
  const src = readFileSync(join(__dirname, 'mcpClient.ts'), 'utf8')

  it("sets redirect:'error' on the transport's requestInit", () => {
    const at = src.indexOf('new StreamableHTTPClientTransport(')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 900)).toMatch(/redirect: 'error'/)
  })

  it('reports a refused redirect as its own actionable message, not as an unreachable server', () => {
    expect(src).toMatch(/blob\.includes\('redirect'\)/)
    expect(src).toMatch(/Enter the endpoint's final URL instead/)
  })
})
