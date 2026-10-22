/**
 * RS256 JWT core shared by every third-party token the Worker verifies: Cloudflare Access application
 * tokens (`access.ts`) and Microsoft Entra v2 ID tokens (`entra-idtoken.ts`).
 *
 * It owns only the parts that must never differ between callers: strict three-part parsing, the
 * `alg` allowlist (exactly `RS256`; `none`, HS* and everything else are refused, so a symmetric-key
 * confusion attack has no door), key selection by `kid`, and the RSASSA-PKCS1-v1_5 / SHA-256
 * signature check through WebCrypto. Claim policy (iss/aud/exp/nbf/iat/tid) stays with each caller,
 * because the claims a caller must demand are a property of that issuer.
 *
 * JWKS documents are cached per URL. An unknown `kid` is how an issuer rotates keys, so the cache
 * supports one forced refetch for it, itself rate-limited, so an attacker minting tokens with random
 * `kid` values cannot turn this Worker into a request amplifier against the issuer.
 */

export type Jwk = {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  crv?: string
  x?: string
  y?: string
  n?: string
  e?: string
}

export type ParsedJwt = {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signingInput: string
  signature: Uint8Array
}

export const MAX_JWT_CHARS = 8 * 1024

const enc = new TextEncoder()

export function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function b64urlToString(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict structural parse. Returns null for anything that is not exactly `header.payload.signature`
 *  with two JSON-object segments and a base64url signature. No claim is interpreted here. */
export function parseJwt(token: string): ParsedJwt | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_JWT_CHARS) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])))
    const payload: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])))
    if (!isPlainObject(header) || !isPlainObject(payload)) return null
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64urlToBytes(parts[2]) }
  } catch {
    return null
  }
}

/** Header gate: the one accepted signature algorithm, and a non-empty string `kid` to select the key. */
export function rs256Kid(header: Record<string, unknown>): string | null {
  if (header.alg !== 'RS256') return null
  return typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 256 ? header.kid : null
}

export function findRsaKey(keys: readonly Jwk[], kid: string): Jwk | null {
  const key = keys.find((k) => k.kid === kid)
  if (!key || key.kty !== 'RSA') return null
  if (key.alg !== undefined && key.alg !== 'RS256') return null
  if (key.use !== undefined && key.use !== 'sig') return null
  return key
}

export async function verifyRs256Signature(parsed: ParsedJwt, key: Jwk): Promise<boolean> {
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, n: key.n, e: key.e, alg: 'RS256', ext: true } as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      parsed.signature as BufferSource,
      enc.encode(parsed.signingInput) as BufferSource
    )
  } catch {
    return false
  }
}

export interface JwksCacheOptions {
  /** How long a fetched key set is served without asking the issuer again. */
  ttlMs: number
  /** Minimum spacing between forced refetches for one URL (unknown-`kid` rotation path). */
  forcedRefetchMinMs?: number
  /** Per-request timeout toward the issuer. */
  timeoutMs?: number
}

export type JwksFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface JwksCache {
  /** Key set for `url`; null when the issuer could not be reached or answered something unusable. */
  keys(url: string, now: number, fetchImpl?: JwksFetch): Promise<Jwk[] | null>
  /** One forced refetch for an unknown `kid`, honoured at most once per `forcedRefetchMinMs`. Returns
   *  the new key set, or null when the refetch was throttled or failed (the caller then refuses). */
  refreshForUnknownKid(url: string, now: number, fetchImpl?: JwksFetch): Promise<Jwk[] | null>
  clear(): void
}

export function createJwksCache(opts: JwksCacheOptions): JwksCache {
  const entries = new Map<string, { at: number; keys: Jwk[]; lastForced: number }>()
  const forcedMin = opts.forcedRefetchMinMs ?? 5 * 60 * 1000
  const timeoutMs = opts.timeoutMs ?? 5000

  async function download(url: string, fetchImpl?: JwksFetch): Promise<Jwk[] | null> {
    try {
      const doFetch: JwksFetch = fetchImpl ?? ((u, init) => fetch(u, init))
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const doc = (await res.json()) as { keys?: unknown }
      if (!Array.isArray(doc.keys)) return null
      return doc.keys.filter(isPlainObject) as Jwk[]
    } catch {
      return null
    }
  }

  return {
    async keys(url, now, fetchImpl) {
      const cached = entries.get(url)
      if (cached && now - cached.at < opts.ttlMs) return cached.keys
      const fetched = await download(url, fetchImpl)
      if (!fetched) return null
      entries.set(url, { at: now, keys: fetched, lastForced: cached?.lastForced ?? Number.NEGATIVE_INFINITY })
      return fetched
    },
    async refreshForUnknownKid(url, now, fetchImpl) {
      const cached = entries.get(url)
      const lastForced = cached?.lastForced ?? Number.NEGATIVE_INFINITY
      if (now - lastForced < forcedMin) return null
      // Record the attempt before the network call so concurrent unknown-kid requests share one fetch.
      entries.set(url, { at: cached?.at ?? Number.NEGATIVE_INFINITY, keys: cached?.keys ?? [], lastForced: now })
      const fetched = await download(url, fetchImpl)
      if (!fetched) return null
      entries.set(url, { at: now, keys: fetched, lastForced: now })
      return fetched
    },
    clear() {
      entries.clear()
    }
  }
}
