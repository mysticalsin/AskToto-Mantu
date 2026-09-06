/**
 * MCP-transport passthrough (plan D8 "Brokered"): for a connection whose catalog kind is `mcp` transport
 * (`github`, `custom-mcp`), `gateway.ts` never synthesizes tools itself - it forwards `initialize`,
 * `tools/list` and `tools/call` to the upstream MCP server over Streamable HTTP, with the stored
 * credential attached server-side as a header the seat never sees.
 *
 * ## Stateless-gateway handshake
 *
 * A real MCP Streamable HTTP session is `initialize` -> `notifications/initialized` -> further calls,
 * correlated by an `Mcp-Session-Id` the server may issue on `initialize`. This gateway is a stateless
 * Worker handling one independent HTTP request from the seat at a time, with no session store between
 * them (adding one would mean pinning a seat's session to a specific isolate or a Durable Object for no
 * real benefit - a fresh `initialize` costs one extra upstream round trip and MCP servers are designed to
 * tolerate a client reconnecting). So every `tools/list` or `tools/call` this module is asked to forward
 * runs its own complete, disposable handshake first (`initialize` then `notifications/initialized`, using
 * `Mcp-Session-Id` if the server returned one, exactly the sequence `connectors/probe.ts` already proves
 * out for its own `tools/list` during "Test connection") and then makes the one real call the seat asked
 * for. The seat's own `initialize` call is still forwarded as its own request when the seat happens to
 * send one first (so `serverInfo`/`capabilities` come back to a client library that expects them before
 * anything else); the client-facing session concept is otherwise fully absorbed here.
 *
 * `clientInfo` is always overridden to identify the gateway itself, never the calling seat - the upstream
 * server has no legitimate reason to know which of Tony's seats is behind any given call.
 */
import { safeResolvedUrl, type AdapterCallOutcome } from './shared'

const MCP_PROTOCOL_VERSION = '2025-06-18'
const MCP_PROTOCOL_VERSION_FALLBACK = '2025-03-26'
const GATEWAY_CLIENT_INFO = { name: 'metis-operator-gateway', version: '1.0.0' }

export interface ProxyConnectionInfo {
  /** Absolute endpoint URL (the catalog's fixed `endpoint` for `github`, or `config.baseUrl` for
   *  `custom-mcp`) - resolved and SSRF-checked by this module, never trusted verbatim from the row. */
  endpoint: string
  credential: string | null
  /** Set only for a `custom-mcp` connection whose admin chose "send as a raw header" over Bearer. */
  headerName?: string | null
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = []
  for (const block of text.split('\n\n')) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (!dataLines.length) continue
    try {
      messages.push(JSON.parse(dataLines.join('\n')) as JsonRpcMessage)
    } catch {
      /* skip a malformed SSE frame */
    }
  }
  return messages
}

function parseMcpBody(text: string, contentType: string | null): JsonRpcMessage[] {
  if (contentType && contentType.includes('text/event-stream')) return parseSseMessages(text)
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function authHeaders(info: ProxyConnectionInfo): Record<string, string> {
  if (!info.credential) return {}
  if (info.headerName) return { [info.headerName]: info.credential }
  return { authorization: `Bearer ${info.credential}` }
}

interface RawCallResult {
  ok: boolean
  status?: number
  message?: JsonRpcMessage
  sessionId?: string
  timedOut: boolean
  networkError: boolean
  blocked?: { code: string; message: string }
}

async function rawMcpCall(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  expectBody: boolean,
  deadlineAt: number
): Promise<RawCallResult> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return { ok: false, timedOut: true, networkError: false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remaining)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, timedOut: false, networkError: false }
    const sessionId = res.headers.get('mcp-session-id') || undefined
    if (!expectBody) return { ok: res.status < 300, status: res.status, sessionId, timedOut: false, networkError: false }
    const text = (await res.text()).slice(0, 256 * 1024)
    if (res.status >= 400) return { ok: false, status: res.status, sessionId, timedOut: false, networkError: false }
    const messages = parseMcpBody(text, res.headers.get('content-type'))
    const message = messages.find((m) => m.id === payload.id) ?? messages[0]
    return { ok: Boolean(message) && !message?.error, status: res.status, message, sessionId, timedOut: false, networkError: false }
  } catch {
    if (controller.signal.aborted) return { ok: false, timedOut: true, networkError: false }
    return { ok: false, timedOut: false, networkError: true }
  } finally {
    clearTimeout(timer)
  }
}

export interface ProxyHandshakeResult {
  ok: boolean
  headers?: Record<string, string>
  url?: string
  error?: { code: string; message: string }
}

/** Resolves + SSRF-checks the endpoint, then runs `initialize` + `notifications/initialized`. Returns the
 *  headers (including the session id if the server issued one) the caller's real request should reuse. */
async function handshake(info: ProxyConnectionInfo, fetchImpl: typeof fetch, deadlineAt: number): Promise<ProxyHandshakeResult> {
  const check = await safeResolvedUrl(fetchImpl, info.endpoint, deadlineAt)
  if (!check.ok || !check.url) return { ok: false, error: check.error }
  const url = check.url.toString()
  const base = authHeaders(info)
  const initPayload = (protocolVersion: string) => ({
    jsonrpc: '2.0',
    id: '__gateway_init__',
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: GATEWAY_CLIENT_INFO }
  })
  let init = await rawMcpCall(fetchImpl, url, base, initPayload(MCP_PROTOCOL_VERSION), true, deadlineAt)
  if (!init.ok && !init.timedOut && !init.networkError) {
    init = await rawMcpCall(fetchImpl, url, base, initPayload(MCP_PROTOCOL_VERSION_FALLBACK), true, deadlineAt)
  }
  if (init.timedOut) return { ok: false, error: { code: 'timeout', message: 'The upstream MCP server timed out.' } }
  if (init.networkError) return { ok: false, error: { code: 'network', message: 'Could not reach the upstream MCP server.' } }
  if (!init.ok) return { ok: false, error: { code: 'handshake-failed', message: 'The upstream MCP server rejected the handshake.' } }
  const sessionHeaders = init.sessionId ? { ...base, 'mcp-session-id': init.sessionId } : base
  await rawMcpCall(fetchImpl, url, sessionHeaders, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false, deadlineAt)
  return { ok: true, headers: sessionHeaders, url }
}

export interface ProxyRpcOutcome {
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

/** Forwards the seat's own `initialize` call verbatim (its `clientInfo` swapped for the gateway's). Used
 *  only when the seat's MCP client sends `initialize` as its first request to us. */
export async function proxyInitialize(
  info: ProxyConnectionInfo,
  params: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch,
  deadlineAt: number
): Promise<ProxyRpcOutcome> {
  const check = await safeResolvedUrl(fetchImpl, info.endpoint, deadlineAt)
  if (!check.ok || !check.url) return { ok: false, error: check.error! }
  const protocolVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION
  const payload = {
    jsonrpc: '2.0',
    id: '__gateway_seat_init__',
    method: 'initialize',
    params: { protocolVersion, capabilities: params?.capabilities ?? {}, clientInfo: GATEWAY_CLIENT_INFO }
  }
  const res = await rawMcpCall(fetchImpl, check.url.toString(), authHeaders(info), payload, true, deadlineAt)
  if (res.timedOut) return { ok: false, error: { code: 'timeout', message: 'The upstream MCP server timed out.' } }
  if (res.networkError) return { ok: false, error: { code: 'network', message: 'Could not reach the upstream MCP server.' } }
  if (!res.ok || !res.message?.result) {
    return { ok: false, error: { code: 'handshake-failed', message: res.message?.error?.message || 'The upstream MCP server rejected the handshake.' } }
  }
  return { ok: true, result: res.message.result }
}

export async function proxyToolsList(info: ProxyConnectionInfo, fetchImpl: typeof fetch, deadlineAt: number): Promise<ProxyRpcOutcome> {
  const shake = await handshake(info, fetchImpl, deadlineAt)
  if (!shake.ok || !shake.headers || !shake.url) return { ok: false, error: shake.error }
  const res = await rawMcpCall(fetchImpl, shake.url, shake.headers, { jsonrpc: '2.0', id: '__gateway_list__', method: 'tools/list', params: {} }, true, deadlineAt)
  if (res.timedOut) return { ok: false, error: { code: 'timeout', message: 'The upstream MCP server timed out.' } }
  if (res.networkError) return { ok: false, error: { code: 'network', message: 'Could not reach the upstream MCP server.' } }
  if (!res.ok || !res.message?.result) {
    return { ok: false, error: { code: 'upstream-error', message: res.message?.error?.message || 'The upstream MCP server could not list its tools.' } }
  }
  return { ok: true, result: res.message.result }
}

/** Unlike `proxyInitialize`/`proxyToolsList`, a failure here is reported as a tool-level `isError`
 *  result (never a JSON-RPC top-level error) - `tools/call` failing upstream is an ordinary, expected
 *  outcome for a tool call, not a broken gateway. */
export async function proxyToolsCall(
  info: ProxyConnectionInfo,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
  deadlineAt: number
): Promise<AdapterCallOutcome & { timedOut: boolean }> {
  const shake = await handshake(info, fetchImpl, deadlineAt)
  if (!shake.ok || !shake.headers || !shake.url) {
    return { content: [{ type: 'text', text: shake.error?.message || 'Could not reach the upstream MCP server.' }], isError: true, timedOut: shake.error?.code === 'timeout' }
  }
  const res = await rawMcpCall(
    fetchImpl,
    shake.url,
    shake.headers,
    { jsonrpc: '2.0', id: '__gateway_call__', method: 'tools/call', params: { name, arguments: args } },
    true,
    deadlineAt
  )
  if (res.timedOut) return { content: [{ type: 'text', text: 'The upstream MCP server timed out.' }], isError: true, timedOut: true }
  if (res.networkError) return { content: [{ type: 'text', text: 'Could not reach the upstream MCP server.' }], isError: true, timedOut: false }
  if (!res.ok || !res.message?.result) {
    return {
      content: [{ type: 'text', text: res.message?.error?.message || 'The upstream MCP server rejected the tool call.' }],
      isError: true,
      timedOut: false
    }
  }
  const result = res.message.result as { content?: unknown; isError?: boolean }
  return {
    content: Array.isArray(result.content) ? (result.content as { type: 'text'; text: string }[]) : [{ type: 'text', text: JSON.stringify(result) }],
    isError: Boolean(result.isError),
    timedOut: false
  }
}
