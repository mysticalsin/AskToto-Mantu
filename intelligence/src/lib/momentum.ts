/**
 * Momentum — the time dimension the dashboard has never had. Everything else in this app answers
 * "what is true right now"; these three functions answer "is it moving, and which way". Pure
 * functions only: `now` (epoch ms) is always injected by the caller, never read from the clock here,
 * so every result is exactly reproducible in a test and inside a snapshot-consistent render.
 *
 * Deliberately independent of brainAdapter.ts / types/data.ts: callers (dashboard views) pass in
 * whatever shape of meeting data they already have — this file only requires the handful of fields
 * it actually reads, declared locally below. That keeps this lib reusable and trivially testable
 * without dragging in the adapter's brain-shape types.
 */

/** The minimal shape every function below needs — a superset of the fields each one actually reads. */
export interface MeetingLike {
  date?: string
  sentiment?: string
  topics?: string[]
  account?: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/**
 * Parses a leading `YYYY-MM-DD` off a date string as a UTC midnight timestamp, rejecting anything
 * that isn't a real calendar date (JS's `Date.UTC` silently normalizes out-of-range components,
 * e.g. month 13 rolls into next year, so the round-trip check below is load-bearing, not decorative).
 * Returns null for missing/unparseable/invalid dates — callers treat that as "undated".
 */
function parseDateUTC(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const t = Date.UTC(year, month - 1, day)
  const check = new Date(t)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return t
}

/** Monday 00:00:00 UTC of the ISO week containing `ms` (ISO weeks run Monday–Sunday). */
function isoWeekStartUTC(ms: number): number {
  const d = new Date(ms)
  const day = d.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const mondayOffset = day === 0 ? -6 : 1 - day
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + mondayOffset)
}

function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export interface WeekBucket {
  weekStartISO: string
  count: number
}

export interface MeetingsPerWeekResult {
  /** Zero-filled, oldest → newest, always exactly `weeks` entries, the last one being now's ISO week. */
  buckets: WeekBucket[]
  /** Meetings with no valid date — excluded from `buckets` entirely, counted here instead. */
  undated: number
}

/**
 * Buckets meetings into `weeks` consecutive ISO weeks ending at the week containing `now`. Weeks with
 * no meetings are zero-filled (a real cadence chart cannot skip silent weeks). Meetings whose date
 * falls outside the window are simply not counted by any bucket (this is a fixed-width recent window,
 * not a full-history one) — only genuinely undated meetings are pulled out into `undated`.
 */
export function meetingsPerWeek(meetings: MeetingLike[], now: number, weeks = 12): MeetingsPerWeekResult {
  const nowWeekStart = isoWeekStartUTC(now)
  const bucketStarts: number[] = []
  for (let i = weeks - 1; i >= 0; i--) bucketStarts.push(nowWeekStart - i * WEEK_MS)

  const counts = new Map<number, number>(bucketStarts.map((s) => [s, 0]))
  let undated = 0
  for (const meeting of meetings) {
    const t = meeting.date ? parseDateUTC(meeting.date) : null
    if (t === null) {
      undated++
      continue
    }
    const weekStart = isoWeekStartUTC(t)
    if (counts.has(weekStart)) counts.set(weekStart, counts.get(weekStart)! + 1)
  }

  const buckets = bucketStarts.map((s) => ({ weekStartISO: toISODate(s), count: counts.get(s)! }))
  return { buckets, undated }
}

export interface SentimentPoint {
  date: string
  score: number
}

/** Vocabulary matches the real extraction pipeline's bands (good/mixed/concerning) plus the more
 *  generic positive/neutral/negative a caller might already have normalized to. Anything else (or
 *  missing) is skipped rather than guessed at — a null read must never render as a false "neutral". */
function sentimentScore(sentiment: string | undefined): number | null {
  if (!sentiment) return null
  const v = sentiment.toLowerCase()
  if (v === 'positive' || v === 'good') return 1
  if (v === 'neutral' || v === 'mixed') return 0
  if (v === 'negative' || v === 'concerning') return -1
  return null
}

/** Dated, scoreable meetings only, sorted oldest → newest. Undated or unrecognized-sentiment
 *  meetings are skipped (never coerced into a fake neutral point). */
export function sentimentSeries(meetings: MeetingLike[]): SentimentPoint[] {
  const out: SentimentPoint[] = []
  for (const meeting of meetings) {
    if (!meeting.date) continue
    const score = sentimentScore(meeting.sentiment)
    if (score === null) continue
    out.push({ date: meeting.date.slice(0, 10), score })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

export interface RollingPoint {
  date: string
  avg: number
}

/** Trailing rolling average over the last `k` points (fewer at the start of the series — no
 *  look-ahead, no padding with invented zeros). Same length and date-alignment as `series`. */
export function rollingAverage(series: SentimentPoint[], k = 3): RollingPoint[] {
  const out: RollingPoint[] = []
  for (let i = 0; i < series.length; i++) {
    const window = series.slice(Math.max(0, i - k + 1), i + 1)
    const sum = window.reduce((acc, p) => acc + p.score, 0)
    out.push({ date: series[i].date, avg: sum / window.length })
  }
  return out
}

export interface AccountCadence {
  account: string
  count: number
  lastDate: string
  daysSinceLast: number
  /** count / (days since the account's first dated meeting, in months) — a full-tenure rate, so a
   *  cooling account's cadence visibly declines rather than freezing at its old peak frequency. */
  meetingsPerMonth: number
}

/** Per-account meeting cadence, sorted stalest-first (longest quiet first) — the same "entropy is
 *  visible" framing as the Going-Cold engine, one level up at the account-momentum layer. Meetings
 *  missing an account or a valid date are excluded (cadence needs both to mean anything). */
export function accountCadence(meetings: MeetingLike[], now: number): AccountCadence[] {
  const datesByAccount = new Map<string, number[]>()
  for (const meeting of meetings) {
    if (!meeting.account || !meeting.date) continue
    const t = parseDateUTC(meeting.date)
    if (t === null) continue
    const list = datesByAccount.get(meeting.account) ?? []
    list.push(t)
    datesByAccount.set(meeting.account, list)
  }

  const out: AccountCadence[] = []
  for (const [account, datesRaw] of datesByAccount) {
    const dates = [...datesRaw].sort((a, b) => a - b)
    const first = dates[0]
    const last = dates[dates.length - 1]
    const count = dates.length
    const daysSinceLast = Math.max(0, (now - last) / DAY_MS)
    const tenureDays = Math.max(1, (now - first) / DAY_MS)
    out.push({
      account,
      count,
      lastDate: toISODate(last),
      daysSinceLast: Math.floor(daysSinceLast),
      meetingsPerMonth: (count / tenureDays) * 30
    })
  }

  out.sort((a, b) => b.daysSinceLast - a.daysSinceLast)
  return out
}
