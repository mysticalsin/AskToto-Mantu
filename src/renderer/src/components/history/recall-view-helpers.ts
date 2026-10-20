import type { MeetingSummary, RecallHit } from '@shared/ipc'

// ---------------------------------------------------------------------------
// Helpers duplicated from Review.tsx — DO NOT edit Review.tsx; it owns these.
// Exception: the local-date-grouping helpers below (localDateKey / groupByLocalDate / friendlyDate)
// had a same-shaped UTC/local mismatch bug in both copies, so both were fixed in lockstep — see the
// identical (unexported) copy in Review.tsx's "Recent meetings" panel.
// ---------------------------------------------------------------------------

export function formatDurationMin(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function meetingTime(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Local (not UTC) calendar-day key for a timestamp, as "YYYY-MM-DD". Meetings are saved with a full
 * ISO instant (e.g. "2026-07-02T17:50:34.312Z"); truncating that string to its first 10 characters
 * grabs the UTC date, which is a different calendar day from the local one for roughly half of every
 * 24h cycle in any timezone west of UTC — so a meeting saved moments ago could key under "yesterday".
 * `toLocaleDateString('en-CA')` formats as plain YYYY-MM-DD using the LOCAL timezone, which keeps the
 * key anchored to the same wall-clock day the user actually sees. Exported for unit testing.
 */
export function localDateKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr.slice(0, 10)
  return d.toLocaleDateString('en-CA')
}

/** Group meetings by their LOCAL calendar day. Exported for unit testing. */
export function groupByLocalDate(meetings: (MeetingSummary | RecallHit)[]): [string, (MeetingSummary | RecallHit)[]][] {
  const map = new Map<string, (MeetingSummary | RecallHit)[]>()
  for (const m of meetings) {
    const d = localDateKey(m.date)
    if (!map.has(d)) map.set(d, [])
    map.get(d)!.push(m)
  }
  return Array.from(map.entries())
}

/**
 * `dateKey` is a LOCAL "YYYY-MM-DD" string from `localDateKey`/`groupByLocalDate` — compared as a
 * plain string against today's/yesterday's own local keys (computed the same way), so the comparison
 * never re-enters ISO/UTC date parsing. The fallback display date is built from the key's numeric
 * y/m/d via the `Date(y, m, d)` constructor, which — unlike `new Date("YYYY-MM-DD")` — is specified to
 * construct local midnight, not UTC midnight. Exported for unit testing.
 */
export function friendlyDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return dateKey
  const today = new Date()
  if (dateKey === today.toLocaleDateString('en-CA')) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dateKey === yesterday.toLocaleDateString('en-CA')) return 'Yesterday'
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/** "1 meeting" / "2 meetings" (or an irregular plural like "person" → "people") — the Intelligence strip's
 *  counts below used to always render the plural noun, reading as "1 meetings · 1 people · 0 accounts". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

// T6 6d — per-meeting Mantu Intelligence status: the smallest-possible dot+tooltip on each row.
export type MeetingIndexStatus = 'indexed' | 'pending' | 'failed'

/** indexed (in the brain, ok) / failed (last extraction returned ok:false) / pending (a backfill/live
 *  ingest was requested but this file hasn't settled either way yet) / null (no ingest signal at all —
 *  brain status hasn't loaded yet, or a backfill was never requested). Exported for unit testing. */
export function meetingIndexStatus(
  file: string,
  ingest: { indexed: ReadonlySet<string>; failed: ReadonlySet<string>; backfillRequested: boolean } | null
): MeetingIndexStatus | null {
  if (!ingest) return null
  if (ingest.indexed.has(file)) return 'indexed'
  if (ingest.failed.has(file)) return 'failed'
  return ingest.backfillRequested ? 'pending' : null
}
