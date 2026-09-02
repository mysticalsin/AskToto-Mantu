/**
 * mcpClient.ts — generic MCP client for Métis's push-only integrations (BidStack 360° CRM, Plane).
 *
 * Every connection this module talks to exposes a real MCP server (standard MCP spec, Streamable HTTP
 * transport):
 *   - endpoint:  POST/GET a user-configured URL (e.g. http://localhost:4001/mcp for BidStack in dev;
 *     https://mcp.plane.so/http/api-key/mcp for Plane's hosted endpoint) — ALWAYS user-configured,
 *     never hardcoded.
 *   - auth: Authorization: Bearer <apiKey> (a plain API key, not OAuth) plus, for connections like
 *     Plane whose hosted endpoint needs more than a bearer token (its `X-Workspace-slug` header),
 *     `extraHeaders` merged onto every request.
 *
 * ClickUp is deliberately NOT wired through this module: its official remote MCP server is OAuth-2.1-
 * with-PKCE only, a materially different auth shape than the static bearer-header transport below. That
 * is its own scoped follow-up (see McpConnectionKindSchema in shared/ipc.ts).
 *
 * This module owns the low-level MCP plumbing only: connect, list tools, call a tool. It never persists
 * anything (that's main/index.ts's job) and never renders UI. Lives in the main process alongside
 * src/main/llm/* — the renderer never talks to an MCP endpoint directly.
 *
 * DEFENSIVE-CODING CONVENTIONS (mirrors src/main/llm/dust.ts + src/main/dustcli.ts):
 *   - every network call is wrapped so a failure returns { ok: false, error } — never throws into
 *     an unhandled rejection, never crashes the main process.
 *   - a hard timeout bounds every call (a remote MCP server may be unreachable, slow, or hung) via
 *     AbortController.
 *   - network/auth/timeout failures are classified into short, actionable messages instead of raw
 *     stack traces or fetch() internals leaking to the renderer.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { isIP, isIPv6 } from 'node:net'
import { promises as dns } from 'node:dns'
import { mainLog } from '../logger'

/** Bound every round-trip so an unreachable/hung server never blocks the main process. */
const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 30_000

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Cloud-metadata endpoints (AWS/GCP/Azure IMDS) must never be reachable through this client — a
// tampered or mistyped Settings value pointed here, combined with the stored bearer token, would let
// "push" act as an SSRF primitive against the host's own cloud credentials. Localhost/private-LAN
// addresses are deliberately still allowed: that's a real deployment model for these connections today
// (e.g. BidStack's own Settings page defaults to http://localhost:4001).
const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
  'fd00:ec2::254', // AWS's IPv6 IMDS address
  '100.100.100.200' // Alibaba Cloud's metadata address
])

/**
 * Cloud metadata services live in the IPv4 link-local range (169.254.0.0/16) — checking the whole
 * range instead of a single literal catches every provider's IMDS endpoint (AWS/GCP/Azure/DigitalOcean),
 * not just the one literal address already listed above.
 */
function isLinkLocalIPv4(ip: string): boolean {
  const parts = ip.split('.')
  return parts.length === 4 && parts[0] === '169' && parts[1] === '254'
}

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

/**
 * Reject non-http(s) schemes and known cloud-metadata hosts before any network call is made. A
 * hostname that isn't already a literal IP is resolved via DNS so a plain-looking name pointed at a
 * metadata address (rather than the literal address itself) can't sail past the check below.
 */
async function validateEndpointUrl(url: string, label: string): Promise<string | null> {
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
  if (candidates.some((h) => BLOCKED_HOSTS.has(h) || isLinkLocalIPv4(h))) {
    return `"${url}" points at a cloud metadata address, which is never a valid ${label} endpoint.`
  }
  if (!isIP(bareHost)) {
    try {
      // dns.lookup has no timeout/signal option, and a black-holing resolver (broken VPN, captive
      // portal) would otherwise hang the main process here, defeating this file's hard-timeout contract.
      // Bound it well under CONNECT_TIMEOUT_MS; a timeout falls through to the same catch as a lookup
      // failure (the real connect below surfaces any genuine problem).
      const resolved = await Promise.race([
        dns.lookup(bareHost, { all: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns lookup timeout')), 3000))
      ])
      if (resolved.some((r) => BLOCKED_HOSTS.has(r.address) || isLinkLocalIPv4(r.address))) {
        return `"${url}" resolves to a cloud metadata address, which is never a valid ${label} endpoint.`
      }
    } catch {
      /* a DNS lookup failure here isn't this guard's concern — the real connect attempt below will
         surface it as a normal connection error */
    }
  }
  return null
}

/**
 * Turn a raw connect/call failure into a short, actionable message. MCP SDK errors and Node's
 * fetch errors don't have a stable shape, so this matches on common substrings rather than types.
 */
function classifyError(e: unknown, endpointUrl: string, label: string): string {
  const raw = errMsg(e)
  const blob = raw.toLowerCase()
  // 'timed out'/'-32001' are the MCP SDK's own RequestTimeout shape ("MCP error -32001: Request timed
  // out"), which carries no 'abort' — without them a server that stalls mid-request lands in the
  // unknown-reason branch below and points the user at their API key instead of at reachability.
  if (blob.includes('abort') || blob.includes('timed out') || blob.includes('-32001')) {
    return `Timed out connecting to ${label} at ${endpointUrl}. Check the endpoint is reachable.`
  }
  if (blob.includes('401') || blob.includes('unauthor') || blob.includes('forbidden') || blob.includes('403')) {
    return `${label} rejected the API key (401/403). Check the key and its mcp scopes.`
  }
  if (
    blob.includes('econnrefused') ||
    blob.includes('enotfound') ||
    blob.includes('failed to fetch') ||
    blob.includes('fetch failed') ||
    blob.includes('network')
  ) {
    return `Could not reach ${label} at ${endpointUrl}. Check the endpoint URL and that the server is running.`
  }
  if (blob.includes('invalid url') || blob.includes('failed to parse url')) {
    return `"${endpointUrl}" is not a valid URL.`
  }
  // Redirects are refused outright (see withClient) — tell the user to use the final URL rather than
  // reporting this as an unreachable server, which would send them looking for the wrong problem.
  if (blob.includes('redirect')) {
    return `${label} redirected ${endpointUrl} somewhere else. Enter the endpoint's final URL instead.`
  }
  // Unclassified failure shape — never return stack traces or module paths. ClickUp tool validation
  // (invalid parameters, missing list_id) must stay ClickUp's own sentence, not "unknown reason".
  if (label === 'ClickUp') {
    const trimmed = raw.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (trimmed && !/node_modules|at Object\.|at async /.test(trimmed)) return trimmed
  }
  return `${label} connection failed for an unknown reason. Check the endpoint and API key.`
}

async function withClient<T>(
  endpointUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  timeoutMs: number,
  fn: (client: Client, opts: RequestOptions) => Promise<T>
): Promise<T> {
  // MCP SDK statically imported (NOT `await import()`): the main process is bytecode-compiled and dynamic
  // import throws "A dynamic import callback was not specified" under bytecode, which broke every BidStack
  // action. The SDK ships a CJS build (dist/cjs), so the static import is bytecode-safe.
  const client = new Client({ name: 'asktoto', version: '1.0.0' }, { capabilities: {} })
  // Fresh client + transport for this one call — never reused across calls, matching how dust.ts
  // creates a fresh DustAPI per stream.
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      // validateEndpointUrl() above checks the URL the user configured — and ONLY that one. fetch
      // defaults to redirect:'follow', so a server answering 302 -> http://169.254.169.254/… would walk
      // the request straight past a guard whose entire purpose is that this client can never reach a
      // cloud-metadata address. Refuse redirects instead of re-validating each hop: an MCP endpoint is a
      // concrete JSON-RPC URL, not a redirector, so following one is never something we want. A server
      // that genuinely moved surfaces as a clear "endpoint redirected" message (see classifyError) and
      // the user pastes the final URL.
      redirect: 'error'
    }
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // The bound has to ride on every request, not just connect(): the SDK forwards connect's options to
  // the `initialize` request alone, so a server that completes the handshake and then stalls on
  // tools/list or tools/call would otherwise run to the SDK's own 60s default — past the timeout this
  // module advertises, and reported as an unknown failure rather than a timeout.
  const requestOptions: RequestOptions = { signal: controller.signal, timeout: timeoutMs }
  try {
    await client.connect(transport, requestOptions)
    return await fn(client, requestOptions)
  } finally {
    clearTimeout(timer)
    try {
      await client.close()
    } catch {
      /* best-effort teardown — a close failure must never mask the real result/error */
    }
  }
}

export interface McpConnectResult {
  ok: boolean
  error?: string
  tools?: string[]
}

// Concurrent callers for the SAME endpoint+key (e.g. Settings' "Test connection" and a status refresh
// racing at once) share ONE real network round-trip and ONE "connect failed" log line instead of each
// opening their own connection and each logging their own copy of the same failure.
const inFlight = new Map<string, Promise<McpConnectResult>>()

async function connectMcpNow(
  url: string,
  key: string,
  extraHeaders: Record<string, string>,
  label: string
): Promise<McpConnectResult> {
  try {
    const tools = await withClient(url, key, extraHeaders, CONNECT_TIMEOUT_MS, async (client, opts) => {
      const res = await client.listTools(undefined, opts)
      return res.tools.map((t) => t.name)
    })
    return { ok: true, tools }
  } catch (e) {
    mainLog.warn(`[mcp:${label}] connect failed`, errMsg(e))
    return { ok: false, error: classifyError(e, url, label) }
  }
}

/**
 * Connect to an MCP endpoint, authenticate, and list its declared tools. Used both by "Test connection"
 * (no persistence) and to refresh the tool picker after a successful save. Never throws — every failure
 * path returns { ok: false, error }.
 */
export async function connectMcp(
  endpointUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  label: string
): Promise<McpConnectResult> {
  const url = (endpointUrl || '').trim()
  const key = (apiKey || '').trim()
  if (!url) return { ok: false, error: `Enter the ${label} MCP endpoint URL first.` }
  if (!key) return { ok: false, error: `Enter the ${label} API key first.` }
  const urlError = await validateEndpointUrl(url, label)
  if (urlError) return { ok: false, error: urlError }

  const configKey = JSON.stringify([url, key, extraHeaders])
  const existing = inFlight.get(configKey)
  if (existing) return existing

  const attempt = connectMcpNow(url, key, extraHeaders, label).finally(() => inFlight.delete(configKey))
  inFlight.set(configKey, attempt)
  return attempt
}

export interface McpPushResult {
  ok: boolean
  error?: string
  result?: unknown
}

/**
 * Call a single MCP tool (the "push" action). `args` is the already-built, already
 * confidentiality-checked payload — this function does no scrubbing of its own, it's a thin,
 * defensive transport wrapper. Never throws.
 */
export async function pushToMcp(
  endpointUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>,
  label: string
): Promise<McpPushResult> {
  const url = (endpointUrl || '').trim()
  const key = (apiKey || '').trim()
  const tool = (toolName || '').trim()
  if (!url) return { ok: false, error: `${label} endpoint is not configured. Set it up in Settings first.` }
  if (!key) return { ok: false, error: `${label} API key is not configured. Set it up in Settings first.` }
  if (!tool) return { ok: false, error: `No ${label} tool selected to push to.` }
  const urlError = await validateEndpointUrl(url, label)
  if (urlError) return { ok: false, error: urlError }
  try {
    const result = await withClient(url, key, extraHeaders, CALL_TIMEOUT_MS, (client, opts) =>
      client.callTool({ name: tool, arguments: args }, undefined, opts)
    )
    if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content
      const text = content?.find((c) => c.type === 'text')?.text
      // The tool's own error text comes from the external MCP server — untrusted content, so it's
      // capped before ever reaching the renderer, matching this module's short-actionable-message policy.
      return { ok: false, error: (text || `${label} reported an error running the tool.`).slice(0, 500) }
    }
    return { ok: true, result }
  } catch (e) {
    mainLog.warn(`[mcp:${label}] push failed`, errMsg(e))
    return { ok: false, error: classifyError(e, url, label) }
  }
}
