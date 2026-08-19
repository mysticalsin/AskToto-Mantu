import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici'
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

/** Direct-connection dispatcher: undici's default agent drops idle sockets after ~4s, so back-to-back
 *  provider asks would re-pay DNS + TCP + TLS (typically 100-300ms of the time-to-first-token). */
function directAgent(): Agent {
  return new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 })
}

function installSystemProxy(resolved: string, late: boolean): boolean {
  const systemProxy = parseElectronProxy(resolved)
  if (!systemProxy) return false
  setGlobalDispatcher(new ProxyAgent(systemProxy))
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
      // The environment already names a proxy (incl. NO_PROXY handling). EnvHttpProxyAgent reads it and
      // routes accordingly — belt-and-suspenders even though Electron's fetch honors env proxies natively.
      setGlobalDispatcher(new EnvHttpProxyAgent())
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
      setGlobalDispatcher(directAgent())
      mainLog.warn(
        `[net] OS proxy resolution exceeded ${OS_PROXY_DEADLINE_MS}ms; continuing direct and upgrading if it lands`
      )
      void resolving.then((answer) => installSystemProxy(answer, true)).catch(() => {})
      return
    }

    if (installSystemProxy(resolved, false)) return

    // Direct connection.
    setGlobalDispatcher(directAgent())
    mainLog.info('[net] no proxy configured (direct); keep-alive fetch agent installed')
  } catch (e) {
    mainLog.warn('[net] could not install proxy-aware fetch; requests stay on the default path', e)
  }
}
