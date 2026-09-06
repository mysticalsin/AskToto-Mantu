/**
 * metis-cloudflare-proxy — the Worker that lets Métis reach Cloudflare's AI REST API without the
 * desktop app ever holding a Cloudflare account token.
 *
 * Why this exists at all. Métis is a packaged Electron app: `npx asar extract` recovers every string
 * it ships, so any embedded credential is a published credential. This repo already refuses to build
 * with an embedded key (scripts/check-cahe-package.mjs), and a Cloudflare account token is a worse
 * thing to embed than a per-vendor model key — it reaches Workers AI, every third-party model behind
 * Unified Billing, and whatever else the token's scopes allow, all billed to the operator.
 *
 * So the token lives here instead, as a Wrangler secret on infrastructure the operator controls, and
 * Métis authenticates to THIS Worker with a key that is worthless anywhere else and can be rotated
 * without touching the Cloudflare account.
 *
 * This file is a forwarding shim and nothing more. Two routes, one upstream, no state, no framework,
 * no dependencies. Everything below that is longer than a line is either a security boundary or a
 * streaming requirement.
 */

export interface Env {
  /** Cloudflare API token allowed to run AI models. `wrangler secret put CLOUDFLARE_API_TOKEN`. */
  CLOUDFLARE_API_TOKEN: string
  /** The account the models are billed to. `wrangler secret put CF_ACCOUNT_ID`. */
  CF_ACCOUNT_ID: string
  /**
   * What Métis presents as its API key, single-org mode. `wrangler secret put METIS_PROXY_KEY`.
   * At least one of this and METIS_PROXY_KEYS must be set; both may be set at once (the keys union).
   */
  METIS_PROXY_KEY?: string
  /**
   * Per-user keys, for revoking one caller without rotating everyone else's. `wrangler secret put
   * METIS_PROXY_KEYS` with a JSON array of strings, each either a bare key or "label:key" — everything
   * before the first ':' is a free-form label for the operator's own bookkeeping (e.g. a username) and
   * plays no part in matching; only the text after it (or the whole entry, if there is no ':') is
   * compared against the bearer token. Example: `["tony:9f2c…","dana:71ab…"]`. See README § Per-user keys.
   */
  METIS_PROXY_KEYS?: string
  /**
   * Optional plain var (NOT a secret): pin one AI Gateway instead of the account default. Set it in
   * wrangler.jsonc `vars` when the operator wants this proxy's traffic isolated behind a gateway with
   * its own caching / rate-limit / guardrail rules.
   */
  CF_AI_GATEWAY_ID?: string
}

/** The one route Métis calls. OpenAI-shaped, so an openai-kind client works against it unchanged. */
const CHAT_ROUTE = '/v1/chat/completions'
const HEALTH_ROUTE = '/health'

/**
 * Largest chat body this proxy will buffer. Métis asks are far smaller; anything past this is not a
 * seat talking — refuse before `request.text()` so a forged Content-Length or chunked flood cannot
 * pin the isolate. Same fail-loud 413 shape as operator/src/index.ts.
 */
export const MAX_BODY_BYTES = 512_000

const encoder = new TextEncoder()

/**
 * Constant-time secret comparison.
 *
 * The Workers runtime ships `crypto.subtle.timingSafeEqual`, and Cloudflare's own auth examples use
 * it — but Node does not have it, and index.test.ts (this file's only proof that runs without a
 * deploy) executes in Node. Using the Workers-only primitive would make the authentication check the
 * single piece of logic here that cannot be verified before it is live, which is exactly backwards.
 *
 * SHA-256 first, then compare digests: the two buffers are 32 bytes by construction, so there is no
 * length to leak and no early return to time. One implementation, both runtimes, no dependency.
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ])
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

/** The bearer token the CALLER presented, or '' when the header is missing or malformed. */
function presentedKey(request: Request): string {
  const match = /^Bearer\s+(\S.*)$/i.exec((request.headers.get('authorization') ?? '').trim())
  return match ? match[1].trim() : ''
}

const HSTS = 'max-age=31536000; includeSubDomains'

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'strict-transport-security': HSTS,
    'referrer-policy': 'no-referrer',
    ...extra
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
  })
}

/** OpenAI-shaped error body, so the client surfaces the message instead of an opaque status. */
function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: { message, type: 'metis_proxy_error' } })
}

/**
 * Marker for failures ONLY THE OPERATOR can fix — a dead account token, a half-deployed Worker.
 *
 * It lives in the message text, not just `type`, because that is the only field that survives the trip:
 * the OpenAI SDK folds an error into `${status} ${message}` and Métis's adapter passes just `e.message`
 * on, dropping `.status` and `.type`. Without a marker in the text, these land in Métis as a bare 502,
 * match its transient-retry pattern, and get rewritten to "Connection issue — check your network" —
 * pointing every user in the org at their wifi while the real cause is a secret in this Worker.
 *
 * Deliberately NOT stamped on transient upstream failures (a 5xx blip, a fetch error). Those SHOULD be
 * treated as transient and retried; marking them would let a 30-second outage read as a misconfiguration.
 */
const OPERATOR_FAULT = '[metis-proxy-config]'

/** An error the operator, and only the operator, can clear. */
function configErrorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: { message: `${OPERATOR_FAULT} ${message}`, type: 'metis_proxy_config_error' } })
}

/**
 * Parses METIS_PROXY_KEYS into the literal key material to compare against.
 *
 * Format: a JSON array of strings, each either a bare key or "label:key" (see the Env doc comment for
 * the label rule). `null` means the secret is set but does not parse as that shape — malformed JSON, a
 * non-array, or an entry that is not a non-empty string. That is distinct from "no entries" and must be
 * treated as a configuration error, never as "fall back to single-key mode": a typo in this secret must
 * fail closed, not silently widen to whatever METIS_PROXY_KEY happens to be.
 */
function parseProxyKeys(raw: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const keys: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') return null
    const colon = entry.indexOf(':')
    const key = colon === -1 ? entry : entry.slice(colon + 1)
    if (!key) return null
    keys.push(key)
  }
  return keys
}

/**
 * Every configured proxy key, from either secret, as one flat list to match the presented bearer
 * against. `null` propagates a malformed METIS_PROXY_KEYS so the caller fails closed instead of quietly
 * running in single-key (or no-key) mode.
 */
function configuredKeys(env: Env): string[] | null {
  const keys: string[] = []
  if (env.METIS_PROXY_KEY) keys.push(env.METIS_PROXY_KEY)
  if (env.METIS_PROXY_KEYS) {
    const parsed = parseProxyKeys(env.METIS_PROXY_KEYS)
    if (parsed === null) return null
    keys.push(...parsed)
  }
  return keys
}

/** True when `presented` constant-time-matches ANY configured key. Never short-circuits on the first
 * match, so response timing cannot leak which key — or how many — it was. */
async function matchesAnyKey(presented: string, keys: string[]): Promise<boolean> {
  const results = await Promise.all(keys.map((key) => secretsMatch(presented, key)))
  return results.some(Boolean)
}

function isConfigured(env: Env): boolean {
  const keys = configuredKeys(env)
  return Boolean(env.CLOUDFLARE_API_TOKEN && env.CF_ACCOUNT_ID && keys && keys.length > 0)
}

/** Best-effort durable window. Memory is the floor inside one isolate. `caches.default` (Cache API)
 *  is the colo-local store so a new isolate still sees a recent count. AI Gateway remains the
 *  operator's fleet-wide cap when they configured one. */
export const PROXY_RL_WINDOW_MS = 60_000
export const PROXY_RL_AUTH_MAX = 60
export const PROXY_RL_UNAUTH_MAX = 30

type RateBucket = { start: number; count: number }
const rateBuckets = new Map<string, RateBucket>()

export type ProxyRateCache = {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

let injectedRateCache: ProxyRateCache | null = null

/** Test seam. Production never calls this. */
export function setProxyRateLimitCache(cache: ProxyRateCache | null): void {
  injectedRateCache = cache
}

/** Test seam. Production never calls this. */
export function resetProxyRateLimits(): void {
  rateBuckets.clear()
}

const RL_CACHE_ORIGIN = 'https://metis-proxy-rl.internal'

function resolveRateCache(): ProxyRateCache | undefined {
  if (injectedRateCache) return injectedRateCache
  const cachesObj = (globalThis as { caches?: { default?: ProxyRateCache } }).caches
  return cachesObj?.default
}

function rateCacheRequest(id: string): Request {
  return new Request(`${RL_CACHE_ORIGIN}/${encodeURIComponent(id)}`)
}

async function readCachedBucket(cache: ProxyRateCache, id: string, now: number): Promise<RateBucket | null> {
  try {
    const hit = await cache.match(rateCacheRequest(id))
    if (!hit) return null
    const parsed = (await hit.json()) as { start?: unknown; count?: unknown }
    if (typeof parsed.start !== 'number' || typeof parsed.count !== 'number') return null
    if (now - parsed.start >= PROXY_RL_WINDOW_MS) return null
    return { start: parsed.start, count: parsed.count }
  } catch {
    return null
  }
}

async function writeCachedBucket(cache: ProxyRateCache, id: string, bucket: RateBucket): Promise<void> {
  try {
    await cache.put(
      rateCacheRequest(id),
      new Response(JSON.stringify(bucket), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${Math.ceil(PROXY_RL_WINDOW_MS / 1000)}`
        }
      })
    )
  } catch {
    /* memory still holds this isolate's count */
  }
}

async function consumeRateBucket(id: string, max: number, now = Date.now()): Promise<boolean> {
  const cache = resolveRateCache()
  const cached = cache ? await readCachedBucket(cache, id, now) : null
  const memory = rateBuckets.get(id)
  const memoryFresh = memory && now - memory.start < PROXY_RL_WINDOW_MS ? memory : null
  const existing = cached && memoryFresh
    ? { start: Math.min(cached.start, memoryFresh.start), count: Math.max(cached.count, memoryFresh.count) }
    : cached || memoryFresh

  if (!existing) {
    const next = { start: now, count: 1 }
    rateBuckets.set(id, next)
    if (rateBuckets.size > 10_000) {
      for (const [key, bucket] of rateBuckets) {
        if (now - bucket.start >= PROXY_RL_WINDOW_MS) rateBuckets.delete(key)
      }
    }
    if (cache) await writeCachedBucket(cache, id, next)
    return true
  }
  if (existing.count >= max) {
    rateBuckets.set(id, existing)
    return false
  }
  const next = { start: existing.start, count: existing.count + 1 }
  rateBuckets.set(id, next)
  if (cache) await writeCachedBucket(cache, id, next)
  return true
}

function callerIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

async function rateLimitIdForKey(presented: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(presented)))
  let hex = ''
  for (let i = 0; i < 8; i++) hex += digest[i]!.toString(16).padStart(2, '0')
  return `auth:${hex}`
}

function rateLimitedResponse(): Response {
  return errorResponse(429, 'Rate limited. Try again shortly.')
}

/**
 * Upstream failures are RE-STATED, never relayed.
 *
 * A Cloudflare error body can quote the request it rejected, headers included, so piping it back to
 * the caller is a live path for the account token to leave this Worker. Nothing upstream sends is
 * copied out; only a status this side chose and a sentence this file wrote.
 *
 * The status is picked for what the caller can actually act on:
 *   401 / 403 — the OPERATOR's account token is wrong, expired or under-scoped. The caller's own key
 *               was already accepted, so answering 401 would send Métis off to re-prompt the user for
 *               a proxy key that is perfectly fine. 502: the failure is behind us, not in front.
 *   429       — preserved. Métis backs off and fails over to another provider on this exact status.
 *   other 4xx — preserved (402 out of credit, 404 unknown model, 400 malformed body). These describe
 *               the caller's own request, and collapsing them to 502 would hide a fixable mistake.
 *   5xx       — 502. Cloudflare is broken, not the caller.
 */
function mapUpstreamFailure(status: number): Response {
  if (status === 401 || status === 403) {
    return configErrorResponse(
      502,
      'Cloudflare rejected this proxy account credential. The operator needs to check CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID.'
    )
  }
  if (status >= 500) return errorResponse(502, `Cloudflare AI is unavailable (upstream status ${status}).`)
  return errorResponse(status, `Cloudflare AI rejected the request (upstream status ${status}).`)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname === HEALTH_ROUTE) {
      if (request.method !== 'GET') return errorResponse(405, 'Use GET for /health.')
      // Unauthenticated on purpose: it is the operator's "did the deploy land" check, and it answers
      // whether the three secrets are PRESENT — never what they are, and never the account id.
      return jsonResponse(200, {
        ok: true,
        service: 'metis-cloudflare-proxy',
        configured: isConfigured(env)
      })
    }

    if (pathname !== CHAT_ROUTE) {
      return errorResponse(404, 'Not found. This proxy serves POST /v1/chat/completions and GET /health.')
    }
    if (request.method !== 'POST') return errorResponse(405, 'Use POST for /v1/chat/completions.')

    // Checked before the key compare so a half-deployed Worker says so plainly instead of rejecting
    // every correct key as invalid — and, more importantly, so an unset key set can never be matched by
    // an empty presented key. A malformed METIS_PROXY_KEYS is its own case: it must fail exactly the
    // same closed way, never silently drop back to whatever METIS_PROXY_KEY happens to hold.
    const keys = configuredKeys(env)
    if (keys === null) {
      return configErrorResponse(
        500,
        'METIS_PROXY_KEYS is set but is not valid JSON (expected an array of key strings). The operator must fix or unset it.'
      )
    }
    if (!env.CLOUDFLARE_API_TOKEN || !env.CF_ACCOUNT_ID || keys.length === 0) {
      return configErrorResponse(
        503,
        'This proxy is not configured. The operator must set CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID and at least one of METIS_PROXY_KEY / METIS_PROXY_KEYS.'
      )
    }

    // The gate that stops this being an open relay. Without it, anyone who learns the URL spends the
    // operator's Cloudflare balance, and AI Gateway's rate limits would be the only thing standing
    // between a scraped hostname and the bill.
    const presented = presentedKey(request)
    if (!presented || !(await matchesAnyKey(presented, keys))) {
      if (!(await consumeRateBucket(`unauth:${callerIp(request)}`, PROXY_RL_UNAUTH_MAX))) {
        return rateLimitedResponse()
      }
      return errorResponse(401, 'Invalid proxy key.')
    }

    if (!(await consumeRateBucket(await rateLimitIdForKey(presented), PROXY_RL_AUTH_MAX))) {
      return rateLimitedResponse()
    }

    const upstreamUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      env.CF_ACCOUNT_ID
    )}/ai/v1/chat/completions`

    // Built fresh rather than copied from the incoming request: the caller's Authorization header must
    // not travel upstream, and nothing the caller sends can be smuggled into the account's request.
    const upstreamHeaders = new Headers({
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json'
    })
    // Gateway selection is the OPERATOR's, not the caller's: honouring a client-supplied
    // cf-aig-gateway-id would let a caller pick a gateway without the rate limits or guardrails this
    // proxy is deployed behind. Unset = the account's default gateway, which still logs and meters.
    const gatewayId = env.CF_AI_GATEWAY_ID?.trim()
    if (gatewayId) upstreamHeaders.set('cf-aig-gateway-id', gatewayId)

    // Refuse oversized bodies before reading them, and again after (chunked uploads carry no
    // content-length), so the isolate never buffers an unbounded string on the operator's bill.
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return errorResponse(413, 'Request body too large.')
    }
    const bodyText = await request.text()
    if (bodyText.length > MAX_BODY_BYTES) {
      return errorResponse(413, 'Request body too large.')
    }

    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: bodyText
      })
    } catch {
      // The thrown error is deliberately not read: a fetch failure can stringify the request it was
      // making, and that request carries the account token in a header.
      return errorResponse(502, 'Could not reach Cloudflare AI.')
    }

    if (!upstream.ok) return mapUpstreamFailure(upstream.status)

    // Stream through, do not buffer. Métis renders answers token by token, so `await upstream.text()`
    // here would turn every reply into one long pause followed by a wall of text. `upstream.body` is
    // handed to the client Response untouched — SSE frame for SSE frame when the request set
    // "stream": true, a single JSON body when it did not.
    //
    // Response headers are synthesised, not forwarded, for the same reason the request headers were:
    // whatever Cloudflare attaches (gateway ids, ray ids, cookies) stays on this side of the Worker.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: securityHeaders({
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
    })
  }
}
