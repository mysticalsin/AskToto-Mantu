import { session as electronSession } from 'electron'
import { auditLog, mainLog } from '../logger'
import { hostAllowed, requestHostname } from './egress-policy'

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

  const guardedFetch: typeof fetch = (input, init) => {
    const host = requestHostname(input)
    if (host !== null && !hostAllowed(host, allow)) {
      note(host, 'fetch')
      return Promise.reject(new TypeError(`fetch failed: ${host} is not in the managed egress allowlist`))
    }
    return baseFetch(input, init)
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

function safeDefaultWebRequest(): WebRequestLike | null {
  try {
    return electronSession.defaultSession.webRequest
  } catch {
    return null
  }
}
