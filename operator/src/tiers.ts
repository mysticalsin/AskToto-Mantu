/**
 * Tier + entitlement resolution shared by heartbeat, live-seats, sessions and the seat-facing
 * integrations route (section 9c). An active Operator-issued license carries its own `tier`
 * (falling back to `metis` for one minted before Groups shipped); otherwise a plain Approved seat
 * is `metis`; otherwise there is no tier and no entitlements. Entitlements come from the `tiers`
 * table when a row exists for the resolved tier, else the section-9c plan defaults.
 */
import { isApprovedSeat, issuedLicenseActive, parseLicenseId } from './fleet'
import { DEFAULT_TIER_ENTITLEMENTS, type OperatorStore, type SeatRow, type TierRow } from './store'

export interface ResolvedTier {
  tier: string | null
  entitlements: string[]
}

export async function resolveTierAndEntitlements(
  store: Pick<OperatorStore, 'getIssuedLicense' | 'listTiers'>,
  seat: Pick<SeatRow, 'approval' | 'license' | 'license_jti'>,
  now: number,
  tiersPreloaded?: TierRow[]
): Promise<ResolvedTier> {
  let tier: string | null = null
  const jti = parseLicenseId(seat.license_jti)
  if (jti) {
    const issued = await store.getIssuedLicense(jti)
    if (issuedLicenseActive(issued, now)) tier = issued?.tier ?? 'metis'
  }
  if (!tier && isApprovedSeat(seat)) tier = 'metis'
  if (!tier) return { tier: null, entitlements: [] }
  const tiers = tiersPreloaded ?? (await store.listTiers())
  const tierRow = tiers.find((r) => r.id === tier)
  if (tierRow) {
    try {
      const entitlements = JSON.parse(tierRow.entitlements_json) as unknown
      if (Array.isArray(entitlements)) return { tier, entitlements: entitlements.filter((e) => typeof e === 'string') }
    } catch {
      /* fall through to the plan defaults */
    }
  }
  return { tier, entitlements: DEFAULT_TIER_ENTITLEMENTS[tier] ?? [] }
}
