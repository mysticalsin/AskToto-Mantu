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

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isIPv6 } from 'node:net'
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

/**
 * An IPv4-mapped IPv6 literal (e.g. "::ffff:169.254.169.254", or its hex-compressed form
 * "::ffff:a9fe:a9fe" — the OS/network stack routes both to the same underlying IPv4 host) would
 * otherwise bypass BLOCKED_HOSTS entirely, since URL's own hostname string never matches the plain
 * dotted-decimal form. Returns the embedded IPv4 address if `host` is one of these, else null.
 */
function ipv4MappedAddress(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (dotted) return dotted[1]
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

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
  const rawHost = parsed.hostname.toLowerCase()
  const bareHost = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const candidates = [bareHost]
  if (isIPv6(bareHost)) {
    const mapped = ipv4MappedAddress(bareHost)
    if (mapped) candidates.push(mapped)
  }
  if (candidates.some((h) => BLOCKED_HOSTS.has(h))) {
    return `"${url}" points at a cloud metadata address, which is never a valid Polo Pre-Sales endpoint.`
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
    return `Timed out connecting to Polo Pre-Sales at ${endpointUrl}. Check the endpoint is reachable.`
  }
  if (blob.includes('401') || blob.includes('unauthor') || blob.includes('forbidden') || blob.includes('403')) {
    return 'Polo Pre-Sales rejected the API key (401/403). Check the key and its mcp scopes.'
  }
  if (
    blob.includes('econnrefused') ||
    blob.includes('enotfound') ||
    blob.includes('failed to fetch') ||
    blob.includes('fetch failed') ||
    blob.includes('network')
  ) {
    return `Could not reach Polo Pre-Sales at ${endpointUrl}. Check the endpoint URL and that the server is running.`
  }
  if (blob.includes('invalid url') || blob.includes('failed to parse url')) {
    return `"${endpointUrl}" is not a valid URL.`
  }
  return raw || 'Polo Pre-Sales connection failed for an unknown reason.'
}

async function withClient<T>(
  endpointUrl: string,
  apiKey: string,
  timeoutMs: number,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  // Lazy-loaded: the MCP SDK's require tree costs real time at every process boot even though most
  // sessions never touch BidStack at all (it's an opt-in integration, not a default provider).
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  ])
  const client = new Client({ name: 'asktoto', version: '1.0.0' }, { capabilities: {} })
  // Fresh client + transport for this one call — never reused across calls, matching how dust.ts
  // creates a fresh DustAPI per stream.
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  })
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

// Concurrent callers for the SAME endpoint+key (e.g. Settings' "Test connection" and a status refresh
// racing at once) share ONE real network round-trip and ONE "connect failed" log line instead of each
// opening their own connection and each logging their own copy of the same failure.
const inFlight = new Map<string, Promise<BidstackConnectResult>>()

async function connectBidstackNow(url: string, key: string): Promise<BidstackConnectResult> {
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

/**
 * Connect to BidStack's MCP endpoint, authenticate, and list its declared tools. Used both by
 * "Test connection" (no persistence) and to refresh the tool picker after a successful save.
 * Never throws — every failure path returns { ok: false, error }.
 */
export async function connectBidstack(endpointUrl: string, apiKey: string): Promise<BidstackConnectResult> {
  const url = (endpointUrl || '').trim()
  const key = (apiKey || '').trim()
  if (!url) return { ok: false, error: 'Enter the Polo Pre-Sales MCP endpoint URL first.' }
  if (!key) return { ok: false, error: 'Enter the Polo Pre-Sales API key first.' }
  const urlError = validateEndpointUrl(url)
  if (urlError) return { ok: false, error: urlError }

  const configKey = `${url} ${key}`
  const existing = inFlight.get(configKey)
  if (existing) return existing

  const attempt = connectBidstackNow(url, key).finally(() => inFlight.delete(configKey))
  inFlight.set(configKey, attempt)
  return attempt
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
  if (!url) return { ok: false, error: 'Polo Pre-Sales endpoint is not configured. Set it up in Settings first.' }
  if (!key) return { ok: false, error: 'Polo Pre-Sales API key is not configured. Set it up in Settings first.' }
  if (!tool) return { ok: false, error: 'No Polo Pre-Sales tool selected to push to.' }
  const urlError = validateEndpointUrl(url)
  if (urlError) return { ok: false, error: urlError }
  try {
    const result = await withClient(url, key, CALL_TIMEOUT_MS, (client) =>
      client.callTool({ name: tool, arguments: args })
    )
    if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content
      const text = content?.find((c) => c.type === 'text')?.text
      return { ok: false, error: text || 'Polo Pre-Sales reported an error running the tool.' }
    }
    return { ok: true, result }
  } catch (e) {
    mainLog.warn('[bidstack] push failed', errMsg(e))
    return { ok: false, error: classifyError(e, url) }
  }
}
