/**
 * Server-defined usage meters published on the heartbeat (G79, CAP-33, D-16).
 *
 * One meter today: `managed_tokens`, the seat's Portal-proxied token use since 00:00 UTC against the admin's
 * `dailyTokenBudgetPerSeat` setting. The Worker publishes the number; the desktop never invents one.
 * Enforcement of the budget on proxied asks and reconciliation are G81, not here. `used` is null, never 0,
 * when it cannot be counted.
 */
import { resolveTierAndEntitlements } from './tiers'
import { validateSettingValue } from './routes/settings-store'
import type { OperatorStore, SeatRow } from './store'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SeatMeter {
  id: string
  label: string
  unit: 'tokens'
  limit: number
  used: number | null
  resetAt: number
  window: 'day'
}

export function utcMidnight(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

export function nextUtcMidnight(now: number): number {
  return utcMidnight(now) + DAY_MS
}

async function dailyBudget(store: Pick<OperatorStore, 'getSetting'>): Promise<number | null> {
  try {
    const raw = await store.getSetting('dailyTokenBudgetPerSeat')
    if (raw === null) return null
    const value = validateSettingValue('dailyTokenBudgetPerSeat', JSON.parse(raw) as unknown)
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

/** `deviceId` is always the HMAC-verified device, never a body field. */
export async function resolveSeatMeters(
  store: Pick<OperatorStore, 'getSetting' | 'getIssuedLicense' | 'listTiers' | 'sumSeatManagedTokensSince'>,
  seat: Pick<SeatRow, 'approval' | 'license' | 'license_jti'>,
  deviceId: string,
  now: number
): Promise<SeatMeter[]> {
  const { entitlements } = await resolveTierAndEntitlements(store, seat, now)
  if (!entitlements.includes('operator_keys')) return []
  const limit = await dailyBudget(store)
  if (limit === null) return []
  let used: number | null
  try {
    used = await store.sumSeatManagedTokensSince(deviceId, utcMidnight(now))
  } catch {
    used = null
  }
  return [
    {
      id: 'managed_tokens',
      label: 'Managed AI tokens',
      unit: 'tokens',
      limit,
      used,
      resetAt: nextUtcMidnight(now),
      window: 'day'
    }
  ]
}
