import type { MeetingExtraction } from './brain'

/**
 * Silence Detector (innovation #4) — what an account STOPPED saying.
 *
 * Absence is the one signal a transcript-only competitor structurally cannot compute: it needs a
 * longitudinal record of what was discussed across meetings, which only the brain has. For each account
 * we compare a RECENT window against a PRIOR window and surface what fell out — themes that vanished,
 * champions who stopped showing up, warmth that cooled, or a relationship that went entirely quiet.
 *
 * Pure and deterministic: `now` is passed in (never read from the clock) so the same inputs always give
 * the same output — the renderer stamps the real time, tests pin it. No I/O; operates on the meeting
 * extractions the dashboard already loads.
 */

const DAY = 24 * 60 * 60 * 1000
const RECENT_DAYS = 45 // "this month-ish": the current state of the relationship
const PRIOR_DAYS = 180 // look back up to ~two quarters for what used to be active
const SENTIMENT_SCORE: Record<string, number> = { good: 1, mixed: 0, concerning: -1 }

export interface DroppedTopic {
  topic: string
  priorMentions: number // how many prior-window meetings raised it — a persistent theme vanishing matters more
}

export interface AccountSilence {
  account: string
  sector: string
  meetings: number // total dated meetings considered
  lastMeetingDate: string
  daysQuiet: number // days since the most recent meeting with this account
  wentDark: boolean // no meeting at all inside the recent window while there was prior activity
  droppedTopics: DroppedTopic[]
  vanishedPeople: string[] // named in prior meetings, absent from every recent one
  cooling: boolean // average sentiment fell from the prior window to the recent one
}

interface Dated {
  date: number
  dateStr: string
  topics: string[]
  people: string[]
  sentiment: string
}

function parseDate(d: string | undefined): number {
  if (!d) return NaN
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? t : NaN
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

function uniqueByNorm(values: string[]): string[] {
  const seen = new Map<string, string>() // normalized → first original casing
  for (const v of values) {
    const k = norm(v)
    if (k && !seen.has(k)) seen.set(k, v.trim())
  }
  return [...seen.values()]
}

/** Signals for one account, or null when nothing changed enough to be worth surfacing. */
function silenceForAccount(name: string, sector: string, rows: Dated[], now: number): AccountSilence | null {
  const dated = rows.filter((r) => Number.isFinite(r.date)).sort((a, b) => a.date - b.date)
  if (dated.length < 2) return null // need history to detect a change

  const last = dated[dated.length - 1]
  const recentCutoff = now - RECENT_DAYS * DAY
  const priorCutoff = now - PRIOR_DAYS * DAY
  const recent = dated.filter((r) => r.date >= recentCutoff)
  const prior = dated.filter((r) => r.date < recentCutoff && r.date >= priorCutoff)
  if (prior.length === 0) return null // nothing to compare against in the look-back window

  const daysQuiet = Math.max(0, Math.floor((now - last.date) / DAY))
  const wentDark = recent.length === 0

  // Topics/people present recently — when the account went dark, "recent" is empty, so everything
  // active in the prior window reads as dropped (which is the correct signal for a silent relationship).
  const recentTopics = new Set(recent.flatMap((r) => r.topics.map(norm)).filter(Boolean))
  const recentPeople = new Set(recent.flatMap((r) => r.people.map(norm)).filter(Boolean))

  const priorTopicCounts = new Map<string, { count: number; label: string }>()
  for (const r of prior) {
    for (const t of uniqueByNorm(r.topics)) {
      const k = norm(t)
      const e = priorTopicCounts.get(k) ?? { count: 0, label: t }
      e.count += 1
      priorTopicCounts.set(k, e)
    }
  }
  const droppedTopics: DroppedTopic[] = [...priorTopicCounts.entries()]
    .filter(([k]) => !recentTopics.has(k))
    .map(([, v]) => ({ topic: v.label, priorMentions: v.count }))
    .sort((a, b) => b.priorMentions - a.priorMentions)

  const priorPeople = uniqueByNorm(prior.flatMap((r) => r.people))
  const vanishedPeople = priorPeople.filter((p) => !recentPeople.has(norm(p)))

  const avg = (rs: Dated[]): number =>
    rs.length ? rs.reduce((sum, r) => sum + (SENTIMENT_SCORE[r.sentiment] ?? 0), 0) / rs.length : 0
  const cooling = recent.length > 0 && avg(recent) < avg(prior) - 0.5

  const hasSignal = wentDark || droppedTopics.length > 0 || vanishedPeople.length > 0 || cooling
  if (!hasSignal) return null

  return {
    account: name,
    sector,
    meetings: dated.length,
    lastMeetingDate: last.dateStr,
    daysQuiet,
    wentDark,
    droppedTopics,
    vanishedPeople,
    cooling
  }
}

/**
 * Compute silence signals across all accounts, most-urgent first (fully-dark relationships, then the
 * longest-quiet). `now` is injected so the result is deterministic and testable.
 */
export function computeSilence(extractions: MeetingExtraction[], now: number): AccountSilence[] {
  const byAccount = new Map<string, { name: string; sector: string; rows: Dated[] }>()
  for (const x of extractions) {
    if (!x.account?.name) continue
    const key = norm(x.account.name)
    const date = parseDate(x.date)
    if (!Number.isFinite(date)) continue // undated extraction can't sit on a timeline
    const bucket = byAccount.get(key) ?? { name: x.account.name.trim(), sector: x.account.sector || 'other', rows: [] }
    bucket.rows.push({
      date,
      dateStr: x.date,
      topics: x.topics ?? [],
      people: (x.people ?? []).map((p) => p.name),
      sentiment: x.sentiment
    })
    byAccount.set(key, bucket)
  }

  const out: AccountSilence[] = []
  for (const { name, sector, rows } of byAccount.values()) {
    const sig = silenceForAccount(name, sector, rows, now)
    if (sig) out.push(sig)
  }
  return out.sort((a, b) => Number(b.wentDark) - Number(a.wentDark) || b.daysQuiet - a.daysQuiet)
}
