/**
 * Shared contract and outbound-fetch plumbing for every adapter in this directory (plan section 7 task
 * B3). Not one of the eight files the task brief names individually - added inside the `adapters/`
 * directory this task owns exclusively (nothing existed here before this task, and nothing outside this
 * task ever imports from it), specifically to avoid seven copies of the same SSRF guard and bounded-fetch
 * logic. `gateway.ts` and every adapter import types from here; adapters never import from `gateway.ts`
 * itself, so the dependency graph stays one-directional (`gateway.ts` -> `adapters/*.ts` -> this file,
 * never back) with nothing to worry about at module-evaluation time.
 *
 * ## SSRF guard (security carry-over, plan section 10)
 *
 * `safeGatewayUrl` below is a deliberate, standalone copy of `connectors/probe.ts`'s `safeProbeUrl`
 * hostname checks (https only; not an IP literal in loopback/link-local/private ranges; not localhost,
 * `*.internal`, `*.local`, the cloud metadata host/address; redirects never followed) - not imported,
 * because `probe.ts` belongs to task B2's owner and this task owns its own copy of the same logic, kept
 * in sync by the "same as probe.ts" requirement in this task's brief rather than a cross-task import.
 *
 * `resolveThenValidate` is the addition this task's trust boundary needs that `probe.ts` does not:
 * `probe.ts` only ever runs from an admin's own "Test connection" click (an already-trusted, one-off,
 * admin-initiated action taken once at Save time). This gateway runs on every entitled seat's every tool
 * call, unattended, indefinitely, against a `baseUrl` an admin approved once and may never look at again.
 * A DNS record can change after Save; `resolveThenValidate` re-resolves the hostname to its current
 * addresses on every single call and refuses if any of them is private, loopback, or link-local, closing
 * the window down from "forever after Save" to "between this lookup and the fetch a few lines later".
 *
 * ### What Cloudflare Workers can and cannot pin (plan D10, documented rather than guessed)
 *
 * Workers' `fetch()` accepts a `cf.resolveOverride` option, but per Cloudflare's own Request docs it only
 * takes effect when BOTH the request's URL host and the override host are within a zone on this Cloudflare
 * account - it exists to route a Worker's own request to another resource on the same account (their
 * documented example is Orange-to-Orange routing), not to pin DNS resolution for an arbitrary third-party
 * origin such as `api.hubapi.com` or a customer's self-hosted Plane server. It is not usable here, and this
 * module does not attempt it. Workers exposes no lower-level socket API or custom-resolver hook a Worker
 * script can call into (unlike, say, Node's `http.Agent` with a custom `createConnection`). The practical
 * result: this module's own DNS-over-HTTPS lookup and the real `fetch()` call a few lines after it are two
 * independent DNS resolutions, and nothing in the Workers runtime lets this code force them to agree on the
 * same address. A live DNS-rebinding attacker who flips the record between those two resolutions, timed to
 * the millisecond, is not fully closed by this (or by `probe.ts`). What IS closed: the overwhelmingly
 * common real case of a static record pointing at an internal address - true both times this checks it -
 * and even the timing attack now needs the attacker to win a race that did not exist at all before this.
 */
// ── adapter contract ─────────────────────────────────────────────────────────────────────────────────

export interface AdapterToolSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>
  required?: string[]
}

export interface AdapterTool {
  name: string
  description: string
  /** True for a tool that creates, updates or deletes something upstream. Refused by `gateway.ts`
   *  unless the connection row has `allow_writes = 1`, checked before this tool's handler ever runs. */
  write: boolean
  inputSchema: AdapterToolSchema
}

/** Everything a tool handler needs to make one authenticated call: the decrypted credential, the
 *  connection's other config fields (subdomain, workspace, headerName, baseUrl, ...), a bounded fetch
 *  budget, and the fetch implementation to use (real `fetch` in production, a fake in tests). */
export interface AdapterCallContext {
  credential: string
  config: Record<string, string>
  headerName?: string | null
  fetchImpl: typeof fetch
  /** Absolute deadline (`Date.now()`-comparable ms) for this one tool call, shared by every fetch the
   *  handler makes so a chain of calls cannot each buy a fresh timeout window. */
  deadlineAt: number
}

export interface AdapterCallOutcome {
  /** MCP tool-result shape: `{ content, isError }`. A vendor-side failure (bad request, not found, rate
   *  limited, SSRF-blocked, timed out) is `isError: true` with a human-readable `content`, never a thrown
   *  exception - `gateway.ts` still records it as one `mcp_calls` row with a failing `outcome`. */
  content: { type: 'text'; text: string }[]
  isError: boolean
}

export interface AdapterModule {
  /** Read tools first, write tools after - `gateway.ts`'s `tools/list` returns this array as-is. */
  tools: AdapterTool[]
  callTool(name: string, args: Record<string, unknown>, ctx: AdapterCallContext): Promise<AdapterCallOutcome>
}

export function textResult(text: string, isError = false): AdapterCallOutcome {
  return { content: [{ type: 'text', text }], isError }
}

export function jsonResult(data: unknown): AdapterCallOutcome {
  return textResult(JSON.stringify(data, null, 2))
}

// ── SSRF guard (copy of probe.ts's, see module doc) ─────────────────────────────────────────────────

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null
}

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 0) return true
  return false
}

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
  if (groups.every((g) => g === 0)) return true
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (isPrivateIPv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff])) return true
  }
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true
  return false
}

/** Checks a literal hostname or IP string against the same private/loopback/link-local/metadata rules
 *  `probe.ts#isUnsafeProbeHost` applies; also used on every address `resolveThenValidate` resolves to. */
export function isUnsafeGatewayHost(hostname: string): boolean {
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

export function safeGatewayUrl(raw: string): SafeUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: { code: 'bad-url', message: 'Not a valid URL.' } }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: { code: 'scheme', message: 'Only https is allowed.' } }
  }
  if (isUnsafeGatewayHost(url.hostname)) {
    return { ok: false, error: { code: 'blocked-host', message: 'This host cannot be reached from the gateway.' } }
  }
  return { ok: true, url }
}

// ── resolve-then-validate (the addition over probe.ts, see module doc) ─────────────────────────────

interface DohAnswer {
  type: number
  data: string
}
interface DohResponse {
  Status: number
  Answer?: DohAnswer[]
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
const DOH_TIMEOUT_MS = 4000

async function dohLookup(fetchImpl: typeof fetch, host: string, type: 'A' | 'AAAA', deadlineAt: number): Promise<string[]> {
  const remaining = Math.min(DOH_TIMEOUT_MS, deadlineAt - Date.now())
  if (remaining <= 0) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remaining)
  try {
    const res = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: controller.signal
    })
    if (!res.ok) return []
    const body = (await res.json()) as DohResponse
    if (body.Status !== 0 || !Array.isArray(body.Answer)) return []
    const wantType = type === 'A' ? 1 : 28
    return body.Answer.filter((a) => a.type === wantType).map((a) => a.data)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export interface ResolveCheck {
  ok: boolean
  error?: { code: string; message: string }
}

/** Re-resolves `url.hostname` and refuses if it is now (or is already, for a literal IP) a private,
 *  loopback, or link-local address. Fails closed: a DNS lookup that itself times out or errors is treated
 *  as unsafe, never as "skip the check" - the whole point of this function is that an unattended,
 *  repeated gateway call must never proceed on an unverified host. See the module doc for what this can
 *  and cannot guarantee about the `fetch()` call made after it. */
export async function resolveThenValidate(fetchImpl: typeof fetch, url: URL, deadlineAt: number): Promise<ResolveCheck> {
  const host = url.hostname
  if (isUnsafeGatewayHost(host)) {
    return { ok: false, error: { code: 'blocked-host', message: 'This host cannot be reached from the gateway.' } }
  }
  // A literal IP has no DNS to re-resolve; the hostname check above already covers it.
  if (parseIPv4(host) || (host.includes(':') && expandIPv6(host.replace(/^\[|\]$/g, '')))) {
    return { ok: true }
  }
  const [a, aaaa] = await Promise.all([
    dohLookup(fetchImpl, host, 'A', deadlineAt),
    dohLookup(fetchImpl, host, 'AAAA', deadlineAt)
  ])
  const addresses = [...a, ...aaaa]
  if (!addresses.length) {
    return { ok: false, error: { code: 'dns-unresolved', message: 'Could not resolve this host.' } }
  }
  if (addresses.some((addr) => isUnsafeGatewayHost(addr))) {
    return { ok: false, error: { code: 'dns-private', message: 'This host resolves to a private address.' } }
  }
  return { ok: true }
}

/** Runs both checks in sequence, the shape every adapter and `proxy.ts` actually wants: build the URL
 *  from catalog/config fields, then get back either a validated `URL` or the first error to report. */
export async function safeResolvedUrl(fetchImpl: typeof fetch, raw: string, deadlineAt: number): Promise<SafeUrlCheck> {
  const literal = safeGatewayUrl(raw)
  if (!literal.ok || !literal.url) return literal
  const resolved = await resolveThenValidate(fetchImpl, literal.url, deadlineAt)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  return literal
}

// ── bounded fetch ────────────────────────────────────────────────────────────────────────────────────

const RESPONSE_CAP_BYTES = 256 * 1024

export interface BoundedFetchResult {
  ok: boolean
  status?: number
  text: string
  timedOut: boolean
  networkError: boolean
}

/** One HTTP call, `redirect: 'manual'` (a 3xx is always reported, never followed), bounded by the shared
 *  `deadlineAt`, response text capped at `RESPONSE_CAP_BYTES`. Adapter API responses are small JSON
 *  documents (a page of tickets, a contact record); a post-read slice is sufficient here, unlike
 *  `probe.ts`'s streamed cap, which exists for an admin-supplied `custom-rest` target of unknown shape. */
export async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  deadlineAt: number
): Promise<BoundedFetchResult> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return { ok: false, text: '', timedOut: true, networkError: false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remaining)
  try {
    const res = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal })
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, text: '', timedOut: false, networkError: false }
    }
    const text = (await res.text()).slice(0, RESPONSE_CAP_BYTES)
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text, timedOut: false, networkError: false }
  } catch {
    if (controller.signal.aborted) return { ok: false, text: '', timedOut: true, networkError: false }
    return { ok: false, text: '', timedOut: false, networkError: true }
  } finally {
    clearTimeout(timer)
  }
}

export function parseJsonSafe(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** Standard `Authorization`/header-shape auth builder shared by every REST adapter, given the same
 *  `auth` kinds `catalog.ts` already defines. Basic auth is built by the caller (needs a second field,
 *  e.g. Jira's account email) since there is no one shared shape for it across adapters. */
export function bearerOrHeaderAuth(ctx: AdapterCallContext, opts: { bearer?: boolean; headerNameDefault?: string } = {}): Record<string, string> {
  if (opts.bearer) return { authorization: `Bearer ${ctx.credential}` }
  const headerName = ctx.headerName || opts.headerNameDefault || 'authorization'
  return { [headerName.toLowerCase()]: ctx.credential }
}
