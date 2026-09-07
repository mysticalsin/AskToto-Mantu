import { createHash, createHmac, randomUUID } from 'node:crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '@shared/operator-hmac'
import { OPERATOR_SEAT_KEY_INFO, parseOperatorLicense } from '@shared/operator-license'

/**
 * The per-seat ingest key derived from this seat's license token, as hex.
 *
 * node:crypto side. The Worker computes the identical bytes with WebCrypto
 * (`operatorSeatKeyFromLicense`, shared/operator-license.ts) after rebuilding the token from the
 * claims it stored, and operator/src/seat-key.parity.test.ts proves the two agree. That agreement is
 * what lets a license act as its own credential: the token never leaves this machine, the ingest
 * secret never reaches it, and both ends still arrive at the same key.
 */
export function seatKeyFromLicense(token: string): string {
  return createHmac('sha256', token).update(OPERATOR_SEAT_KEY_INFO, 'utf8').digest('hex')
}

export function sha256HexUtf8(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function signOperatorIngest(
  secret: string,
  ts: string,
  nonce: string,
  deviceId: string,
  body: string
): string {
  return createHmac('sha256', secret).update(ingestCanonical(ts, nonce, deviceId, sha256HexUtf8(body))).digest('hex')
}

export function hashOperatorId(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32)
}

/**
 * `licenseToken` is this seat's Operator license, when it has one.
 *
 * Given one, the request is signed with the key derived from it and names its jti, so the license
 * alone authenticates the seat and no shared ingest secret is needed. Without one, `secret` signs,
 * exactly as before. A malformed token is ignored rather than sent: signing with a key the Worker
 * cannot reproduce would fail every request, and falling back to the secret at least keeps a seat
 * that has both working.
 */
export function operatorHmacHeaders(
  secret: string,
  deviceId: string,
  body: string,
  now = Date.now(),
  licenseToken?: string
): Record<string, string> {
  const ts = String(now)
  const nonce = randomUUID()
  const parsed = licenseToken ? parseOperatorLicense(licenseToken) : null
  const signingKey = parsed ? seatKeyFromLicense(licenseToken!.trim()) : secret
  return {
    [OPERATOR_HMAC_HEADERS.ts]: ts,
    [OPERATOR_HMAC_HEADERS.nonce]: nonce,
    [OPERATOR_HMAC_HEADERS.device]: deviceId,
    ...(parsed ? { [OPERATOR_HMAC_HEADERS.license]: parsed.jti } : {}),
    [OPERATOR_HMAC_HEADERS.sig]: signOperatorIngest(signingKey, ts, nonce, deviceId, body)
  }
}
