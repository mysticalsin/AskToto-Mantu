/** How long main's single-use meeting-start grant lives after the trusted click that minted it. */
export const MEETING_START_GRANT_TTL_MS = 5_000

/** A second of margin: a start attempted this close to the end is not worth racing the grant. */
const GRANT_MARGIN_MS = 1_000

/** Whether the grant minted at `clickedAt` has probably run out by `now`. */
export function startGrantLikelyExpired(clickedAt: number, now: number): boolean {
  return now - clickedAt >= MEETING_START_GRANT_TTL_MS - GRANT_MARGIN_MS
}
