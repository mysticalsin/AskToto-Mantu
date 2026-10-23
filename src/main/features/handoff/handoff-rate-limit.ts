/**
 * Rate limit for outside handoffs (G37). A handoff is unauthenticated, so main caps how often one may put a card in
 * front of the owner. PROPOSED numbers (not yet owner-approved): at most 1 per 10 s and 3 per 5 min.
 */
export const HANDOFF_MIN_GAP_MS = 10_000
export const HANDOFF_WINDOW_MS = 5 * 60_000
export const HANDOFF_WINDOW_MAX = 3

export interface HandoffRateLimit {
  /** True and records the attempt when allowed. */
  take(now: number): boolean
}

export function createHandoffRateLimit(): HandoffRateLimit {
  let taken: number[] = []
  return {
    take(now) {
      taken = taken.filter((at) => now - at < HANDOFF_WINDOW_MS)
      const last = taken[taken.length - 1]
      if (taken.length >= HANDOFF_WINDOW_MAX || (last !== undefined && now - last < HANDOFF_MIN_GAP_MS)) return false
      taken.push(now)
      return true
    }
  }
}
