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
 * DEFENSIVE-CODING CONVENTIONS (mirrors src/main/llm/dust.ts + src/main/features/dust/dustcli.ts):
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
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { mainLog } from '../logger'
import { routeDispatcher, UnpinnableProxyError } from '../net/install-proxy'

/** Bound every round-trip so an unreachable/hung server never blocks the main process. */
const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 30_000

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Cloud-metadata endpoints (AWS/GCP/Azure IMDS) must never be reachable through this client — a
// tampered or mistyped Settings value pointed here, combined with the stored bearer token, would let
// "push" act as an SSRF primitive against the host's own cloud credentials. Localhost/private-LAN
// addresses are deliberately still allowed: that's a real deployment model for these connections today
// (e.g. BidStack's own Settings page defaults to http://localhost:4001).
//
// Three layers close this off, none of them alone: validateEndpointUrl (scheme, and the literal
// configured host, before any network call); sessionLookup (every address the session dials, or asks a
// proxy to tunnel to, pinned once per session, so a DNS-rebinding resolver can't answer differently for a
// later connection); and the transport's `fetch` override (refuses every redirect and keeps routing
// through the global fetch, so net/egress-guard.ts's managed allowlist still applies).
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
 * A cloud-metadata host name or address, including an IPv4-mapped IPv6 spelling of one (the network
 * stack routes that to the embedded IPv4 host).
 */
function isCloudMetadataAddress(host: string): boolean {
  const ipv4 = ipv4MappedAddress(host) ?? host
  return BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(ipv4) || isLinkLocalIPv4(ipv4)
}

/**
 * Reject non-http(s) schemes and the literal cloud-metadata hosts before any network call is made. A
 * host name's ADDRESSES are checked where they are used, at connect time in sessionLookup below, never
 * here — a check on a separate DNS resolution proves nothing about the address the socket later dials
 * (that separate resolution was the DNS-rebinding TOCTOU window itself: a resolver can answer once for
 * this check and differently moments later for the real connect).
 */
function validateEndpointUrl(url: string, label: string): string | null {
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
  if (isCloudMetadataAddress(bareHost)) {
    return `"${url}" points at a cloud metadata address, which is never a valid ${label} endpoint.`
  }
  return null
}

/** Raised inside sessionLookup; classifyError turns it into the user-facing refusal. `code` makes it
 *  genuinely satisfy the NodeJS.ErrnoException shape sessionLookup's callback casts rejections to,
 *  rather than just asserting a shape it doesn't have. */
class CloudMetadataAddressError extends Error {
  readonly code = 'ECLOUDMETADATA'
}

async function resolveAllowed(hostname: string): Promise<LookupAddress[]> {
  const addresses = await lookup(hostname, { all: true })
  if (addresses.some((a) => isCloudMetadataAddress(a.address))) {
    throw new CloudMetadataAddressError(`${hostname} resolves to a cloud metadata address`)
  }
  return addresses
}

/**
 * The connect-time `lookup` for one MCP session (one `withClient` call). Each host
 * is resolved ONCE. The answer is refused if ANY address is a cloud-metadata address; otherwise it is
 * pinned and handed to every connection the session opens. The address that passed the check is
 * therefore the only address the session ever dials: a resolver that changes its answer (DNS
 * rebinding) is never asked a second time, and a failed or stalled resolution dials nothing — it fails
 * closed and is bounded by the existing abort timer, never by a resolver's own timeout.
 *
 * Node's `net` calls this with `{ all: true }` under autoSelectFamily (Node 22's default) and with
 * `{ all: false }` otherwise; install-proxy's pinned tunnel calls it with `{ all: true }` too. All three
 * forms are handled. A pinned tunnel calls this for an IP-literal host as well, and `lookup` returns the
 * literal unchanged — validateEndpointUrl has already refused a metadata literal before this ever runs.
 */
function sessionLookup(): LookupFunction {
  const pinned = new Map<string, Promise<LookupAddress[]>>()
  return (hostname, options, callback) => {
    let answer = pinned.get(hostname)
    if (!answer) {
      answer = resolveAllowed(hostname)
      pinned.set(hostname, answer)
    }
    answer.then(
      (addresses) =>
        options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      (error: NodeJS.ErrnoException) => callback(error, '')
    )
  }
}

/** `e` and its causes: fetch reports every network failure as `TypeError('fetch failed')` with the real
 *  reason in `cause` — so a check against only the top-level message (e.g. for "redirect") never sees
 *  it. Stops at the first cycle so a (pathological) circular `cause` chain can't loop forever. */
function errorChain(e: unknown): Error[] {
  const chain: Error[] = []
  for (let c: unknown = e; c instanceof Error && !chain.includes(c); c = c.cause) chain.push(c)
  return chain
}

/**
 * Turn a raw connect/call failure into a short, actionable message. MCP SDK errors and Node's
 * fetch errors don't have a stable shape, so this matches on common substrings rather than types.
 */
function classifyError(e: unknown, endpointUrl: string, label: string): string {
  const raw = errMsg(e)
  const blob = raw.toLowerCase()
  if (errorChain(e).some((c) => c instanceof CloudMetadataAddressError)) {
    return `"${endpointUrl}" resolves to a cloud metadata address, which is never a valid ${label} endpoint.`
  }
  if (errorChain(e).some((c) => c instanceof UnpinnableProxyError)) {
    return `${label} can't be reached through a SOCKS proxy: the address it connects to can't be checked. Use an HTTP proxy instead.`
  }
  // undici's own refusal shape when the proxy answers CONNECT with anything but 200.
  if (errorChain(e).some((c) => /^Proxy response \(\d+\)/.test(c.message))) {
    return `The network proxy refused the connection to ${label} at ${endpointUrl}. Ask IT to allow it through the proxy.`
  }
  // 'timed out'/'-32001' are the MCP SDK's own RequestTimeout shape ("MCP error -32001: Request timed
  // out"), which carries no 'abort' — without them a server that stalls mid-request lands in the
  // unknown-reason branch below and points the user at their API key instead of at reachability.
  if (blob.includes('abort') || blob.includes('timed out') || blob.includes('-32001')) {
    return `Timed out connecting to ${label} at ${endpointUrl}. Check the endpoint is reachable.`
  }
  if (blob.includes('401') || blob.includes('unauthor') || blob.includes('forbidden') || blob.includes('403')) {
    return `${label} rejected the API key (401/403). Check the key and its mcp scopes.`
  }
  // Redirects are refused outright (see withClient), and fetch's own refusal is
  // `TypeError('fetch failed', { cause: Error('unexpected redirect') })` — the top-level message never
  // says "redirect", so this walks the whole error chain rather than checking only the top-level one.
  if (errorChain(e).some((c) => /redirect/i.test(c.message))) {
    return `${label} redirected ${endpointUrl} somewhere else. Enter the endpoint's final URL instead.`
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
  // One dispatcher for this one MCP session: sessionLookup() resolves this session's
  // endpoint host ONCE and pins the answer for every connection the session opens, closing the
  // DNS-rebinding window between validateEndpointUrl's literal-host check and the real connect.
  // routeDispatcher builds it on the SAME route as the global dispatcher, and aims that route's proxy
  // tunnels at the same pinned answer. Pinning therefore never bypasses a corporate proxy Plane/ClickUp
  // MCP are reached through, and the proxy never re-resolves the host. Throws UnpinnableProxyError on a
  // SOCKS env proxy — connectMcpNow/pushToMcp's callers already wrap this in try/catch.
  const dispatcher = routeDispatcher(sessionLookup())
  // Fresh client + transport for this one call — never reused across calls, matching how dust.ts
  // creates a fresh DustAPI per stream.
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders }
    },
    // Every request on this transport, including the SDK's own event-stream GET (which never sees
    // `requestInit` above), refuses a redirect — forced here, not left to `requestInit`, so it actually
    // covers that GET too. `fetch` stays the global one (patched by net/egress-guard.ts) so the managed
    // egress allowlist still applies; `dispatcher` rides through untouched.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        redirect: 'error',
        // Type-only skew: @types/node's RequestInit.dispatcher predates undici 7's Dispatcher shape,
        // which Node's fetch accepts at runtime. Cast once, here only — never widen this to a repo-wide `any`.
        dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']>
      })
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
    // After close, not before: closing the client aborts the event stream, so nothing is left
    // in-flight on this dispatcher to cut off when it is destroyed.
    try {
      await dispatcher.destroy()
    } catch {
      /* best-effort */
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
  const urlError = validateEndpointUrl(url, label)
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
  const urlError = validateEndpointUrl(url, label)
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
