/**
 * cloudflare-base-url.ts — packaged-build pin for settings.cloudflareBaseUrl.
 *
 * Threat (METIS-SECURITY-DEEP-RECEIPT row 4 HIGH): a per-user managed-config.json or settings.json can
 * point cloudflareBaseUrl at an attacker host; the app then sends the bearer METIS_PROXY_KEY and every
 * prompt there. Packaged builds therefore accept only:
 *   - https URLs whose host is `*.workers.dev` (the default Worker shape), or
 *   - hosts listed in the ADMIN machine-wide managed-config `cloudflareBaseUrlAllowlist`, or
 *   - the host of an admin-managed `cloudflareBaseUrl` itself (self-host via admin policy).
 *
 * Dev / unpackaged builds stay unrestricted beyond the existing https schema check — local operators
 * iterate freely. Self-host remains an admin managed-config decision, never a user-writable one.
 * See docs/NETWORK-EGRESS.md and docs/CLOUDFLARE.md.
 */
import { normalizeHost } from './net/egress-policy'

/** True when hostname is workers.dev or a subdomain (the default Cloudflare Worker proxy shape). */
export function isWorkersDevHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  return h === 'workers.dev' || h.endsWith('.workers.dev')
}

/** Parse admin `cloudflareBaseUrlAllowlist` (hostnames / *.wildcards). Empty / absent → []. */
export function parseCloudflareBaseUrlAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const obj = JSON.parse(raw) as { cloudflareBaseUrlAllowlist?: unknown } | null
    const list = obj?.cloudflareBaseUrlAllowlist
    if (!Array.isArray(list)) return []
    const out = new Set<string>()
    for (const item of list) {
      const h = normalizeHost(item)
      if (h) out.add(h)
    }
    return [...out]
  } catch {
    return []
  }
}

/** Hostname of an https cloudflareBaseUrl, or null when empty / not a usable URL. */
export function cloudflareBaseUrlHostname(url: string): string | null {
  const v = String(url ?? '').trim()
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:') return null
    return u.hostname ? u.hostname.toLowerCase().replace(/\.$/, '') : null
  } catch {
    return null
  }
}

function hostOnAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2)
      if (h === base || h.endsWith(`.${base}`)) return true
    } else if (h === entry) {
      return true
    }
  }
  return false
}

export interface CloudflareBaseUrlPinOpts {
  /** Packaged install — pin is enforced. Unpackaged / vitest electron mock → false → no pin. */
  packaged: boolean
  /** Hosts from admin managed-config `cloudflareBaseUrlAllowlist`. */
  adminAllowlist?: readonly string[]
  /** Admin-managed cloudflareBaseUrl value (its host is implicitly allowed for self-host). */
  adminConfiguredUrl?: string | null
}

/**
 * Whether `url` may be used as cloudflareBaseUrl under the packaged pin.
 * Empty string (mid-setup) is always allowed. Unpackaged builds accept any https URL.
 */
export function cloudflareBaseUrlAllowed(url: string, opts: CloudflareBaseUrlPinOpts): boolean {
  const v = String(url ?? '').trim()
  if (!v) return true
  if (!opts.packaged) {
    return /^https:\/\//i.test(v)
  }
  const host = cloudflareBaseUrlHostname(v)
  if (!host) return false
  if (isWorkersDevHost(host)) return true
  const allow = opts.adminAllowlist ?? []
  if (allow.length && hostOnAllowlist(host, allow)) return true
  const adminUrl = opts.adminConfiguredUrl
  if (adminUrl) {
    const adminHost = cloudflareBaseUrlHostname(adminUrl)
    if (adminHost && adminHost === host) return true
  }
  return false
}
