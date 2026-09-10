import { session as electronSession } from 'electron'
import { auditLog, mainLog } from '../logger'
import { hostAllowed, requestHostname } from './egress-policy'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'cookie2'] as const
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'] as const

/**
 * Enforce the managed `egressAllowlist` (see egress-policy.ts) in the main process. Two hooks, because
 * Métis has two network stacks:
 *
 *   1. Node `fetch` (undici): every provider client, Graph, the license server, Operator, npm, WorkOS.
 *      Wrapped at `globalThis.fetch` rather than at the undici dispatcher, because install-proxy.ts swaps
 *      the global dispatcher (sometimes late, after a slow PAC resolves) and a dispatcher-level guard
 *      would be silently dropped by that swap.
 *   2. Chromium (`net.fetch`, the renderer, the Intelligence window): `webRequest.onBeforeRequest` on the
 *      default session, which is what those paths use.
 *
 * A blocked request fails the way a dead network fails (TypeError from fetch, ERR_BLOCKED_BY_CLIENT in
 * Chromium), so every caller's existing offline handling applies and the user sees an honest error, not a
 * hang. Each blocked host is audited once per session ('net.egress.blocked', hostname only) so a fleet
 * admin can see what a policy is stopping without the log filling up.
 *
 * Not covered, and documented in docs/NETWORK-EGRESS.md: libraries that open raw `https.request` sockets
 * (MSAL's token client) and child processes (the CLI providers, ffmpeg). Loopback is always allowed.
 */

export interface WebRequestLike {
  onBeforeRequest(
    filter: { urls: string[] },
    listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void
  ): void
}

export interface EgressGuardDeps {
  /** The fetch to wrap. Default: the current globalThis.fetch. */
  baseFetch?: typeof fetch
  /** Where the wrapped fetch is installed. Default: globalThis.fetch. */
  setGlobalFetch?: (f: typeof fetch) => void
  /** Chromium hook. Default: the Electron default session; null = no Chromium hook. */
  webRequest?: WebRequestLike | null
  audit?: typeof auditLog
  log?: Pick<typeof mainLog, 'info' | 'warn'>
}

export interface EgressGuardHandle {
  /** True when a policy is being enforced (false for the no-policy no-op). */
  readonly enforcing: boolean
  /** The guarded fetch (the no-op handle returns the base fetch unchanged). */
  readonly fetch: typeof fetch
  /** Hosts blocked so far this session (audited once each). */
  readonly blocked: ReadonlySet<string>
  /** Put the base fetch back. The Chromium listener stays until the session ends. */
  restore(): void
}

/** Install the guard. `allow === null` (no policy) installs nothing and returns a no-op handle. */
export function installEgressGuard(allow: readonly string[] | null, deps: EgressGuardDeps = {}): EgressGuardHandle {
  const log = deps.log ?? mainLog
  const audit = deps.audit ?? auditLog
  const baseFetch = deps.baseFetch ?? globalThis.fetch
  const setGlobalFetch =
    deps.setGlobalFetch ??
    ((f: typeof fetch): void => {
      globalThis.fetch = f
    })
  const blocked = new Set<string>()

  if (allow === null) {
    log.info('[net] no egressAllowlist in managed config; outbound hosts are not restricted')
    return { enforcing: false, fetch: baseFetch, blocked, restore: () => {} }
  }

  const note = (host: string, via: 'fetch' | 'chromium'): void => {
    if (blocked.has(host)) return
    blocked.add(host)
    log.warn(`[net] egress blocked by policy: ${host} (${via})`)
    audit('net.egress.blocked', { host, via })
  }

  const guardedFetch: typeof fetch = async (input, init) => {
    let request = new Request(input, init)
    const redirectMode = request.redirect
    const replayBody = snapshotReplayableBody(request, init)
    const transportInit = transportExtensions(init)
    let redirects = 0

    while (true) {
      const host = requestHostname(request)
      if (host !== null && !hostAllowed(host, allow)) {
        note(host, 'fetch')
        throw new TypeError(`fetch failed: ${host} is not in the managed egress allowlist`)
      }

      // Native fetch must never follow on our behalf: its next hop would bypass the policy check above.
      // Do not clone the request here. Cloning tees a streaming upload and can buffer its unread branch
      // without bound while the first hop is in flight; streams are rejected only if a redirect needs replay.
      const response = await baseFetch(request, { ...transportInit, redirect: 'manual' })
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null
      if (location === null || redirectMode === 'manual') return markRedirected(response, redirects)
      await discardResponse(response)
      if (redirectMode === 'error') throw new TypeError('fetch failed: redirect mode is set to error')
      if (redirects >= MAX_REDIRECTS) throw new TypeError(`fetch failed: more than ${MAX_REDIRECTS} redirects`)

      const nextUrl = new URL(location, request.url)
      const nextHost = requestHostname(nextUrl)
      if (nextHost !== null && !hostAllowed(nextHost, allow)) {
        note(nextHost, 'fetch')
        throw new TypeError(`fetch failed: ${nextHost} is not in the managed egress allowlist`)
      }

      request = redirectRequest(request, nextUrl, response.status, replayBody)
      redirects += 1
    }
  }
  setGlobalFetch(guardedFetch)

  const webRequest = deps.webRequest === undefined ? safeDefaultWebRequest() : deps.webRequest
  if (webRequest) {
    webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const host = requestHostname(details.url)
      if (host === null || hostAllowed(host, allow)) return callback({ cancel: false })
      note(host, 'chromium')
      callback({ cancel: true })
    })
  } else {
    log.warn('[net] egress guard: Chromium session hook unavailable; only main-process fetch is guarded')
  }

  log.info(`[net] egress allowlist active: ${allow.length} host pattern(s); loopback always allowed`)
  audit('net.egress.policy', { hosts: allow.length, chromiumHook: Boolean(webRequest) })

  return {
    enforcing: true,
    fetch: guardedFetch,
    blocked,
    restore: () => setGlobalFetch(baseFetch)
  }
}

function redirectRequest(request: Request, url: URL, status: number, replayBody: RequestInit['body']): Request {
  const headers = new Headers(request.headers)
  const changesToGet = (status === 301 || status === 302) && request.method === 'POST'
  const changesToGetForSeeOther = status === 303 && request.method !== 'GET' && request.method !== 'HEAD'
  const dropBody = changesToGet || changesToGetForSeeOther

  if (dropBody) {
    for (const name of BODY_HEADERS) headers.delete(name)
  }
  if (new URL(request.url).origin !== url.origin) {
    for (const name of CREDENTIAL_HEADERS) headers.delete(name)
  }

  if (!dropBody && request.body !== null && replayBody === undefined) {
    throw new TypeError('fetch failed: cannot replay a streaming request body across a redirect')
  }

  const init: RequestInit & { cache?: Request['cache']; duplex?: 'half' } = {
    method: dropBody ? 'GET' : request.method,
    headers,
    body: dropBody ? null : replayBody,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal
  }
  if (init.body !== null) init.duplex = 'half'
  return new Request(url, init)
}

/**
 * Capture only body sources that Request can reproduce without teeing or unbounded buffering. `undefined`
 * means a body exists but is a stream/iterator/FormData (or came from an opaque Request) and cannot safely
 * be replayed. `null` means there is no body.
 */
function snapshotReplayableBody(request: Request, init: RequestInit | undefined): RequestInit['body'] {
  if (request.body === null) return null
  const body = init?.body
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Blob) return body
  if (body instanceof ArrayBuffer) return body.slice(0)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
  }
  return undefined
}

/** Keep non-standard transport options (notably undici's dispatcher) without reapplying request fields. */
function transportExtensions(init: RequestInit | undefined): Record<string, unknown> {
  if (!init) return {}
  const out = { ...(init as RequestInit & Record<string, unknown>) }
  for (const key of [
    'body',
    'cache',
    'credentials',
    'duplex',
    'headers',
    'integrity',
    'keepalive',
    'method',
    'mode',
    'redirect',
    'referrer',
    'referrerPolicy',
    'signal',
    'window'
  ]) {
    delete out[key]
  }
  return out
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Redirect policy/result wins over best-effort connection reuse cleanup.
  }
}

function markRedirected(response: Response, redirects: number): Response {
  if (redirects > 0 && !response.redirected) {
    Object.defineProperty(response, 'redirected', { configurable: true, value: true })
  }
  return response
}

function safeDefaultWebRequest(): WebRequestLike | null {
  try {
    return electronSession.defaultSession.webRequest
  } catch {
    return null
  }
}
