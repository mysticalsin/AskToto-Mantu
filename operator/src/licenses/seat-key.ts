/**
 * Resolves the key that verifies a seat's request when that seat signs as a license.
 *
 * Until now a seat needed OPERATOR_INGEST_SECRET -- the Worker's own signing secret -- typed into
 * Settings before it could talk to the Operator at all. Two things followed. A license key was
 * useless on its own: the thing generated for a seat could not put that seat online, which is
 * exactly the failure Tony hit, generating keys and watching nothing happen. And every seat shared
 * one secret, so any seat could sign a heartbeat claiming any other seat's license id, which made
 * `licenseId` a claim rather than a credential.
 *
 * The fix is to let the license be the credential. Its signature is a deterministic HMAC over
 * `jti.iat.exp`, and `issued_licenses` stores those three claims, so the Worker can rebuild the
 * exact token it handed out without ever having stored it, and derive the same per-seat key the
 * desktop derives from the token in its hand. Neither the token nor the ingest secret is ever sent.
 *
 * A seat can therefore only sign as the license it actually holds, and a license alone is enough to
 * bring a seat online. The shared-secret path is untouched for seats that still use it.
 */
import { sha256Hex } from '../crypto'
import {
  operatorSeatKeyFromLicense,
  rebuildOperatorLicenseToken
} from '../../../src/shared/operator-license'
import { issuedLicenseActive } from '../fleet'
import type { OperatorStore } from '../store'

export interface SeatKeyResolution {
  /** The HMAC key this request must be signed with, or null when the license cannot sign at all. */
  key: string | null
  /** Why not, for the 401 body. Never leaks whether a jti exists: see `reason` handling below. */
  reason?: 'unknown' | 'inactive' | 'mismatch'
}

/**
 * `ingestSecret` is the Worker's own OPERATOR_INGEST_SECRET, used here only to reproduce the
 * license signature -- it is never compared against anything the caller sent.
 */
export async function seatKeyForLicense(
  store: Pick<OperatorStore, 'getIssuedLicense'>,
  ingestSecret: string,
  jti: string,
  now: number
): Promise<SeatKeyResolution> {
  if (!ingestSecret) return { key: null, reason: 'unknown' }
  const row = await store.getIssuedLicense(jti)
  if (!row) return { key: null, reason: 'unknown' }
  // A revoked or expired license stops being able to sign the moment it stops being active, which
  // is what makes revocation actually cut a seat off rather than merely mark it in the console.
  if (!issuedLicenseActive(row, now)) return { key: null, reason: 'inactive' }
  const token = await rebuildOperatorLicenseToken(ingestSecret, { jti: row.jti, iat: row.iat, exp: row.exp })
  // Proof that the rebuild is the real token: `key_hash` is the sha256 of the string that was
  // actually handed out. If they disagree the row predates this scheme, was minted under a rotated
  // secret, or was tampered with -- in every case the derived key would be wrong, so refuse rather
  // than hand back a key that cannot verify anything.
  if ((await sha256Hex(token)) !== row.key_hash) return { key: null, reason: 'mismatch' }
  return { key: await operatorSeatKeyFromLicense(token) }
}
