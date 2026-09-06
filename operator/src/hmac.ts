import { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_HMAC_SKEW_MS } from '../../src/shared/operator-hmac'
import { sha256Hex } from './crypto'

const enc = new TextEncoder()

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface HmacCheck {
  ok: true
  deviceId: string
  ts: number
  nonce: string
}

export interface HmacFail {
  ok: false
  status: number
  error: string
  code?: string
}

/** The desktop's real device id is `hashOperatorId(getMachineId())`
 *  (`src/main/operator-hmac-sign.ts`): `sha256(machineId).slice(0, 32)`, always 32 lowercase hex
 *  characters. This pattern is deliberately wider (letters upper and lower, digits, `. _ -`, 8 to 128
 *  chars) so a future id scheme has room without a breaking change, while still rejecting anything
 *  that could carry a newline, HTML, or an unbounded length into logs, audit text, or a D1 key. */
export const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/

export async function verifyIngestHmac(
  request: Request,
  bodyText: string,
  secret: string,
  now = Date.now(),
  seenNonce?: (nonce: string) => Promise<boolean>
): Promise<HmacCheck | HmacFail> {
  if (!secret) return { ok: false, status: 500, error: 'ingest secret not configured' }
  const tsRaw = request.headers.get(OPERATOR_HMAC_HEADERS.ts) ?? ''
  const nonce = request.headers.get(OPERATOR_HMAC_HEADERS.nonce) ?? ''
  const deviceId = request.headers.get(OPERATOR_HMAC_HEADERS.device) ?? ''
  const sig = (request.headers.get(OPERATOR_HMAC_HEADERS.sig) ?? '').toLowerCase()
  if (!tsRaw || !nonce || !deviceId || !sig) {
    return { ok: false, status: 401, error: 'missing HMAC headers' }
  }
  // Checked before any crypto or storage I/O: a malformed device id (newline, HTML, oversized) must
  // never reach a nonce write, a rate bucket key, an audit row, or a D1 primary key.
  if (!DEVICE_ID_RE.test(deviceId)) {
    return { ok: false, status: 401, error: 'invalid device id', code: 'device-id' }
  }
  const ts = Number(tsRaw)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > OPERATOR_HMAC_SKEW_MS) {
    return { ok: false, status: 401, error: 'timestamp skew' }
  }
  const bodyHash = await sha256Hex(bodyText)
  const expected = await hmacHex(secret, ingestCanonical(tsRaw, nonce, deviceId, bodyHash))
  if (!timingSafeEqualHex(expected, sig)) {
    return { ok: false, status: 401, error: 'bad HMAC signature' }
  }
  // Only a request that already proved it holds the secret may consume a nonce. Checking replay first
  // let an anonymous caller write unbounded rows into the nonce table and burn a real seat's nonce.
  if (seenNonce && (await seenNonce(nonce))) {
    return { ok: false, status: 401, error: 'replay nonce' }
  }
  return { ok: true, deviceId, ts, nonce }
}
