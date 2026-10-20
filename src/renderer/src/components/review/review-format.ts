import type { MeetingSummary, TranscriptLine } from '@shared/ipc'
import { transcriptDisplayName } from '@shared/speaker-names'

/** Display formatting helpers for the Review surface (times, durations, local-day grouping). */
export function clock(t: number): string {
  try {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

/** Display label for a transcript line's speaker: confirmed/cluster name wins; mic side uses
 *  profile youLabel when provided; else honest You/Them/Unknown (never invent people). */
export function speakerDisplay(l: TranscriptLine, youLabel?: string | null): string {
  return transcriptDisplayName(l, { youLabel })
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatDurationMin(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// Local (not UTC) calendar-day key for a timestamp, as "YYYY-MM-DD" — see the identical helper (and its
// full rationale) in history/recall-view-helpers.ts, which owns this logic. Truncating the raw ISO instant to its first
// 10 characters grabs the UTC date, which is a different calendar day from the local one for roughly
// half of every 24h cycle in any timezone west of UTC, so a meeting saved moments ago could key under
// "yesterday". `toLocaleDateString('en-CA')` formats as plain YYYY-MM-DD using the LOCAL timezone.
export function localDateKey(dateStr: string): string {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr.slice(0, 10)
  return d.toLocaleDateString('en-CA')
}

/** Group an array of MeetingSummary by their LOCAL calendar day. */
export function groupByDate(meetings: MeetingSummary[]): [string, MeetingSummary[]][] {
  const map = new Map<string, MeetingSummary[]>()
  for (const m of meetings) {
    const d = localDateKey(m.date)
    if (!map.has(d)) map.set(d, [])
    map.get(d)!.push(m)
  }
  return Array.from(map.entries())
}

// `dateKey` is a LOCAL "YYYY-MM-DD" string from localDateKey/groupByDate — compared as a plain string
// against today's/yesterday's own local keys (computed the same way), so the comparison never re-enters
// ISO/UTC date parsing. The fallback display date is built from the key's numeric y/m/d via the
// `Date(y, m, d)` constructor, which — unlike `new Date("YYYY-MM-DD")` — constructs local midnight.
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

export function meetingTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
