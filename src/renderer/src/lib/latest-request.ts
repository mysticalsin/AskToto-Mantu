/**
 * A last-request-wins gate for an async action whose slower, older answer must not replace a newer one
 * (opening a meeting from History: a cloud-only download can finish after the person has clicked another
 * meeting). `begin()` returns a token before the await; `isLatest(token)` is checked after it, and only the
 * newest token passes. `cancel()` invalidates the request in flight, for a caller that leaves the surface.
 */
export interface LatestRequestGate {
  begin(): number
  isLatest(token: number): boolean
  cancel(): void
}

export function createLatestGate(): LatestRequestGate {
  let latest = 0
  return {
    begin: () => ++latest,
    isLatest: (token) => token === latest,
    cancel: () => {
      latest++
    }
  }
}
