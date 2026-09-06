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

function timingSafeEqualHex(a: string, b: string): boolean {
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
}

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
  const ts = Number(tsRaw)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > OPERATOR_HMAC_SKEW_MS) {
    return { ok: false, status: 401, error: 'timestamp skew' }
  }
  if (seenNonce && (await seenNonce(nonce))) {
    return { ok: false, status: 401, error: 'replay nonce' }
  }
  const bodyHash = await sha256Hex(bodyText)
  const expected = await hmacHex(secret, ingestCanonical(tsRaw, nonce, deviceId, bodyHash))
  if (!timingSafeEqualHex(expected, sig)) {
    return { ok: false, status: 401, error: 'bad HMAC signature' }
  }
  return { ok: true, deviceId, ts, nonce }
}
