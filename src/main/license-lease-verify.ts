/**
 * license-lease-verify.ts — pure Ed25519 verification of the license server's compact offline "lease"
 * token (license-server/lib/lease.mjs, README.md's "Offline leases and license-gate flags" section).
 *
 * Deliberately Electron-free (no `app`, no settings, no I/O) so this is trivially unit-testable and
 * usable from a plain `node --test` script if the server side ever wants to share it. `license.ts` is
 * the only caller inside this app — it supplies the bundled public key (license-lease-key.ts) and the
 * settings-backed token.
 *
 * WIRE FORMAT (must match the server byte-for-byte — this is not our format to change unilaterally):
 *   `<base64url(JSON payload)>.<base64url(signature)>`
 * where payload is `{ licenseKey, machineId, companyName, seatCap, issuedAt, notAfter }` (all set by the
 * server; see license-server/lib/app.mjs's `issueLease`). The signature covers the exact base64url
 * PAYLOAD BYTES (not the re-serialized JSON), so a byte-identical re-derivation is required before the
 * parsed object is ever trusted — verifyLeaseToken checks the signature first and only parses JSON after
 * it passes.
 *
 * Ed25519 has no separate hash step: `verify(null, data, key, signature)` is the documented Node API
 * for it (https://nodejs.org/api/crypto.html#sign-algorithm-data-key) — same convention the server's
 * lib/lease.mjs uses. No new dependency either side of the wire.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto'

export const LEASE_ALGORITHM = 'ed25519'

/** The exact shape the server signs (license-server/lib/app.mjs `issueLease`). */
export interface LeasePayload {
  licenseKey: string
  machineId: string
  companyName: string
  seatCap: number
  issuedAt: number
  notAfter: number
}

/** True only when every field is present with the type the server always sends — guards against a
 *  syntactically-valid-JSON, signature-valid (e.g. a lease signed for some OTHER payload shape by a
 *  legitimate-looking but foreign key) payload that isn't actually a lease this app can reason about. */
function isLeasePayload(v: unknown): v is LeasePayload {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.licenseKey === 'string' &&
    typeof p.machineId === 'string' &&
    typeof p.companyName === 'string' &&
    typeof p.seatCap === 'number' &&
    typeof p.issuedAt === 'number' &&
    typeof p.notAfter === 'number'
  )
}

/** Reconstructs a public KeyObject from the raw base64url form (`GET /license/pubkey`'s `publicKey`
 *  field, or license-lease-key.ts's bundled value — the JWK `x` value for an OKP/Ed25519 key IS exactly
 *  that raw 32-byte key, base64url-encoded). No PEM/DER parsing needed. */
export function rawToPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' })
}

/**
 * Verifies + parses a compact lease token against a raw base64url Ed25519 public key. Returns the typed
 * payload on success, or `null` on ANY failure — wrong shape, bad base64, a signature that doesn't match
 * (wrong key, tampered payload, tampered signature), or JSON that parses but isn't a lease payload.
 * Deliberately NEVER throws on attacker-controlled input: every caller gets one boolean-ish surface
 * (`const payload = verifyLeaseToken(token, key); if (!payload) { ...reject... }`), exactly mirroring
 * the server's own `verifyLease` (license-server/lib/lease.mjs) so the two sides can't disagree on what
 * counts as valid.
 */
export function verifyLeaseToken(token: string, publicKeyRaw: string): LeasePayload | null {
  if (typeof token !== 'string' || !token) return null
  if (typeof publicKeyRaw !== 'string' || !publicKeyRaw) return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  let key: KeyObject
  try {
    key = rawToPublicKey(publicKeyRaw)
  } catch {
    return null
  }

  let signature: Buffer
  try {
    signature = Buffer.from(sigB64, 'base64url')
  } catch {
    return null
  }
  if (signature.length === 0) return null

  let signatureValid: boolean
  try {
    signatureValid = verify(null, Buffer.from(payloadB64, 'utf8'), key, signature)
  } catch {
    return null
  }
  if (!signatureValid) return null

  try {
    const json = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    return isLeasePayload(json) ? json : null
  } catch {
    return null
  }
}

/** Is this (already-verified) payload still inside its validity window right now? A separate step from
 *  verifyLeaseToken so callers that need to log/display an EXPIRED-but-authentic lease (e.g. Settings'
 *  "your lease expired on …" copy) can still tell it apart from a lease that never verified at all. */
export function isLeaseValidNow(payload: LeasePayload | null, now: number = Date.now()): boolean {
  return !!payload && Number.isFinite(payload.notAfter) && payload.notAfter > now
}
