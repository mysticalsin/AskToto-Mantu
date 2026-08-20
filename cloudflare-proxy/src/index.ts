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
  /** What Métis presents as its API key. `wrangler secret put METIS_PROXY_KEY`. */
  METIS_PROXY_KEY: string
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
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

function isConfigured(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN && env.CF_ACCOUNT_ID && env.METIS_PROXY_KEY)
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
    // every correct key as invalid — and, more importantly, so an unset METIS_PROXY_KEY can never be
    // matched by an empty presented key.
    if (!isConfigured(env)) {
      return configErrorResponse(
        503,
        'This proxy is not configured. The operator must set CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID and METIS_PROXY_KEY.'
      )
    }

    // The gate that stops this being an open relay. Without it, anyone who learns the URL spends the
    // operator's Cloudflare balance, and AI Gateway's rate limits would be the only thing standing
    // between a scraped hostname and the bill.
    const presented = presentedKey(request)
    if (!presented || !(await secretsMatch(presented, env.METIS_PROXY_KEY))) {
      return errorResponse(401, 'Invalid proxy key.')
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

    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: await request.text()
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
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    })
  }
}
