import { isIP } from 'node:net'
import { isCloudMetadataAddress, ipv4MappedAddress } from '../../mcp/mcpClient'
import { normalizeHost } from '../../net/egress-policy'
import type { CustomMcpPolicy } from './policy'

export type EndpointCheck = { ok: true; host: string } | { ok: false; rule: string }

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.azure.com'])

const bare = (host: string): string => {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}

/** Parse an IPv6 literal into 8 hextets, accepting `::` compression and a trailing dotted IPv4. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase()
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    if ([a, b, c, d].some((n) => n > 255)) return null
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const out = part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN))
    return out.some(Number.isNaN) ? null : out
  }
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - tail.length
  return fill < 0 ? null : [...head, ...Array<number>(fill).fill(0), ...tail]
}

/** The IPv4 address an IPv6 literal routes to (mapped, compatible or NAT64), else null. */
export function embeddedIpv4(ip: string): string | null {
  const host = bare(ip)
  const mapped = ipv4MappedAddress(host)
  if (mapped) return mapped
  if (isIP(host) !== 6) return null
  const g = ipv6Groups(host)
  if (!g) return null
  const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeros(5) && g[5] === 0xffff) return v4
  if (zeros(6)) return v4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4
  return null
}

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

/** Private, loopback, link-local, unspecified or CGNAT address (any IPv4/IPv6 spelling), or a local-only name. */
export function isPrivateOrLocalAddress(addressOrHost: string): boolean {
  const host = bare(addressOrHost)
  if (isIP(host) === 4) return isPrivateIpv4(host)
  if (isIP(host) === 6) {
    const v4 = embeddedIpv4(host)
    if (v4) return isPrivateIpv4(v4)
    const g = ipv6Groups(host)
    if (!g) return true
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80
  }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
}

function isMetadata(host: string): boolean {
  const h = bare(host)
  if (METADATA_HOSTS.has(h) || isCloudMetadataAddress(h)) return true
  const v4 = embeddedIpv4(h)
  return !!v4 && isCloudMetadataAddress(v4)
}

/** Matches the egress allow-list entry syntax (`host` or `*.suffix`) but, unlike `hostAllowed`, never passes loopback. */
function matchesAllowedHost(host: string, allowed: readonly string[]): boolean {
  return allowed.some((raw) => {
    const entry = normalizeHost(raw)
    if (!entry) return false
    if (entry.startsWith('*.')) {
      const base = entry.slice(2)
      return host === base || host.endsWith(`.${base}`)
    }
    return host === entry
  })
}

/** Static checks on the literal endpoint. Resolved addresses are checked by `customAddressGuard` at connect time. */
export function checkHttpsEndpoint(rawUrl: string, policy: CustomMcpPolicy): EndpointCheck {
  if (!policy.allow) return { ok: false, rule: policy.deniedRule ?? 'customMcp.allow' }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, rule: 'customMcp.url' }
  }
  if (url.protocol !== 'https:') return { ok: false, rule: 'customMcp.https' }
  if (url.username || url.password) return { ok: false, rule: 'customMcp.credentials' }
  const host = bare(url.hostname)
  if (!host) return { ok: false, rule: 'customMcp.url' }
  if (isMetadata(host)) return { ok: false, rule: 'customMcp.metadata' }
  if (!policy.allowPrivateNetwork && isPrivateOrLocalAddress(host)) {
    return { ok: false, rule: 'customMcp.allowPrivateNetwork' }
  }
  if (policy.allowedHosts !== null && !matchesAllowedHost(host, policy.allowedHosts)) {
    return { ok: false, rule: 'customMcp.allowedHosts' }
  }
  return { ok: true, host }
}

/** Per-address guard for the pinned DNS answer: metadata always, private ranges unless the policy allows them. */
export function customAddressGuard(policy: CustomMcpPolicy): (ip: string) => Error | null {
  return (ip) => {
    if (isMetadata(ip)) return new Error('customMcp.metadata')
    if (!policy.allowPrivateNetwork && isPrivateOrLocalAddress(ip)) return new Error('customMcp.allowPrivateNetwork')
    return null
  }
}
