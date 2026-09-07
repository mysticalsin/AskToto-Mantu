/**
 * Device ingest HMAC. Same bytes on the Worker (WebCrypto) and in Electron (node:crypto).
 * Canonical string: `${ts}.${nonce}.${deviceId}.${sha256Hex(body)}`
 */

export const OPERATOR_HMAC_SKEW_MS = 5 * 60 * 1000
export const OPERATOR_HMAC_HEADERS = {
  ts: 'x-metis-ts',
  nonce: 'x-metis-nonce',
  device: 'x-metis-device',
  sig: 'x-metis-sig',
  /**
   * The license id (jti) this request is signed as, when the seat holds an Operator license.
   *
   * Its presence switches which key verifies the signature: with it, the Worker rebuilds that
   * license's token from the claims it stored and derives the same per-seat key the desktop did
   * (see OPERATOR_SEAT_KEY_INFO in operator-license.ts); without it, the shared
   * OPERATOR_INGEST_SECRET verifies, exactly as before. It carries no authority of its own -- a
   * request naming a license it cannot sign for fails the HMAC like any other forgery.
   */
  license: 'x-metis-license'
} as const

export function ingestCanonical(ts: string, nonce: string, deviceId: string, bodySha256Hex: string): string {
  return `${ts}.${nonce}.${deviceId}.${bodySha256Hex}`
}
