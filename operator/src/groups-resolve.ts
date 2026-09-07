/**
 * Pure helper: does a seat resolve to a group/tier through its active Operator-issued license?
 * Kept dependency-free (no fleet.ts import) so it can be unit tested without a store. A seat can
 * also resolve to a group through group_members (email/device match); that lookup needs the
 * members list and lives in the store layer (OperatorStore#listGroupMembers), not here.
 */

export interface SeatGroupInput {
  device_id: string
  license_jti?: string | null
}

export interface IssuedLicenseGroupInput {
  jti: string
  revoked: number
  exp: number
  group_id?: string | null
  tier?: string | null
}

export interface ResolvedGroup {
  groupId: string
  tier: string
}

/** Default tier assigned when an issued license carries a group but no explicit tier. */
export const DEFAULT_TIER = 'metis'

export function resolveSeatGroup(
  seat: SeatGroupInput,
  issued: IssuedLicenseGroupInput | null,
  now = Date.now()
): ResolvedGroup | null {
  if (!seat || !issued) return null
  if (issued.revoked) return null
  if (issued.exp * 1000 <= now) return null
  if (!issued.group_id) return null
  return { groupId: issued.group_id, tier: issued.tier || DEFAULT_TIER }
}
