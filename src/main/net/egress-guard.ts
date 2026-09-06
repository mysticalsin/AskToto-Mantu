import { session as electronSession } from 'electron'
import http from 'node:http'
import https from 'node:https'
import { auditLog, mainLog } from '../logger'
import { hostAllowed, requestHostname } from './egress-policy'

/**
 * Enforce the managed `egressAllowlist` (see egress-policy.ts) in the main process. Three hooks, because
 * Métis has three ways to open a socket:
 *
 *   1. Node `fetch` (undici): every provider client, Graph, the license server, Operator, npm, WorkOS.
 *      Wrapped at `globalThis.fetch` rather than at the undici dispatcher, because install-proxy.ts swaps
 *      the global dispatcher (sometimes late, after a slow PAC resolves) and a dispatcher-level guard
 *      would be silently dropped by that swap. Redirects are followed here, one hop at a time, so a host
 *      on the list cannot bounce the request to a host that is not (undici would otherwise follow the
 *      3xx internally and the guard would only ever see the first URL).
 *   2. Node `http` / `https` `request` and `get`: libraries that do not use fetch (MSAL's token client for
 *      Microsoft sign-in). The wrapper injects a failing `lookup` into the socket options, so a refused
 *      host never reaches DNS and the caller gets the same ENOTFOUND-shaped error a dead network gives.
 *   3. Chromium (`net.fetch`, the renderer, the Intelligence window): `webRequest.onBeforeRequest` on the
 *      default session, which is what those paths use. Chromium runs the listener again on every redirect.
 *
 * A blocked request fails the way a dead network fails (TypeError from fetch, ENOTFOUND from http,
 * ERR_BLOCKED_BY_CLIENT in Chromium), so every caller's existing offline handling applies and the user
 * sees an honest error, not a hang. Each blocked host is audited once per session ('net.egress.blocked',
 * hostname only) so a fleet admin can see what a policy is stopping without the log filling up.
 *
 * Not covered, and documented in docs/NETWORK-EGRESS.md: child processes (the CLI providers, ffmpeg).
 * Loopback is always allowed.
 */

export interface WebRequestLike {
  onBeforeRequest(
    filter: { urls: string[] },
    listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void
  ): void
}

/** The two functions of `node:http` / `node:https` that open a socket. Both are patched in place. */
export interface NodeHttpLike {
  request: (...args: unknown[]) => unknown
  get: (...args: unknown[]) => unknown
}

export interface EgressGuardDeps {
  /** The fetch to wrap. Default: the current globalThis.fetch. */
  baseFetch?: typeof fetch
  /** Where the wrapped fetch is installed. Default: globalThis.fetch. */
  setGlobalFetch?: (f: typeof fetch) => void
  /** Chromium hook. Default: the Electron default session; null = no Chromium hook. */
  webRequest?: WebRequestLike | null
  /** Node http/https modules to patch. Default: the real ones; null = no http hook. */
  nodeHttp?: { http: NodeHttpLike; https: NodeHttpLike } | null
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
  /** Put the base fetch and the http/https functions back. The Chromium listener stays until the session ends. */
  restore(): void
}

/** Same ceiling as the fetch spec. */
const MAX_REDIRECTS = 20
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
/** Never carried across a redirect to a different origin (fetch spec, "request-body-header names" + auth). */
const CROSS_ORIGIN_STRIP = ['authorization', 'proxy-authorization', 'cookie']
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location', 'transfer-encoding']

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

  const note = (host: string, via: 'fetch' | 'chromium' | 'http'): void => {
    if (blocked.has(host)) return
    blocked.add(host)
    log.warn(`[net] egress blocked by policy: ${host} (${via})`)
    audit('net.egress.blocked', { host, via })
  }
  const refused = (host: string, via: 'fetch' | 'http'): Error => {
    note(host, via)
    return new TypeError(`fetch failed: ${host} is not in the managed egress allowlist`)
  }

  const guardedFetch: typeof fetch = async (input, init) => {
    const host = requestHostname(input)
    if (host !== null && !hostAllowed(host, allow)) throw refused(host, 'fetch')
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
    // 'manual' and 'error' never leave the first hop, so the check above is the whole policy.
    if (host === null || mode !== 'follow') return baseFetch(input, init)
    return followRedirects(input, init)
  }

  /** Follow 3xx hops ourselves so every hop's host is checked; undici would follow them unseen. */
  async function followRedirects(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
    const first = new Request(input, init)
    let url = first.url
    let method = first.method
    let headers = new Headers(first.headers)
    // A Request-object body is a stream the first hop consumes; keeping it here makes a 307/308 refuse
    // honestly instead of silently resending an empty body.
    let body: BodyInit | null | undefined = init?.body ?? (input instanceof Request ? input.body : undefined)
    const signal = init?.signal ?? first.signal
    let res = await baseFetch(input, { ...init, redirect: 'manual' })
    for (let hop = 0; REDIRECT_STATUS.has(res.status); hop++) {
      const location = res.headers.get('location')
      if (location === null) return res
      if (hop >= MAX_REDIRECTS) throw new TypeError('fetch failed: redirect count exceeded')
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new TypeError('fetch failed: invalid redirect location')
      }
      const nextHost = requestHostname(next)
      if (nextHost === null) throw new TypeError(`fetch failed: unsupported redirect scheme ${next.protocol}`)
      if (!hostAllowed(nextHost, allow)) throw refused(nextHost, 'fetch')
      // Drain the redirect body so the connection can be reused, then move on.
      void res.body?.cancel().catch(() => {})
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = null
        for (const h of BODY_HEADERS) headers.delete(h)
      } else if (body !== undefined && body !== null && !bodyReusable(body)) {
        throw new TypeError('fetch failed: cannot resend a streaming body across a redirect')
      }
      if (new URL(url).origin !== next.origin) for (const h of CROSS_ORIGIN_STRIP) headers.delete(h)
      url = next.href
      headers = new Headers(headers)
      res = await baseFetch(url, { method, headers, body, signal, redirect: 'manual' })
    }
    return res
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

  const nodeHttp =
    deps.nodeHttp === undefined
      ? { http: http as unknown as NodeHttpLike, https: https as unknown as NodeHttpLike }
      : deps.nodeHttp
  const restoreHttp: Array<() => void> = []
  if (nodeHttp) {
    for (const mod of [nodeHttp.http, nodeHttp.https]) {
      for (const name of ['request', 'get'] as const) {
        const real = mod[name]
        mod[name] = (...args: unknown[]) => {
          const host = nodeRequestHost(args)
          if (host === null || hostAllowed(host, allow)) return real.apply(mod, args)
          const err = refused(host, 'http') as NodeJS.ErrnoException
          err.code = 'ENOTFOUND'
          return real.apply(mod, withFailingLookup(args, err))
        }
        restoreHttp.push(() => {
          mod[name] = real
        })
      }
    }
  }

  log.info(`[net] egress allowlist active: ${allow.length} host pattern(s); loopback always allowed`)
  audit('net.egress.policy', { hosts: allow.length, chromiumHook: Boolean(webRequest), httpHook: Boolean(nodeHttp) })

  return {
    enforcing: true,
    fetch: guardedFetch,
    blocked,
    restore: () => {
      setGlobalFetch(baseFetch)
      for (const r of restoreHttp) r()
    }
  }
}

function bodyReusable(body: BodyInit): boolean {
  if (typeof body === 'string') return true
  if (body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  return false
}

/**
 * Hostname a `http.request(...)` / `http.get(...)` call will connect to, or null when it targets
 * localhost by default or a unix socket. Accepts every documented signature:
 * (url), (url, options), (options), each with an optional trailing callback. When both a URL and an
 * options object are given, the options `hostname` / `host` win, as they do in Node.
 */
export function nodeRequestHost(args: readonly unknown[]): string | null {
  let host: string | null = null
  const a0 = args[0]
  if (typeof a0 === 'string' || a0 instanceof URL) host = requestHostname(a0)
  const opts =
    a0 !== null && typeof a0 === 'object' && !(a0 instanceof URL)
      ? (a0 as Record<string, unknown>)
      : args[1] !== null && typeof args[1] === 'object'
        ? (args[1] as Record<string, unknown>)
        : null
  if (opts) {
    const raw = typeof opts.hostname === 'string' && opts.hostname ? opts.hostname : opts.host
    if (typeof raw === 'string' && raw.trim()) {
      const h = raw.trim().toLowerCase()
      // `host` may carry a port ("example.com:443"); `[::1]:8080` keeps its brackets.
      host = h.startsWith('[') ? h.replace(/\](?::\d+)?$/, ']') : h.replace(/:\d+$/, '')
    }
  }
  return host
}

/** Re-shape the call so Node's own ClientRequest fails at `lookup`, before any socket or DNS query. */
function withFailingLookup(args: readonly unknown[], err: Error): unknown[] {
  const lookup = (_host: string, _opts: unknown, cb: (e: Error) => void): void => {
    cb(err)
  }
  const a0 = args[0]
  const out = [...args]
  if (typeof a0 === 'string' || a0 instanceof URL) {
    const hasOpts = out[1] !== null && typeof out[1] === 'object'
    const opts = hasOpts ? { ...(out[1] as Record<string, unknown>), lookup, agent: false } : { lookup, agent: false }
    if (hasOpts) out[1] = opts
    else out.splice(1, 0, opts)
  } else if (a0 !== null && typeof a0 === 'object') {
    out[0] = { ...(a0 as Record<string, unknown>), lookup, agent: false }
  }
  return out
}

function safeDefaultWebRequest(): WebRequestLike | null {
  try {
    return electronSession.defaultSession.webRequest
  } catch {
    return null
  }
}
