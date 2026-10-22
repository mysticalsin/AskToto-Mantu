/**
 * Device ingest HMAC. Same bytes on the Worker (WebCrypto) and in Electron (node:crypto).
 * Canonical string: `${ts}.${nonce}.${deviceId}.${sha256Hex(body)}`
 */

export const OPERATOR_HMAC_SKEW_MS = 5 * 60 * 1000
export const OPERATOR_LICENSE_HEADER = 'x-metis-license'
/** Embedded enrolment token (METIS-ENR-1.<kid>.<secret>) presented to POST /v1/enroll. Enrolment scope only. */
export const OPERATOR_ENROLL_HEADER = 'x-metis-enroll'
export const OPERATOR_HMAC_HEADERS = {
  ts: 'x-metis-ts',
  nonce: 'x-metis-nonce',
  device: 'x-metis-device',
  sig: 'x-metis-sig'
} as const

export function ingestCanonical(ts: string, nonce: string, deviceId: string, bodySha256Hex: string): string {
  return `${ts}.${nonce}.${deviceId}.${bodySha256Hex}`
}
