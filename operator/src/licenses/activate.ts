/**
 * License activation: the moment an issued license stops being a string in the console and becomes a
 * seat in the fleet (plan section 6.7, the "Activated seat" column).
 *
 * `issued_licenses.activated_device` and `activated_at` have been in the schema since the table was
 * created (operator/schema.sql), the Licenses page has always rendered them, and the CSV export has
 * always carried them -- but nothing ever wrote them. The only statement that touched `activated_at`
 * was the revoke path's `COALESCE`, which backfills a timestamp for a license being switched off.
 * So a license a seat was actively running on still read "Not yet activated" for its entire life,
 * and the console could not answer the one question the column exists to answer: which machine is
 * this license on. This module is the missing writer.
 *
 * It runs on the seat heartbeat because that is the only moment the Worker learns a device holds a
 * given jti: the desktop stores the token locally (src/main/operator-license-activate.ts) and then
 * reports its `jti` as `licenseId` on every beat. There is no separate "activate" call to hook.
 *
 * First claim wins. A license belongs to the device that activated it; a second device presenting
 * the same token does not silently take it over, so the recorded seat stays the one that got there
 * first and the audit trail keeps a single, stable answer.
 */
import { issuedLicenseActive } from '../fleet'
import type { IssuedLicenseRow, OperatorStore } from '../store'

export interface LicenseClaim {
  /** The row as it now stands, or null when the jti is unknown to this Worker (a token minted by a
   *  different deployment, or one whose row was deleted). Returned so the caller can reuse this read
   *  for tier resolution instead of fetching the identical row a second time on every heartbeat. */
  license: IssuedLicenseRow | null
  /** True only on the beat that actually stamped the row -- used to decide whether to audit. */
  claimed: boolean
}

export async function claimIssuedLicense(
  store: Pick<OperatorStore, 'getIssuedLicense' | 'updateIssuedLicense' | 'audit'>,
  jti: string,
  deviceId: string,
  now: number
): Promise<LicenseClaim> {
  const license = await store.getIssuedLicense(jti)
  if (!license) return { license: null, claimed: false }
  // A revoked or expired license is not activated by presenting it. The fleet already treats it as
  // dead (`issuedLicenseActive`, which gates keys and tier), so stamping it would date an activation
  // that granted nothing -- a row that reads "activated" while the seat it names is locked out.
  if (!issuedLicenseActive(license, now)) return { license, claimed: false }
  if (license.activated_device) return { license, claimed: false }
  await store.updateIssuedLicense(jti, { activated_device: deviceId, activated_at: now })
  // Actor is the device, not an admin: nobody signed in to the console to cause this. `activate-
  // license` contains "license", so classifyAuditGroup files it under Licenses with the mint and
  // revoke rows it belongs next to.
  await store.audit(
    crypto.randomUUID(),
    now,
    deviceId,
    'activate-license',
    null,
    `${license.last4} activated${license.tier ? ` on tier ${license.tier}` : ''}`,
    { route: '/v1/seat/heartbeat' }
  )
  return { license: { ...license, activated_device: deviceId, activated_at: now }, claimed: true }
}
