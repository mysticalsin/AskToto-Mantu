/**
 * bidstackClient.ts — MCP client for BidStack 360°, Tony's own CRM.
 *
 * BidStack exposes a real MCP server (standard MCP spec, Streamable HTTP transport):
 *   - discovery: GET /.well-known/mcp
 *   - endpoint:  POST/GET /mcp (e.g. http://localhost:4001/mcp in dev; Azure-hosted later —
 *     ALWAYS a user-configured URL, never hardcoded)
 *   - auth: Authorization: Bearer <BIDSTACK_API_KEY> (a plain API key, not OAuth)
 *
 * This module owns the low-level MCP plumbing only: connect, list tools, call a tool. It never
 * persists anything (that's main/index.ts's job) and never renders UI. Lives in the main process
 * alongside src/main/llm/* — the renderer never talks to BidStack directly.
 *
 * DEFENSIVE-CODING CONVENTIONS (mirrors src/main/llm/dust.ts + src/main/dustcli.ts):
 *   - every network call is wrapped so a failure returns { ok: false, error } — never throws into
 *     an unhandled rejection, never crashes the main process.
 *   - a hard timeout bounds every call (BidStack may be unreachable, slow, or hung) via AbortController.
 *   - network/auth/timeout failures are classified into short, actionable messages instead of raw
 *     stack traces or fetch() internals leaking to the renderer.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mainLog } from '../logger'

/** Bound every BidStack round-trip so an unreachable/hung server never blocks the main process. */
const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 30_000

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Cloud-metadata endpoints (AWS/GCP/Azure IMDS) must never be reachable through this client — a
// tampered or mistyped Settings value pointed here, combined with the stored bearer token, would let
// "push" act as an SSRF primitive against the host's own cloud credentials. Localhost/private-LAN
// addresses are deliberately still allowed: that's BidStack's actual deployment model today (its own
// Settings page defaults to http://localhost:4001).
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.azure.com'])

/** Reject non-http(s) schemes and known cloud-metadata hosts before any network call is made. */
function validateEndpointUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `"${url}" is not a valid URL.`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `"${url}" must be an http or https URL.`
  }
  if (BLOCKED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return `"${url}" points at a cloud metadata address, which is never a valid BidStack endpoint.`
  }
  return null
}

/**
 * Turn a raw connect/call failure into a short, actionable message. MCP SDK errors and Node's
 * fetch errors don't have a stable shape, so this matches on common substrings rather than types.
 */
function classifyError(e: unknown, endpointUrl: string): string {
  const raw = errMsg(e)
  const blob = raw.toLowerCase()
  if (blob.includes('abort')) {
    return `Timed out connecting to BidStack at ${endpointUrl}. Check the endpoint is reachable.`
  }
  if (blob.includes('401') || blob.includes('unauthor') || blob.includes('forbidden') || blob.includes('403')) {
    return 'BidStack rejected the API key (401/403). Check the key and its mcp scopes.'
  }
  if (
    blob.includes('econnrefused') ||
    blob.includes('enotfound') ||
    blob.includes('failed to fetch') ||
    blob.includes('fetch failed') ||
    blob.includes('network')
  ) {
    return `Could not reach BidStack at ${endpointUrl}. Check the endpoint URL and that the server is running.`
  }
  if (blob.includes('invalid url') || blob.includes('failed to parse url')) {
    return `"${endpointUrl}" is not a valid URL.`
  }
  return raw || 'BidStack connection failed for an unknown reason.'
}

/** Build a fresh client + transport for a single call. Never reused across calls — each connect() /
 *  push is a short-lived session, matching how dust.ts creates a fresh DustAPI per stream. */
function buildTransport(endpointUrl: string, apiKey: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(endpointUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  })
}

async function withClient<T>(
  endpointUrl: string,
  apiKey: string,
  timeoutMs: number,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ name: 'asktoto', version: '1.0.0' }, { capabilities: {} })
  const transport = buildTransport(endpointUrl, apiKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await client.connect(transport, { signal: controller.signal })
    return await fn(client)
  } finally {
    clearTimeout(timer)
    try {
      await client.close()
    } catch {
      /* best-effort teardown — a close failure must never mask the real result/error */
    }
  }
}

export interface BidstackConnectResult {
  ok: boolean
  error?: string
  tools?: string[]
}

/**
 * Connect to BidStack's MCP endpoint, authenticate, and list its declared tools. Used both by
 * "Test connection" (no persistence) and to refresh the tool picker after a successful save.
 * Never throws — every failure path returns { ok: false, error }.
 */
export async function connectBidstack(endpointUrl: string, apiKey: string): Promise<BidstackConnectResult> {
  const url = (endpointUrl || '').trim()
  const key = (apiKey || '').trim()
  if (!url) return { ok: false, error: 'Enter the BidStack MCP endpoint URL first.' }
  if (!key) return { ok: false, error: 'Enter the BidStack API key first.' }
  const urlError = validateEndpointUrl(url)
  if (urlError) return { ok: false, error: urlError }
  try {
    const tools = await withClient(url, key, CONNECT_TIMEOUT_MS, async (client) => {
      const res = await client.listTools()
      return res.tools.map((t) => t.name)
    })
    return { ok: true, tools }
  } catch (e) {
    mainLog.warn('[bidstack] connect failed', errMsg(e))
    return { ok: false, error: classifyError(e, url) }
  }
}

export interface BidstackPushResult {
  ok: boolean
  error?: string
  result?: unknown
}

/**
 * Call a single BidStack MCP tool (the "push" action). `args` is the already-built, already
 * confidentiality-checked payload — this function does no scrubbing of its own, it's a thin,
 * defensive transport wrapper. Never throws.
 */
export async function pushToBidstack(
  endpointUrl: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<BidstackPushResult> {
  const url = (endpointUrl || '').trim()
  const key = (apiKey || '').trim()
  const tool = (toolName || '').trim()
  if (!url) return { ok: false, error: 'BidStack endpoint is not configured. Set it up in Settings first.' }
  if (!key) return { ok: false, error: 'BidStack API key is not configured. Set it up in Settings first.' }
  if (!tool) return { ok: false, error: 'No BidStack tool selected to push to.' }
  const urlError = validateEndpointUrl(url)
  if (urlError) return { ok: false, error: urlError }
  try {
    const result = await withClient(url, key, CALL_TIMEOUT_MS, (client) =>
      client.callTool({ name: tool, arguments: args })
    )
    if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content
      const text = content?.find((c) => c.type === 'text')?.text
      return { ok: false, error: text || 'BidStack reported an error running the tool.' }
    }
    return { ok: true, result }
  } catch (e) {
    mainLog.warn('[bidstack] push failed', errMsg(e))
    return { ok: false, error: classifyError(e, url) }
  }
}
