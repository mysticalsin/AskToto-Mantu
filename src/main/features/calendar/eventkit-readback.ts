/**
 * Readback rule shared by every calendar create (G65): an event counts as created only when what the provider
 * reports back matches what the owner confirmed. Pure, so Graph and EventKit use the same rule.
 */

const TOLERANCE_MS = 60_000

export interface EventFacts {
  subject: string
  startIso: string
  endIso: string
}

export interface EventReadback extends EventFacts {
  cancelled?: boolean
}

function within(a: string, b: string): boolean {
  const x = Date.parse(a)
  const y = Date.parse(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= TOLERANCE_MS
}

export function matchesReadback(requested: EventFacts, readback: EventReadback): boolean {
  if (readback.cancelled) return false
  return (
    requested.subject.trim() === readback.subject.trim() &&
    within(requested.startIso, readback.startIso) &&
    within(requested.endIso, readback.endIso)
  )
}
