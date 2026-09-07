/**
 * Small view helpers shared by the admin route modules that join a stored event/session row to its
 * seat for display (hostname, email, city). Used by events.ts, sessions.ts and live.ts. Kept out of
 * dashboard.ts (which has its own private, differently-shaped equivalents) so these route modules
 * don't reach into dashboard.ts's internals for a four-line helper.
 */
import { looksLikeSecret } from '../redact'
import type { OperatorStore, SeatRow } from '../store'

export function profileOf(seat: SeatRow | null | undefined): { hostname: string | null; email: string | null } {
  return {
    hostname: seat?.hostname && !looksLikeSecret(seat.hostname) ? seat.hostname : null,
    email: seat?.sso_email && !looksLikeSecret(seat.sso_email) ? seat.sso_email : null
  }
}

export function safeCity(seat: Pick<SeatRow, 'city'> | null | undefined): string | null {
  return seat?.city && !looksLikeSecret(seat.city) ? seat.city : null
}

/** Memoized `getSeat` for the lifetime of one request: a page with several rows for the same device
 *  only fetches it once. */
export function seatCache(store: Pick<OperatorStore, 'getSeat'>): (deviceId: string) => Promise<SeatRow | null> {
  const cache = new Map<string, Promise<SeatRow | null>>()
  return (deviceId: string) => {
    let p = cache.get(deviceId)
    if (!p) {
      p = store.getSeat(deviceId)
      cache.set(deviceId, p)
    }
    return p
  }
}
