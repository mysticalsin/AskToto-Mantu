import type { LookupAddress } from 'node:dns'
import { isIPv6, type LookupFunction } from 'node:net'
import {
  Agent,
  EnvHttpProxyAgent,
  Pool,
  ProxyAgent,
  setGlobalDispatcher,
  type buildConnector,
  type Dispatcher
} from 'undici'
import { session } from 'electron'
import { mainLog, auditLog } from '../logger'
import { detectProxyFromEnv, parseElectronProxy, redactProxyUrl } from './proxy-url'

/**
 * Make the main process' built-in `fetch` reach providers through whatever proxy the machine is behind.
 *
 * Every provider that talks over `fetch` — Dust (@dust-tt/client), OpenAI, Anthropic, the custom
 * OpenAI-compatible endpoint, the license server — runs on the main-process undici `fetch`. Two gaps
 * caused `TypeError: fetch failed` (a ~10s TCP connect-timeout) on managed corporate networks like
 * Mantu's, while the proxy-aware `dust` CLI could still refresh its token (so the app *looked* connected):
 *
 *   1. Env proxy (HTTP_PROXY / HTTPS_PROXY): Electron's fetch already honors these, but a macOS/Windows
 *      app launched from Finder/Explorer does NOT inherit the shell env, so they are often absent.
 *   2. System proxy (macOS System Settings, Windows, or a PAC file): Electron's main-process undici fetch
 *      does NOT consult the OS proxy at all. This is the common corporate case and the real gap.
 *
 * Fix: ask Electron's own resolver — which DOES read the OS proxy config — what to use for a real provider
 * host, and route undici through it. When the env already carries a proxy we honor that (EnvHttpProxyAgent,
 * which also respects NO_PROXY); when the OS says DIRECT and no env proxy is set we leave the default
 * dispatcher untouched, so this is a strict no-op for users on an open network. Best-effort throughout:
 * a failure here must never block startup — fetch just stays on its default path.
 *
 * "Must never block startup" is a LATENCY promise too, not just an exception one (MQA-190). This runs as
 * the first await inside app.whenReady(), ahead of createTray/createWindow, and `resolveProxy` on a
 * machine configured with an automatic-configuration script has to fetch and compile the PAC file before
 * it can answer — off the corporate network that host can black-hole. So the probe is bounded, and a
 * late answer upgrades the dispatcher in place rather than being thrown away: a merely-slow corporate
 * PAC must not cost the session the proxy routing this module exists to provide.
 */
const OS_PROXY_DEADLINE_MS = 2_000

/** How main-process fetch reaches the network. Kept, not just applied, so routeDispatcher() below can
 *  build ANOTHER dispatcher (for one MCP session's own connect-time DNS pin — see mcpClient.ts) that
 *  routes exactly like the global one, on whichever of these three the machine turned out to need. */
type Route = { kind: 'direct' } | { kind: 'env' } | { kind: 'system'; proxy: string }

let route: Route = { kind: 'direct' }

/** Raised by routeDispatcher(lookup) when the route's proxy can only be sent the host name, never an
 *  address, so it would resolve the host itself and `lookup` could not hold it. Today that is a SOCKS
 *  proxy on the env route: undici tunnels it outside the pool `factory` hook pinning relies on. */
export class UnpinnableProxyError extends Error {}

/**
 * A dispatcher on the CURRENT route (`route`, above). Given a `lookup`, every connection it opens goes to
 * an address `lookup` returned, whoever dials it:
 *   - a socket this process dials itself (the direct route, and NO_PROXY hosts on the env route) resolves
 *     through `lookup` at connect time;
 *   - a tunnel a proxy opens (the system route, and every other host on the env route) is requested as
 *     `CONNECT <address>:<port>`, so the proxy dials that address and resolves nothing itself.
 * A SOCKS proxy is sent the host name and cannot be held to an address, so it is refused with
 * UnpinnableProxyError rather than used unpinned. Without `lookup` (the shared global dispatcher) proxies
 * resolve as usual.
 *
 * `setGlobalDispatcher` is deliberately NOT called here — that is useRoute()'s job, once, for the
 * shared global dispatcher. A caller building its own (e.g. one MCP session's pinned dispatcher) gets
 * back a dispatcher it alone owns and must destroy.
 */
export function routeDispatcher(lookup?: LookupFunction): Dispatcher {
  const connect = lookup && { lookup }
  const factory = lookup && pinnedTunnelFactory(lookup)
  switch (route.kind) {
    case 'env':
      // The environment already names a proxy (incl. NO_PROXY handling). EnvHttpProxyAgent reads it
      // and routes accordingly — belt-and-suspenders even though Electron's fetch honors env proxies
      // natively. `{ connect: undefined }` is the same as omitting `connect` entirely.
      if (lookup && envProxyIsSocks()) {
        throw new UnpinnableProxyError('a SOCKS proxy is sent the host name, so the pinned address cannot be kept')
      }
      return new EnvHttpProxyAgent({ connect, factory })
    case 'system':
      return new ProxyAgent({ uri: route.proxy, factory })
    case 'direct':
      // undici's default agent drops idle sockets after ~4s, so back-to-back provider asks would
      // re-pay DNS + TCP + TLS (typically 100-300ms of the time-to-first-token) without keep-alive.
      return new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connect })
  }
}

/** Whether the effective env proxy route (using detectProxyFromEnv's precedence, shared with boot) is
 *  a SOCKS proxy, which undici tunnels by host name outside the pool factory. */
function envProxyIsSocks(): boolean {
  return /^socks5?:/i.test(detectProxyFromEnv(process.env) ?? '')
}

/**
 * The pool factory for a proxying dispatcher. ProxyAgent builds each tunnelled origin's pool with the
 * tunnel as a connector FUNCTION, and that tunnel is aimed here at the address `lookup` resolves. A pool
 * that dials its own socket (EnvHttpProxyAgent's NO_PROXY hosts) gets connector OPTIONS that already carry
 * `lookup`, and is built unchanged.
 */
function pinnedTunnelFactory(lookup: LookupFunction): NonNullable<Agent.Options['factory']> {
  return (origin, options) => {
    const pool = options as Pool.Options // undici types factory options as `Object`; they are the pool's options
    const { connect } = pool
    return new Pool(origin, typeof connect === 'function' ? { ...pool, connect: pinnedTunnel(connect, lookup) } : pool)
  }
}

/**
 * `tunnel`, opened to an address `lookup` resolves for the origin instead of to its host name. Only the
 * target changes: `servername` (SNI and the certificate check) and the request's Host header still name
 * the host. IPv4 is preferred because a corporate proxy may have no IPv6 route, and every answer has
 * already passed `lookup`'s own checks.
 */
function pinnedTunnel(tunnel: buildConnector.connector, lookup: LookupFunction): buildConnector.connector {
  return (options, callback) =>
    lookup(options.hostname, { all: true }, (error, answer) => {
      if (error) return callback(error, null)
      const addresses = answer as LookupAddress[] // `all: true` always answers a list
      const { address } = addresses.find((a) => a.family === 4) ?? addresses[0]
      const host = isIPv6(address) ? `[${address}]` : address
      tunnel({ ...options, hostname: address, host: options.port ? `${host}:${options.port}` : host }, callback)
    })
}

/** Adopt a new route and (re)install the shared global dispatcher for it — the ONE place that changes
 *  what main-process `fetch` uses by default. Everything else routeDispatcher() can build for its own
 *  purposes follows this same `route` state without touching the global dispatcher again. */
function useRoute(next: Route): void {
  route = next
  setGlobalDispatcher(routeDispatcher())
}

function installSystemProxy(resolved: string, late: boolean): boolean {
  const systemProxy = parseElectronProxy(resolved)
  if (!systemProxy) return false
  useRoute({ kind: 'system', proxy: systemProxy })
  mainLog.info(
    `[net] proxy-aware fetch installed from system config${late ? ' (late — after the boot deadline)' : ''}`,
    systemProxy,
    `(resolved: ${resolved})`
  )
  auditLog('net.proxy', { source: late ? 'system-late' : 'system', proxy: systemProxy })
  return true
}

export async function installProxyAwareFetch(): Promise<void> {
  try {
    const envProxy = detectProxyFromEnv(process.env)
    if (envProxy) {
      useRoute({ kind: 'env' })
      const safe = redactProxyUrl(envProxy)
      mainLog.info('[net] proxy-aware fetch installed from environment', safe)
      auditLog('net.proxy', { source: 'env', proxy: safe })
      return
    }

    // No env proxy - consult the OS proxy config via Electron for a representative provider host. Resolve
    // against dust.tt specifically: it is the provider that surfaced the failure, and a corporate PAC can
    // return different results per host.
    const resolving = session.defaultSession.resolveProxy('https://dust.tt').catch(() => 'DIRECT')
    let deadline: ReturnType<typeof setTimeout> | undefined
    const resolved = await Promise.race([
      resolving,
      new Promise<null>((r) => {
        deadline = setTimeout(() => r(null), OS_PROXY_DEADLINE_MS)
      })
    ])
    clearTimeout(deadline)

    if (resolved === null) {
      // The probe outran the deadline. Boot proceeds on a direct dispatcher NOW so the tray and window
      // appear, but the resolver is left running: when it lands we swap the dispatcher for the real
      // proxy. Dropping it here instead would turn a merely-slow PAC into a whole session of
      // `TypeError: fetch failed` - the exact failure this module was written to remove.
      useRoute({ kind: 'direct' })
      mainLog.warn(
        `[net] OS proxy resolution exceeded ${OS_PROXY_DEADLINE_MS}ms; continuing direct and upgrading if it lands`
      )
      void resolving.then((answer) => installSystemProxy(answer, true)).catch(() => {})
      return
    }

    if (installSystemProxy(resolved, false)) return

    // Direct connection.
    useRoute({ kind: 'direct' })
    mainLog.info('[net] no proxy configured (direct); keep-alive fetch agent installed')
  } catch (e) {
    mainLog.warn('[net] could not install proxy-aware fetch; requests stay on the default path', e)
  }
}
