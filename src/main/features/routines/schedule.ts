/**
 * Routine schedule math (G66, R074). Civil time in an IANA zone, never a fixed UTC offset: a daily 09:00 stays 09:00 on
 * the wall clock across both DST edges. Only `Intl` is used, so there is no new dependency.
 *
 * - A local time that does not exist (spring forward) moves to the first valid minute after the gap.
 * - A local time that happens twice (fall back) uses the earlier instant.
 * - An occurrence is named by its civil key `YYYY-MM-DDTHH:MM@<zone>`, which is stable across a zone-rule change.
 */

export type Cadence = 'daily' | 'weekdays' | 'weekly'

export type RoutineSchedule =
  | { kind: 'once'; date: string; time: string; timeZone: string }
  | { kind: 'recurring'; cadence: Cadence; weekdays?: number[]; time: string; timeZone: string }

export interface Occurrence {
  /** `YYYY-MM-DDTHH:MM@<zone>`. */
  key: string
  dueAt: number
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const MAX_SCAN_DAYS = 400
export const SCHEDULE_PHRASE_MAX_CHARS = 120

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export function validDate(date: string): boolean {
  const m = DATE.exec(date)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}
export const validTime = (time: string): boolean => TIME.test(time)

const formatters = new Map<string, Intl.DateTimeFormat | null>()
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (formatters.has(timeZone)) return formatters.get(timeZone) ?? null
  let made: Intl.DateTimeFormat | null = null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    made = null
  }
  if (formatters.size > 64) formatters.clear()
  formatters.set(timeZone, made)
  return made
}

export function validTimeZone(timeZone: string): boolean {
  return timeZone.length > 0 && timeZone.length <= 64 && formatterFor(timeZone) !== null
}

/** The wall-clock fields of an instant in a zone. */
export function civilOf(instant: number, timeZone: string): { date: string; time: string; utcLike: number } {
  const parts = formatterFor(timeZone)!.formatToParts(new Date(instant))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const [y, mo, d, h, mi, s] = [get('year'), get('month'), get('day'), get('hour') % 24, get('minute'), get('second')]
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return {
    date: `${pad(y, 4)}-${pad(mo)}-${pad(d)}`,
    time: `${pad(h)}:${pad(mi)}`,
    utcLike: Date.UTC(y, mo - 1, d, h, mi, s)
  }
}

/** Offset east of UTC in minutes at an instant. */
const offsetMinutes = (instant: number, timeZone: string): number =>
  Math.round((civilOf(instant, timeZone).utcLike - Math.floor(instant / 1000) * 1000) / MINUTE)

const minuteFloor = (instant: number): number => Math.floor(instant / MINUTE) * MINUTE

/** Maps a civil date and time to an instant, resolving a DST gap forward and an overlap to the earlier instant. */
export function civilToInstant(date: string, time: string, timeZone: string): number {
  const m = DATE.exec(date)!
  const t = TIME.exec(time)!
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]))
  const offsets = new Set([offsetMinutes(guess - DAY, timeZone), offsetMinutes(guess + DAY, timeZone)])
  const candidates = [...offsets].map((off) => guess - off * MINUTE)
  const wanted = `${date}T${time}`
  const valid = candidates.filter((c) => {
    const civil = civilOf(c, timeZone)
    return `${civil.date}T${civil.time}` === wanted
  })
  if (valid.length > 0) return Math.min(...valid)
  // A gap: find the transition minute between the two candidate instants (the first instant on the later offset).
  let lo = Math.min(...candidates)
  let hi = Math.max(...candidates)
  const before = offsetMinutes(lo, timeZone)
  while (hi - lo > MINUTE) {
    const mid = lo + minuteFloor((hi - lo) / 2)
    if (offsetMinutes(mid, timeZone) === before) lo = mid
    else hi = mid
  }
  return hi
}

const addDays = (date: string, days: number): string => {
  const m = DATE.exec(date)!
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10)
}
/** 1 (Monday) to 7 (Sunday). */
const weekdayOf = (date: string): number => {
  const m = DATE.exec(date)!
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  return dow === 0 ? 7 : dow
}

const matchesDay = (schedule: RoutineSchedule, date: string): boolean => {
  if (schedule.kind === 'once') return schedule.date === date
  if (schedule.cadence === 'daily') return true
  const dow = weekdayOf(date)
  if (schedule.cadence === 'weekdays') return dow <= 5
  return (schedule.weekdays ?? []).includes(dow)
}

export const occurrenceKey = (date: string, time: string, timeZone: string): string => `${date}T${time}@${timeZone}`

/** Every occurrence with `after < dueAt <= until`, oldest first. A scan is bounded to about 400 days. */
export function occurrencesBetween(schedule: RoutineSchedule, after: number, until: number): Occurrence[] {
  if (until <= after) return []
  const found: Occurrence[] = []
  const first = civilOf(after, schedule.timeZone).date
  const days = Math.min(
    MAX_SCAN_DAYS,
    Math.ceil((civilOf(until, schedule.timeZone).utcLike - Date.parse(`${first}T00:00:00Z`)) / DAY) + 2
  )
  for (let i = -1; i <= days; i += 1) {
    const date = addDays(first, i)
    if (!matchesDay(schedule, date)) continue
    const dueAt = civilToInstant(date, schedule.time, schedule.timeZone)
    if (dueAt > after && dueAt <= until) {
      found.push({ key: occurrenceKey(date, schedule.time, schedule.timeZone), dueAt })
    }
  }
  return found.sort((a, b) => a.dueAt - b.dueAt)
}

/** The next occurrence strictly after `after`, or null (a once schedule that has passed). */
export function nextOccurrence(schedule: RoutineSchedule, after: number): Occurrence | null {
  if (schedule.kind === 'once') {
    const dueAt = civilToInstant(schedule.date, schedule.time, schedule.timeZone)
    return dueAt > after ? { key: occurrenceKey(schedule.date, schedule.time, schedule.timeZone), dueAt } : null
  }
  const first = civilOf(after, schedule.timeZone).date
  for (let i = -1; i <= MAX_SCAN_DAYS; i += 1) {
    const date = addDays(first, i)
    if (!matchesDay(schedule, date)) continue
    const dueAt = civilToInstant(date, schedule.time, schedule.timeZone)
    if (dueAt > after) return { key: occurrenceKey(date, schedule.time, schedule.timeZone), dueAt }
  }
  return null
}

/** When an occurrence stops being claimable: the next occurrence's due time, or 24 hours for a once routine. */
export function expiryOf(schedule: RoutineSchedule, occurrence: Occurrence): number {
  if (schedule.kind === 'once') return occurrence.dueAt + DAY
  return nextOccurrence(schedule, occurrence.dueAt)?.dueAt ?? occurrence.dueAt + DAY
}

export const localLabel = (instant: number, timeZone: string): string => {
  const civil = civilOf(instant, timeZone)
  return `${civil.date} ${civil.time}`
}

const cityOf = (timeZone: string): string => (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ')
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** The owner-readable cadence, such as `Every day 09:00 New York`. */
export function scheduleCopy(schedule: RoutineSchedule): string {
  const where = `${schedule.time} ${cityOf(schedule.timeZone)}`
  if (schedule.kind === 'once') return `Runs once on ${schedule.date} ${where}`
  if (schedule.cadence === 'daily') return `Every day ${where}`
  if (schedule.cadence === 'weekdays') return `Every weekday ${where}`
  return `Every ${(schedule.weekdays ?? []).map((d) => WEEKDAY_NAMES[d - 1]).join(', ')} ${where}`
}

export type CompileFailure = 'invalid_zone' | 'invalid_schedule' | 'unrecognized_schedule'

export interface CompiledSchedule {
  schedule: RoutineSchedule
  /** Up to three upcoming instants (one for a once schedule). */
  nextRuns: number[]
  copy: string
}

const DAY_WORDS: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7
}

function parseClock(raw: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw.trim())
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? '0')
  if (m[3]) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** A bounded English phrase to a schedule, or null. Only the shapes listed in the tests are recognized. */
export function parseSchedulePhrase(phrase: string, timeZone: string): RoutineSchedule | null {
  const text = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  if (text.length === 0 || text.length > SCHEDULE_PHRASE_MAX_CHARS) return null
  let m = /^(?:every day|daily|everyday) at (.+)$/.exec(text)
  if (m) {
    const time = parseClock(m[1]!)
    return time ? { kind: 'recurring', cadence: 'daily', time, timeZone } : null
  }
  m = /^(?:every weekday|weekdays) at (.+)$/.exec(text)
  if (m) {
    const time = parseClock(m[1]!)
    return time ? { kind: 'recurring', cadence: 'weekdays', time, timeZone } : null
  }
  m = /^every ([a-z]+(?:(?:,| and |, and )\s*[a-z]+)*) at (.+)$/.exec(text)
  if (m) {
    const days = m[1]!.split(/,\s*and |,\s*| and /).map((word) => DAY_WORDS[word.trim()])
    const time = parseClock(m[2]!)
    if (!time || days.length === 0 || days.some((d) => d === undefined)) return null
    const weekdays = [...new Set(days as number[])].sort((a, b) => a - b)
    return { kind: 'recurring', cadence: 'weekly', weekdays, time, timeZone }
  }
  m = /^(?:once )?on (\d{4}-\d{2}-\d{2}) at (.+)$/.exec(text)
  if (m) {
    const time = parseClock(m[2]!)
    return time && validDate(m[1]!) ? { kind: 'once', date: m[1]!, time, timeZone } : null
  }
  return null
}

/** Validates a structured schedule and computes the preview's next runs. */
export function compileSchedule(
  input: { spec?: RoutineSchedule; phrase?: string; timeZone?: string },
  now: number,
  defaultTimeZone: string
): { ok: true; compiled: CompiledSchedule } | { ok: false; reason: CompileFailure } {
  let schedule: RoutineSchedule | null
  if (input.spec) {
    schedule = input.spec
  } else if (typeof input.phrase === 'string') {
    const zone = input.timeZone ?? defaultTimeZone
    if (!validTimeZone(zone)) return { ok: false, reason: 'invalid_zone' }
    schedule = parseSchedulePhrase(input.phrase, zone)
    if (!schedule) return { ok: false, reason: 'unrecognized_schedule' }
  } else {
    return { ok: false, reason: 'invalid_schedule' }
  }
  if (!validTimeZone(schedule.timeZone)) return { ok: false, reason: 'invalid_zone' }
  if (!validTime(schedule.time)) return { ok: false, reason: 'invalid_schedule' }
  if (schedule.kind === 'once') {
    if (!validDate(schedule.date)) return { ok: false, reason: 'invalid_schedule' }
  } else if (schedule.cadence === 'weekly') {
    const days = schedule.weekdays ?? []
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { ok: false, reason: 'invalid_schedule' }
    }
    schedule = { ...schedule, weekdays: [...new Set(days)].sort((a, b) => a - b) }
  } else if (schedule.weekdays !== undefined) {
    schedule = { kind: 'recurring', cadence: schedule.cadence, time: schedule.time, timeZone: schedule.timeZone }
  }
  const nextRuns: number[] = []
  let cursor = now
  for (let i = 0; i < (schedule.kind === 'once' ? 1 : 3); i += 1) {
    const next = nextOccurrence(schedule, cursor)
    if (!next) break
    nextRuns.push(next.dueAt)
    cursor = next.dueAt
  }
  if (nextRuns.length === 0) return { ok: false, reason: 'invalid_schedule' }
  const copy = `${scheduleCopy(schedule)}; next run ${localLabel(nextRuns[0]!, schedule.timeZone)}`
  return { ok: true, compiled: { schedule, nextRuns, copy } }
}
