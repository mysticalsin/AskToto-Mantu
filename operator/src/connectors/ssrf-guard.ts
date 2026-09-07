/**
 * Pure hostname/IP classification for every SSRF guard in this codebase: `probe.ts`'s
 * `isUnsafeProbeHost` (task B2, an admin's one-off "Test connection" click) and
 * `adapters/shared.ts`'s `isUnsafeGatewayHost` (task B3, this gateway's per-call re-check, including
 * every address `resolveThenValidate` resolves a hostname to) both call `isUnsafeHost` below rather than
 * each carrying their own copy. Two independently hand-maintained copies of this exact logic is how a
 * gap in one of them - the IPv4-mapped IPv6 case handled below - can go unnoticed in the other; one
 * function fixed once removes that drift risk going forward.
 *
 * A pure leaf module: no imports of its own, so both `probe.ts` and `adapters/shared.ts` can depend on
 * it without creating a cycle.
 *
 * Blocks: loopback, link-local, and private IPv4 ranges (127/8, 169.254/16, 10/8, 172.16/12, 192.168/16,
 * 0/8); their IPv6 equivalents (`::1`, `fe80::/10`, `fc00::/7`); `localhost`, `*.internal`, `*.local`,
 * `metadata.google.internal`, and the bare `169.254.169.254` cloud metadata address; a trailing-dot FQDN
 * form of any of the above (`new URL()` preserves a trailing dot verbatim, so a check that only matches
 * the bare name misses `https://localhost./x`); and an IPv4-mapped or IPv4-compatible IPv6 form of any
 * IPv4 case, in EITHER the hex-group form `new URL()` normalises a bracketed literal to
 * (`::ffff:a9fe:a9fe`) or the dotted-decimal text form a bare string never gets normalised out of
 * (`::ffff:169.254.169.254`) - `resolveThenValidate` calls this directly on a raw DNS-answer string that
 * never passes through `new URL()`, so both forms have to work here.
 */

export function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null
}

export function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts
  if (a === 127) return true // loopback
  if (a === 10) return true // private
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 169 && b === 254) return true // link-local (covers the cloud metadata address)
  if (a === 0) return true // "this network"
  return false
}

/** `a.b.c.d` embedded as the last two groups of an IPv6 literal (`::ffff:169.254.169.254`) is valid
 *  IPv6 text notation, but the only thing in this codebase that normalises it to pure hex groups
 *  (`::ffff:a9fe:a9fe`) is `new URL()`, and only for a literal that actually passes through one. A bare
 *  hostname or DNS-answer string handed straight to `isUnsafeHost` never does, so the dotted tail is
 *  converted to two hex groups here before the hex-group parsing below ever sees it. */
function embedIPv4Tail(host: string): string {
  if (!host.includes('.')) return host
  const lastColon = host.lastIndexOf(':')
  if (lastColon === -1) return host
  const v4 = parseIPv4(host.slice(lastColon + 1))
  if (!v4) return host
  const hi = ((v4[0] << 8) | v4[1]).toString(16)
  const lo = ((v4[2] << 8) | v4[3]).toString(16)
  return `${host.slice(0, lastColon + 1)}${hi}:${lo}`
}

/** Expands a (possibly `::`-compressed, possibly dotted-IPv4-tailed) IPv6 literal to 8 hex groups, or
 *  null if it is not a bare literal (a bracketed literal has its brackets stripped by the caller before
 *  this runs). Exported alongside `parseIPv4` for `adapters/shared.ts`'s `resolveThenValidate`, which
 *  uses both directly to tell "this is already an IP literal, nothing to resolve" apart from a hostname. */
export function expandIPv6(host: string): string[] | null {
  if (!host.includes(':')) return null
  const normalized = embedIPv4Tail(host)
  if ((normalized.match(/::/g) || []).length > 1) return null
  const [headPart, tailPart] = normalized.split('::')
  const head = headPart ? headPart.split(':') : []
  const tail = normalized.includes('::') ? (tailPart ? tailPart.split(':') : []) : []
  if (!normalized.includes('::')) {
    const full = normalized.split(':')
    return full.length === 8 && full.every((g) => /^[0-9a-f]{0,4}$/i.test(g)) ? full : null
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = [...head, ...Array(missing).fill('0'), ...tail]
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{0,4}$/i.test(g)) ? groups : null
}

export function isPrivateIPv6(host: string): boolean {
  const hex = expandIPv6(host)
  if (!hex) return false
  const groups = hex.map((g) => Number(`0x${g || '0'}`))
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (groups.every((g) => g === 0)) return true // :: (unspecified)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true // ::1
  // IPv4-mapped (5 zero groups + 0xffff + 2 groups of IPv4) or the deprecated IPv4-compatible form
  // (6 zero groups + 2 groups of IPv4): g0-g4 are zero in both, only g5 (0xffff vs 0) tells them apart.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (isPrivateIPv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff])) return true
  }
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true // fe80::/10 link-local
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true // fc00::/7 unique local
  return false
}

/** A trailing dot is a valid FQDN root-label separator that `new URL()` preserves verbatim
 *  ("localhost." stays "localhost."), so every check below runs against the dot-stripped form or it
 *  silently misses "https://localhost./x", "https://metadata.google.internal./x", and the like. */
export function isUnsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host === 'metadata.google.internal' || host === '169.254.169.254') return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  const v4 = parseIPv4(host)
  if (v4) return isPrivateIPv4(v4)
  if (host.includes(':')) return isPrivateIPv6(host)
  return false
}
