/**
 * Egress allowlist policy. Pure: no Electron, no I/O, so it is unit-testable and shared by the
 * main-process fetch wrapper and the Chromium session hook in egress-guard.ts.
 *
 * Managed-config key: `egressAllowlist` (array of hostnames). Absent or not an array = no restriction,
 * which is today's behavior for every install. An explicit empty array is a real deny-all policy, the
 * same reading `allowedProviders` gets in store.ts. Entries are hostnames, never URLs: `graph.microsoft.com`
 * matches that host only; `*.dust.tt` matches `dust.tt` and every subdomain. Loopback is always allowed
 * (the on-device model servers live there), and the policy never inspects paths or bodies.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const h = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return null
  // Tolerate an admin pasting a URL or a host:port; we key on the hostname alone.
  const viaUrl = /^[a-z][a-z0-9+.-]*:\/\//.test(h) ? safeHostname(h) : safeHostname(`https://${h}`)
  if (viaUrl) return viaUrl
  return /^[a-z0-9*][a-z0-9*.-]*$/.test(h) ? h : null
}

function safeHostname(url: string): string | null {
  try {
    const u = new URL(url)
    return u.hostname ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

export function parseEgressAllowlist(raw: string): string[] | null {
  try {
    const obj = JSON.parse(raw) as { egressAllowlist?: unknown } | null
    const list = obj?.egressAllowlist
    if (!Array.isArray(list)) return null
    const out = new Set<string>()
    for (const item of list) {
      const h = normalizeHost(item)
      if (h) out.add(h)
    }
    return [...out]
  } catch {
    return null
  }
}

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase())
}

/** True when `hostname` may be contacted under `allow`. `allow === null` means no policy: always true. */
export function hostAllowed(hostname: string, allow: readonly string[] | null): boolean {
  if (allow === null) return true
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return false
  if (isLoopback(h)) return true
  for (const entry of allow) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2)
      if (h === base || h.endsWith(`.${base}`)) return true
    } else if (h === entry) {
      return true
    }
  }
  return false
}

/**
 * The policy the boot guard is enforcing, kept here (no Electron, no I/O) so child-process spawn sites can
 * consult it without importing the guard. Null = no policy. Only installEgressGuard() sets it.
 */
let activePolicy: readonly string[] | null = null

export function setActiveEgressPolicy(allow: readonly string[] | null): void {
  activePolicy = allow
}

/**
 * True when a child process that reaches the network on its own (the CLI providers) must not be spawned.
 * A child opens its own sockets, which no in-process hook sees, so under any policy the only hard guarantee
 * is to refuse the spawn. Loopback-only children (local model servers) are not covered by this.
 */
export function childNetworkBlocked(allow: readonly string[] | null = activePolicy): boolean {
  return allow !== null
}

/** Unroutable loopback proxy: connections to it are refused, so a proxy-honoring child fails closed. */
export const DEAD_PROXY_URL = 'http://127.0.0.1:9'

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const

/**
 * `env` for a child process. With no policy it is returned unchanged. Under a policy every proxy variable
 * is pinned to DEAD_PROXY_URL and NO_PROXY is emptied, so a child that honors the environment cannot
 * reach a host directly or through the machine's proxy. Defense in depth behind childNetworkBlocked():
 * a binary that ignores proxy variables is only stopped by not being spawned.
 */
export function pinChildEnv(env: NodeJS.ProcessEnv, allow: readonly string[] | null = activePolicy): NodeJS.ProcessEnv {
  if (allow === null) return env
  const pinned: NodeJS.ProcessEnv = { ...env }
  for (const key of PROXY_VARS) pinned[key] = DEAD_PROXY_URL
  pinned.NO_PROXY = ''
  pinned.no_proxy = ''
  return pinned
}

/** Hostname of a fetch input (string, URL, or Request), or null when it has none (relative, data:, blob:). */
export function requestHostname(input: unknown): string | null {
  let url: string | null = null
  if (typeof input === 'string') url = input
  else if (input instanceof URL) url = input.href
  else if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') {
    url = (input as { url: string }).url
  }
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}
