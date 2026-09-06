/**
 * Server-side "Test connection" probe (plan section 4, D9/D10; task B2). Runs entirely inside the
 * Worker: for a `rest` catalog entry, one cheap authenticated HTTP call; for an `mcp` entry, a Streamable
 * HTTP MCP handshake (`initialize`, `notifications/initialized`, `tools/list`). Every rule below is a
 * hard security requirement, not a style preference (security review: SSRF surface).
 *
 * - URL scheme must be `https:`.
 * - Hostname must not be an IP literal in loopback, link-local, or private ranges (10/8, 172.16/12,
 *   192.168/16, fc00::/7, fe80::/10, ::1, 127/8), not `localhost`, not `*.internal`, not `*.local`, not
 *   `metadata.google.internal`, not the `169.254.169.254` cloud metadata address.
 * - `redirect: 'manual'`; a 3xx response is always a failure, never followed.
 * - 10 second timeout via `AbortController`.
 * - Response body capped at 64 KB while reading (a streamed cap, not a post-hoc slice of an unbounded read).
 * - The credential is never logged, never placed in `summary`, and never placed in `error.message`
 *   verbatim: upstream error bodies are truncated to 200 characters and passed through `redact.ts` first.
 *
 * `fetch` is injected via `deps` so tests run against a fake implementation; nothing here ever calls the
 * global `fetch` directly.
 */
import { looksLikeSecret } from '../redact'
import type { ConnectorCatalogEntry, RestProbeSpec } from './catalog'

export interface ProbeDeps {
  fetch: typeof globalThis.fetch
}

export interface ProbeInput {
  credential: string
  config: Record<string, string>
}

export interface ProbeToolInfo {
  name: string
  description?: string
  write: boolean
}

export interface ProbeResult {
  ok: boolean
  status?: number
  latencyMs: number
  summary: string
  tools?: ProbeToolInfo[]
  error?: { code: string; message: string }
}

export const PROBE_TIMEOUT_MS = 10_000
const PROBE_BODY_CAP_BYTES = 64 * 1024
const MCP_PROTOCOL_VERSION = '2025-06-18'
const MCP_PROTOCOL_VERSION_FALLBACK = '2025-03-26'
const WRITE_NAME_RE = /^(create|update|delete|remove|send|post|write|set|add|push|archive|move|assign|close|merge)/i

// ── SSRF guard ───────────────────────────────────────────────────────────────────────────────────────

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null
}

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts
  if (a === 127) return true // loopback
  if (a === 10) return true // private
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 169 && b === 254) return true // link-local (covers the cloud metadata address)
  if (a === 0) return true // "this network"
  return false
}

/** Expands a (possibly `::`-compressed) IPv6 literal to 8 hex groups, or null if it is not a bare literal
 *  (a bracketed literal has its brackets stripped by the caller before this runs). */
function expandIPv6(host: string): string[] | null {
  if (!host.includes(':')) return null
  if ((host.match(/::/g) || []).length > 1) return null
  const [headPart, tailPart] = host.split('::')
  const head = headPart ? headPart.split(':') : []
  const tail = host.includes('::') ? (tailPart ? tailPart.split(':') : []) : []
  if (!host.includes('::')) {
    const full = host.split(':')
    return full.length === 8 && full.every((g) => /^[0-9a-f]{0,4}$/i.test(g)) ? full : null
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = [...head, ...Array(missing).fill('0'), ...tail]
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{0,4}$/i.test(g)) ? groups : null
}

function isPrivateIPv6(host: string): boolean {
  const hex = expandIPv6(host)
  if (!hex) return false
  const groups = hex.map((g) => Number(`0x${g || '0'}`))
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (groups.every((g) => g === 0)) return true // :: (unspecified)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true // ::1
  // IPv4-mapped (`::ffff:a.b.c.d`, 5 zero groups + 0xffff + 2 groups of IPv4) or the deprecated
  // IPv4-compatible form (`::a.b.c.d`, 6 zero groups + 2 groups of IPv4): g0-g4 are zero in both, and
  // only g5 (0xffff vs 0) tells them apart. `new URL()` normalizes a bracketed `[::ffff:127.0.0.1]`
  // literal to `[::ffff:7f00:1]` - a bare first-hextet check never sees a recognizable private prefix
  // unless the embedded IPv4 in g6/g7 is actually decoded, which is exactly how the cloud metadata IP
  // slips through as `::ffff:169.254.169.254` if only `g0` is inspected.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (isPrivateIPv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff])) return true
  }
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true // fe80::/10 link-local
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true // fc00::/7 unique local
  return false
}

export function isUnsafeProbeHost(hostname: string): boolean {
  // A trailing dot is a valid FQDN root-label separator that new URL() preserves verbatim
  // ("localhost." stays "localhost."), so every check below must run against the dot-stripped form or
  // it silently misses "https://localhost./x", "https://metadata.google.internal./x", and the like.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host === 'metadata.google.internal' || host === '169.254.169.254') return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  const v4 = parseIPv4(host)
  if (v4) return isPrivateIPv4(v4)
  if (host.includes(':')) return isPrivateIPv6(host)
  return false
}

export interface SafeUrlCheck {
  ok: boolean
  url?: URL
  error?: { code: string; message: string }
}

export function safeProbeUrl(raw: string): SafeUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: { code: 'bad-url', message: 'That is not a valid URL.' } }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: { code: 'scheme', message: 'Only https is allowed for a connection test.' } }
  }
  if (isUnsafeProbeHost(url.hostname)) {
    return { ok: false, error: { code: 'blocked-host', message: 'This host cannot be reached from a connection test.' } }
  }
  return { ok: true, url }
}

// ── templating ───────────────────────────────────────────────────────────────────────────────────────

function buildVars(entry: ConnectorCatalogEntry, input: ProbeInput): Record<string, string> {
  const vars: Record<string, string> = { credential: input.credential }
  for (const field of entry.fields) {
    if (field.key === 'credential') continue
    const raw = input.config[field.key]
    vars[field.key] = typeof raw === 'string' && raw ? raw : field.default ?? ''
  }
  return vars
}

/** `{baseUrl}` is substituted verbatim since it is itself a URL fragment; every other placeholder is
 *  percent-encoded, since every other placeholder lands in a path segment, a query value, or (via the
 *  MCP endpoint's own `{baseUrl}`-only usage) nowhere at all in this function. */
function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name] ?? ''
    return name === 'baseUrl' ? value : encodeURIComponent(value)
  })
}

/** For contexts that are not URLs (HTTP Basic credentials, a JSON body value): no percent-encoding. */
function fillTemplateRaw(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
}

function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

/** Upstream error text never reaches storage or a UI verbatim: truncated first, then anything
 *  token-shaped is stripped by `redact.ts`'s own patterns, plus the two auth-header shapes this module
 *  itself ever sends back to a vendor (`Bearer <token>`, `Basic <base64>`) in case a vendor's error body
 *  echoes the request's own Authorization header. */
function redactUpstreamText(text: string): string {
  const truncated = text.slice(0, 200)
  if (looksLikeSecret(truncated)) return '[redacted]'
  return truncated.replace(/bearer\s+[a-z0-9._\-+/=]{8,}/gi, '[redacted]').replace(/basic\s+[a-z0-9+/=]{8,}/gi, '[redacted]')
}

// ── bounded fetch ────────────────────────────────────────────────────────────────────────────────────

/** Sentinel distinguishing "the awaited promise settled" from "the deadline passed first" without an
 *  extra boolean wrapper on every call site. */
const TIMED_OUT = Symbol('probe-deadline-exceeded')

/** Races `promise` against the time left until `deadlineAt` (never a fresh `PROBE_TIMEOUT_MS` window),
 *  so a chain of calls sharing one deadline (the MCP handshake's initialize/notify/tools-list sequence)
 *  cannot each buy themselves a brand new 10 seconds. A `remainingMs <= 0` resolves to `TIMED_OUT`
 *  immediately, no timer set. Never rejects: a promise rejection also resolves to `TIMED_OUT`, since
 *  every caller here only cares "did we get a value in time," and the underlying rejection reason (an
 *  abort, a network error) is already surfaced by the caller's own error handling. */
function withDeadline<T>(promise: Promise<T>, remainingMs: number): Promise<T | typeof TIMED_OUT> {
  if (remainingMs <= 0) return Promise.resolve(TIMED_OUT)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(TIMED_OUT)
      }
    }, remainingMs)
    promise.then(
      (value) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
      },
      () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(TIMED_OUT)
        }
      }
    )
  })
}

export interface FetchOutcome {
  res: Response | null
  timedOut: boolean
  networkError: boolean
}

/** `deadlineAt` is the one shared deadline for the whole probe attempt (`startedAt + PROBE_TIMEOUT_MS`,
 *  computed once by the caller), not a fresh `PROBE_TIMEOUT_MS` per call - see `withDeadline`. Exported
 *  (with `readCapped`, `PROBE_TIMEOUT_MS`) so any other outbound call the Worker makes to a connector's
 *  own infrastructure - `oauth.ts`'s token-endpoint exchange, task 6.10b/oauth - shares the exact same
 *  SSRF guard, timeout, and body cap this probe uses, rather than a second hand-rolled fetch wrapper. */
export async function boundedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, deadlineAt: number): Promise<FetchOutcome> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return { res: null, timedOut: true, networkError: false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remaining)
  try {
    const res = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal })
    return { res, timedOut: false, networkError: false }
  } catch (e) {
    if (controller.signal.aborted) return { res: null, timedOut: true, networkError: false }
    return { res: null, timedOut: false, networkError: true }
  } finally {
    clearTimeout(timer)
  }
}

export interface ReadOutcome {
  text: string
  timedOut: boolean
}

/**
 * Reads at most `PROBE_BODY_CAP_BYTES` of the body, stopping the stream rather than reading it fully and
 * discarding the rest - and, unlike a plain `await res.text()`/`reader.read()` loop, bounded by the same
 * shared `deadlineAt` `boundedFetch` used for the headers phase. `fetch()` resolving only means the
 * response headers arrived; a slow-drip body (one byte every N ms, never closing) can otherwise hold the
 * connection open indefinitely once the header-phase abort timer has already been cleared. Every
 * `reader.read()` call is individually raced against the remaining time via `withDeadline`, and the
 * reader is cancelled the moment the deadline passes so the underlying stream is told to stop, not just
 * abandoned. Falls back to a plain (still length- and deadline-capped) `.text()` for a fetch stand-in a
 * test supplies without a real `ReadableStream` body.
 */
export async function readCapped(res: Response, deadlineAt: number): Promise<ReadOutcome> {
  const body = res.body
  if (!body) return { text: '', timedOut: false }
  if (typeof body.getReader !== 'function') {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return { text: '', timedOut: true }
    const outcome = await withDeadline(res.text(), remaining)
    if (outcome === TIMED_OUT) return { text: '', timedOut: true }
    return { text: outcome.slice(0, PROBE_BODY_CAP_BYTES), timedOut: false }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timedOut = false
  try {
    for (;;) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      const outcome = await withDeadline(reader.read(), remaining)
      if (outcome === TIMED_OUT) {
        timedOut = true
        break
      }
      const { done, value } = outcome
      if (done) break
      if (value && value.byteLength) {
        const remainingBytes = PROBE_BODY_CAP_BYTES - total
        const slice = value.byteLength > remainingBytes ? value.slice(0, remainingBytes) : value
        chunks.push(slice)
        total += slice.byteLength
        if (value.byteLength > remainingBytes) break
      }
      if (total >= PROBE_BODY_CAP_BYTES) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* best effort - the stream may already be closed, or cancelling a timed-out read can itself reject */
    }
  }
  if (timedOut) return { text: '', timedOut: true }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(merged), timedOut: false }
}

const TIMEOUT_RESULT_MESSAGE = 'Timed out after 10 seconds.'

// ── REST probe ───────────────────────────────────────────────────────────────────────────────────────

function buildRestHeaders(entry: ConnectorCatalogEntry, input: ProbeInput, spec: RestProbeSpec): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...(spec.headers ?? {}) }
  if (entry.auth === 'bearer') {
    if (input.credential) headers.authorization = `Bearer ${input.credential}`
  } else if (entry.auth === 'api-key-header') {
    const headerName = input.config.headerName || entry.headerName || 'Authorization'
    if (input.credential) headers[headerName] = input.credential
  } else if (entry.auth === 'basic' && spec.basicAuth) {
    const vars = buildVars(entry, input)
    const user = fillTemplateRaw(spec.basicAuth.username, vars)
    const pass = fillTemplateRaw(spec.basicAuth.password, vars)
    headers.authorization = `Basic ${btoa(`${user}:${pass}`)}`
  }
  return headers
}

async function probeRest(entry: ConnectorCatalogEntry, spec: RestProbeSpec, input: ProbeInput, deps: ProbeDeps, startedAt: number): Promise<ProbeResult> {
  // One deadline for the whole attempt (headers + body), computed once - see `withDeadline`'s doc comment.
  const deadlineAt = startedAt + PROBE_TIMEOUT_MS
  const vars = buildVars(entry, input)
  const rawUrl = fillTemplate(spec.url, vars)
  const check = safeProbeUrl(rawUrl)
  if (!check.ok || !check.url) {
    return { ok: false, latencyMs: Date.now() - startedAt, summary: check.error!.message, error: check.error }
  }

  const headers = buildRestHeaders(entry, input, spec)
  let body: string | undefined
  if (spec.bodyTemplate) {
    const resolved: Record<string, string> = {}
    for (const [key, template] of Object.entries(spec.bodyTemplate)) resolved[key] = fillTemplateRaw(template, vars)
    body = JSON.stringify(resolved)
    headers['content-type'] = 'application/json'
  } else if (spec.body !== undefined) {
    body = JSON.stringify(spec.body)
    headers['content-type'] = 'application/json'
  }

  const { res, timedOut, networkError } = await boundedFetch(deps.fetch, check.url.toString(), { method: spec.method, headers, body }, deadlineAt)
  const latencyMs = Date.now() - startedAt
  if (timedOut) return { ok: false, latencyMs, summary: 'The connection attempt timed out.', error: { code: 'timeout', message: TIMEOUT_RESULT_MESSAGE } }
  if (networkError || !res) {
    return { ok: false, latencyMs, summary: 'The connection attempt failed.', error: { code: 'network', message: 'Network error reaching the provider.' } }
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, status: res.status, latencyMs, summary: 'The provider returned a redirect.', error: { code: 'redirect', message: 'Redirects are not followed.' } }
  }

  const bodyRead = await readCapped(res, deadlineAt)
  if (bodyRead.timedOut) {
    return {
      ok: false,
      status: res.status,
      latencyMs: Date.now() - startedAt,
      summary: 'The connection attempt timed out.',
      error: { code: 'timeout', message: TIMEOUT_RESULT_MESSAGE }
    }
  }
  const text = bodyRead.text
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* not JSON; parsed stays null */
  }

  const expected = spec.expectedStatus
  const statusOk = expected === undefined ? res.status >= 200 && res.status < 300 : res.status === expected
  if (!statusOk) {
    return {
      ok: false,
      status: res.status,
      latencyMs,
      summary: `The provider responded with status ${res.status}.`,
      error: { code: 'bad-status', message: redactUpstreamText(text) || `HTTP ${res.status}` }
    }
  }

  if (spec.successCheck) {
    const value = parsed && typeof parsed === 'object' ? getByPath(parsed, spec.successCheck.path) : undefined
    if (value !== spec.successCheck.equals) {
      const errorField = parsed && typeof parsed === 'object' ? getByPath(parsed, 'error') : undefined
      const message = typeof errorField === 'string' ? errorField : 'The provider rejected the credential.'
      return { ok: false, status: res.status, latencyMs, summary: 'The provider rejected the credential.', error: { code: 'rejected', message: redactUpstreamText(message) } }
    }
  }

  const summary = buildSummary(entry, spec, parsed, res.status)
  return { ok: true, status: res.status, latencyMs, summary }
}

function buildSummary(entry: ConnectorCatalogEntry, spec: RestProbeSpec, parsed: unknown, status: number): string {
  if (spec.summary && parsed && typeof parsed === 'object') {
    const value = getByPath(parsed, spec.summary.path)
    if (typeof value === 'string' && value) return spec.summary.template.replace('{value}', value)
    if (typeof value === 'number') return spec.summary.template.replace('{value}', String(value))
  }
  return `Reached ${entry.label}, status ${status}.`
}

// ── MCP probe (Streamable HTTP) ──────────────────────────────────────────────────────────────────────

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

function mcpAuthHeaders(input: ProbeInput): Record<string, string> {
  const headerName = input.config.headerName
  if (headerName && input.credential) return { [headerName]: input.credential }
  if (input.credential) return { authorization: `Bearer ${input.credential}` }
  return {}
}

interface McpCallResult {
  ok: boolean
  status?: number
  message?: JsonRpcMessage
  sessionId?: string
  error?: { code: string; message: string }
}

async function mcpCall(
  deps: ProbeDeps,
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  expectBody: boolean,
  deadlineAt: number
): Promise<McpCallResult> {
  const { res, timedOut, networkError } = await boundedFetch(
    deps.fetch,
    url,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(payload)
    },
    deadlineAt
  )
  if (timedOut) return { ok: false, error: { code: 'timeout', message: TIMEOUT_RESULT_MESSAGE } }
  if (networkError || !res) return { ok: false, error: { code: 'network', message: 'Network error reaching the server.' } }
  if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: { code: 'redirect', message: 'Redirects are not followed.' } }
  const sessionId = res.headers.get('mcp-session-id') || undefined
  if (!expectBody) return { ok: res.status < 300, status: res.status, sessionId }
  if (res.status >= 400) {
    const bodyRead = await readCapped(res, deadlineAt)
    if (bodyRead.timedOut) return { ok: false, status: res.status, sessionId, error: { code: 'timeout', message: TIMEOUT_RESULT_MESSAGE } }
    return { ok: false, status: res.status, sessionId, error: { code: 'bad-status', message: redactUpstreamText(bodyRead.text) || `HTTP ${res.status}` } }
  }
  const bodyRead = await readCapped(res, deadlineAt)
  if (bodyRead.timedOut) return { ok: false, status: res.status, sessionId, error: { code: 'timeout', message: TIMEOUT_RESULT_MESSAGE } }
  const messages = parseMcpBody(bodyRead.text, res.headers.get('content-type'))
  const message = messages.find((m) => m.id === payload.id) ?? messages[0]
  if (!message) return { ok: false, status: res.status, sessionId, error: { code: 'bad-body', message: 'The server did not return a usable response.' } }
  if (message.error) return { ok: false, status: res.status, sessionId, error: { code: 'rpc-error', message: redactUpstreamText(message.error.message || 'The server rejected the request.') } }
  return { ok: true, status: res.status, sessionId, message }
}

function toolWriteHeuristic(name: string, annotations: Record<string, unknown> | undefined): boolean {
  if (annotations) {
    if (annotations.readOnlyHint === false) return true
    if (annotations.destructiveHint === true) return true
  }
  return WRITE_NAME_RE.test(name)
}

async function probeMcp(entry: ConnectorCatalogEntry, input: ProbeInput, deps: ProbeDeps, startedAt: number): Promise<ProbeResult> {
  // One deadline for the entire handshake (both protocol-version attempts, the notification, and
  // tools/list) - a fresh 10 s per call would let the sequence take up to 40 s in the worst case.
  const deadlineAt = startedAt + PROBE_TIMEOUT_MS
  const endpointRaw = entry.endpoint ?? input.config.baseUrl ?? ''
  const check = safeProbeUrl(endpointRaw)
  if (!check.ok || !check.url) {
    return { ok: false, latencyMs: Date.now() - startedAt, summary: check.error!.message, error: check.error }
  }
  const url = check.url.toString()
  const authHeaders = mcpAuthHeaders(input)

  const initPayload = (protocolVersion: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'metis-operator', version: '1.0.0' }
    }
  })

  let init = await mcpCall(deps, url, authHeaders, initPayload(MCP_PROTOCOL_VERSION), true, deadlineAt)
  if (!init.ok) {
    init = await mcpCall(deps, url, authHeaders, initPayload(MCP_PROTOCOL_VERSION_FALLBACK), true, deadlineAt)
  }
  const latencyMs = Date.now() - startedAt
  if (!init.ok) {
    return { ok: false, status: init.status, latencyMs, summary: 'Could not complete the MCP handshake.', error: init.error }
  }

  const sessionHeaders = init.sessionId ? { ...authHeaders, 'mcp-session-id': init.sessionId } : authHeaders

  await mcpCall(deps, url, sessionHeaders, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false, deadlineAt)

  const listed = await mcpCall(deps, url, sessionHeaders, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, true, deadlineAt)
  if (!listed.ok) {
    return { ok: false, status: listed.status ?? init.status, latencyMs, summary: 'Reached the server but could not list its tools.', error: listed.error }
  }

  const rawTools = Array.isArray(listed.message?.result?.tools) ? (listed.message!.result!.tools as Record<string, unknown>[]) : []
  const tools: ProbeToolInfo[] = rawTools
    .filter((t) => typeof t.name === 'string')
    .map((t) => ({
      name: t.name as string,
      description: typeof t.description === 'string' ? t.description : undefined,
      write: toolWriteHeuristic(t.name as string, t.annotations as Record<string, unknown> | undefined)
    }))

  return {
    ok: true,
    status: listed.status,
    latencyMs,
    summary: `Reached ${entry.label}, ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`,
    tools
  }
}

/**
 * Last line of defence, applied to every field of every result regardless of which branch above built
 * it: a literal, exact-substring scrub of the real credential value. `redactUpstreamText` above (truncate
 * + `redact.ts` pattern match) only catches text that *looks* like a secret; a vendor's own token format
 * (HubSpot's `pat-...`, a Trello token, ...) does not always match those generic patterns, but an upstream
 * error that echoes the credential back verbatim (a 401 body quoting "bad token <token>") still must never
 * reach `summary`, `error.message`, or a tool's `name`/`description`. Also scrubs
 * `encodeURIComponent(credential)`: a query-param-auth vendor (Trello) or a Basic/query credential
 * containing characters like `+`, `/`, `=`, or a space can come back percent-encoded in an echoed URL or
 * form-encoded error body, which the raw substring scrub below would miss. */
function scrubCredential(result: ProbeResult, credential: string): ProbeResult {
  if (!credential) return result
  const encoded = encodeURIComponent(credential)
  const scrub = (s: string): string => {
    const raw = s.split(credential).join('[redacted]')
    return encoded !== credential ? raw.split(encoded).join('[redacted]') : raw
  }
  return {
    ...result,
    summary: scrub(result.summary),
    error: result.error ? { ...result.error, message: scrub(result.error.message) } : undefined,
    tools: result.tools?.map((t) => ({ ...t, name: scrub(t.name), description: t.description !== undefined ? scrub(t.description) : undefined }))
  }
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────────

export async function probeConnection(entry: ConnectorCatalogEntry, input: ProbeInput, deps: ProbeDeps): Promise<ProbeResult> {
  const startedAt = Date.now()
  if (!entry.probe) {
    return {
      ok: false,
      latencyMs: 0,
      summary: 'No probe available for this kind yet.',
      error: { code: 'no-probe', message: 'No probe available for this kind yet.' }
    }
  }
  const result = entry.probe.kind === 'mcp' ? await probeMcp(entry, input, deps, startedAt) : await probeRest(entry, entry.probe, input, deps, startedAt)
  return scrubCredential(result, input.credential)
}
