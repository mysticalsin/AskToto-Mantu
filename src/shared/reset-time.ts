// How Métis says WHEN a spent provider comes back.
//
// A cooldown is not always same-day: a subscription weekly cap parses to ~6.8 days from the CLI's own
// "resets in 164h27m24s" (main/llm/exhaustion.ts), and provider-health clamps only at 8 days. Printing a
// bare clock time for those read as "later today" — MQA-203: the user retried at 9:14 AM every morning for
// a week. Anything past today therefore names the distance in days and the date, not just the hour.

/** Whole local calendar days from `now` to `until`. Midnight-anchored so a DST shift can't shave a day. */
function calendarDaysAhead(now: number, until: number): number {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  const to = new Date(until)
  to.setHours(0, 0, 0, 0)
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/** Human phrase for when a cooldown lifts — "resets ~3:40 PM", "resets tomorrow ~9:14 AM", "resets in 7 days — Mon, Aug 24". */
export function formatResetPhrase(until: number, now: number = Date.now()): string {
  const time = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = calendarDaysAhead(now, until)
  if (days <= 0) return `resets ~${time}`
  if (days === 1) return `resets tomorrow ~${time}`
  // Past tomorrow the clock time is noise and the weekday alone is ambiguous at the 7-8 day end of the
  // range (next Monday reads as today), so lead with the distance and name the date.
  const date = new Date(until).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return `resets in ${days} days — ${date}`
}
