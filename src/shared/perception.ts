/** Human-readable screen-capture freshness for trust UI.
 *
 * Input timestamps are epoch milliseconds. The formatter is intentionally conservative and never
 * fabricates sub-frame precision: "Seen now" for fresh/skewed captures, one decimal under 1s, whole
 * seconds after that.
 */
export function formatScreenFreshness(capturedAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - capturedAt)
  if (ageMs < 250) return 'Seen now'
  if (ageMs < 1000) return `Seen ${(ageMs / 1000).toFixed(1)}s ago`
  return `Seen ${Math.round(ageMs / 1000)}s ago`
}
