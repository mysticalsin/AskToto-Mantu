/**
 * Pure proxy helpers, kept free of any electron/undici import so they are unit-testable in the node
 * vitest environment. `install-proxy.ts` composes these with the real global-dispatcher side effect.
 */

/** A subset of process.env, typed for testability. */
export type ProxyEnv = Record<string, string | undefined>

/**
 * Every env var that puts main-process fetch on the env route, in detectProxyFromEnv's precedence order.
 * EnvHttpProxyAgent itself reads only the HTTP(S) pairs, per request scheme and lowercase first.
 */
export const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const

/** Return the effective proxy URL from the environment, or null when none is configured (direct). */
export function detectProxyFromEnv(env: ProxyEnv): string | null {
  for (const key of PROXY_ENV_VARS) {
    if (env[key]) return env[key]
  }
  return null
}

/** Strip credentials (user:pass@) from a proxy URL so it is safe to log. */
export function redactProxyUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.username || u.password) {
      u.username = ''
      u.password = ''
    }
    return u.toString()
  } catch {
    // Not a parseable URL — never echo it back verbatim (could contain inline credentials).
    return '(set)'
  }
}

/**
 * Parse the result of Electron's `session.resolveProxy(url)` into a proxy URL undici can use, or null
 * for a direct connection.
 *
 * Electron returns a PAC-style string: `"DIRECT"`, `"PROXY host:port"`, `"HTTPS host:port"`, or a
 * semicolon-separated fallback list like `"PROXY host:port; DIRECT"`. We take the FIRST usable HTTP(S)
 * proxy hop and express it as an `http://host:port` URL (undici's ProxyAgent tunnels via CONNECT). SOCKS
 * hops are returned as null here — undici's ProxyAgent cannot use them, and a corporate SOCKS setup is
 * better served by the env-proxy path — so we fall through to direct rather than misroute.
 */
export function parseElectronProxy(resolveResult: string): string | null {
  if (!resolveResult) return null
  for (const raw of resolveResult.split(';')) {
    const entry = raw.trim()
    if (!entry || /^DIRECT$/i.test(entry)) continue
    const m = entry.match(/^(PROXY|HTTPS?)\s+([^\s:]+):(\d+)$/i)
    if (m) return `http://${m[2]}:${m[3]}`
    // SOCKS / unknown scheme — skip this hop and try the next fallback.
  }
  return null
}
