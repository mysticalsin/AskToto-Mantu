/**
 * `metis://handoff?e=<base64url envelope>` (G37). The scheme carries one envelope and nothing else: any other host,
 * any extra parameter or a malformed value is refused. The encoded length is bounded before it is decoded.
 */
import { HANDOFF_MAX_BYTES, type HandoffRejectReason } from './handoff-envelope'

export const HANDOFF_SCHEME = 'metis'
const MAX_ENCODED_CHARS = Math.ceil((HANDOFF_MAX_BYTES * 4) / 3) + 4

export function extractHandoffUrls(argv: readonly string[]): string[] {
  return argv.filter((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${HANDOFF_SCHEME}://`))
}

export type EnvelopeFromUrl = { ok: true; text: string } | { ok: false; reason: HandoffRejectReason }

export function envelopeTextFromUrl(raw: string): EnvelopeFromUrl {
  if (typeof raw !== 'string' || raw.length > MAX_ENCODED_CHARS + 64) return { ok: false, reason: 'oversize' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not_a_handoff_url' }
  }
  if (url.protocol !== `${HANDOFF_SCHEME}:` || url.hostname !== 'handoff')
    return { ok: false, reason: 'not_a_handoff_url' }
  const params = [...url.searchParams.entries()]
  if (params.length !== 1 || params[0][0] !== 'e') return { ok: false, reason: 'malformed' }
  const encoded = params[0][1]
  if (encoded.length > MAX_ENCODED_CHARS) return { ok: false, reason: 'oversize' }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: 'malformed' }
  const text = Buffer.from(encoded, 'base64url').toString('utf8')
  return { ok: true, text }
}
