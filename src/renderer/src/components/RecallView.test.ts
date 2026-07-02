import { describe, it, expect, afterEach, vi } from 'vitest'
import { localDateKey, groupByLocalDate, friendlyDate } from './RecallView'
import type { MeetingSummary } from '@shared/ipc'

function meeting(date: string, file = 'm.md'): MeetingSummary {
  return { file, title: 'Test meeting', date, mode: 'call', durationMin: 10, participants: [] }
}

/**
 * These tests pin both the system clock (vi.useFakeTimers + setSystemTime) AND process.env.TZ, rather
 * than trying to mock a specific UTC offset indirectly. Node/V8 re-resolve the active timezone from
 * process.env.TZ on every Date/Intl call (verified empirically against this repo's Node runtime), so
 * this reproduces the exact bug class the fix targets — a timezone west of UTC (America/New_York,
 * EDT/UTC-4) — deterministically, regardless of which timezone the machine running the suite is in.
 */
describe('local date grouping (RecallView)', () => {
  const ORIGINAL_TZ = process.env.TZ

  afterEach(() => {
    vi.useRealTimers()
    process.env.TZ = ORIGINAL_TZ
  })

  it('a meeting saved seconds ago keys and labels as "Today" in a UTC-negative timezone', () => {
    process.env.TZ = 'America/New_York'
    const now = new Date('2026-07-02T17:50:34.312Z') // 13:50 EDT local — mid-afternoon, July 2 local
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const key = localDateKey(now.toISOString())
    expect(key).toBe('2026-07-02') // the LOCAL date, not the raw UTC slice
    expect(friendlyDate(key)).toBe('Today')
  })

  it('a meeting from earlier the same UTC day but the previous LOCAL day labels as "Yesterday"', () => {
    process.env.TZ = 'America/New_York'
    const now = new Date('2026-07-02T17:50:34.312Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    // 2026-07-02T02:00:00Z is 2026-07-01T22:00 EDT local (10pm the previous local day) — the exact
    // shape of meeting the old UTC-slice bug mislabeled, because the old code parsed the bare "2026-07-02"
    // UTC-date slice as UTC midnight and then compared it against local "today"/"yesterday".
    const key = localDateKey('2026-07-02T02:00:00.000Z')
    expect(key).toBe('2026-07-01')
    expect(friendlyDate(key)).toBe('Yesterday')
  })

  it('older meetings fall back to a formatted weekday/month/day, in LOCAL time', () => {
    process.env.TZ = 'America/New_York'
    const now = new Date('2026-07-02T17:50:34.312Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const key = localDateKey('2026-06-15T14:00:00.000Z') // 10:00 EDT local, June 15 (a Monday)
    expect(key).toBe('2026-06-15')
    // Compare against the same locale-formatting call the implementation uses, rather than a hardcoded
    // string, so this test isn't sensitive to the default ICU locale of the machine running it.
    const expected = new Date(2026, 5, 15).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
    expect(friendlyDate(key)).toBe(expected)
  })

  it('groupByLocalDate buckets meetings by their LOCAL calendar day, not the raw UTC date slice', () => {
    process.env.TZ = 'America/New_York'
    const now = new Date('2026-07-02T17:50:34.312Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const today1 = meeting(now.toISOString(), 'a.md')
    const today2 = meeting('2026-07-02T23:30:00.000Z', 'b.md') // 19:30 EDT local — still July 2
    // 02:00Z on the 2nd is 22:00 EDT on the 1st — same UTC calendar date as the two "today" meetings
    // above, but a different LOCAL calendar date. The old `.slice(0, 10)` key would have wrongly
    // bucketed this together with them.
    const crossesMidnight = meeting('2026-07-02T02:00:00.000Z', 'c.md')

    const map = new Map(groupByLocalDate([today1, today2, crossesMidnight]))
    expect(map.get('2026-07-02')?.map((m) => m.file)).toEqual(['a.md', 'b.md'])
    expect(map.get('2026-07-01')?.map((m) => m.file)).toEqual(['c.md'])
  })

  it('is timezone-consistent: the same instants group the same way in a positive-UTC-offset zone', () => {
    process.env.TZ = 'Pacific/Auckland' // UTC+12/+13 — the opposite offset class, for symmetry
    const now = new Date('2026-07-02T17:50:34.312Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const key = localDateKey(now.toISOString())
    expect(friendlyDate(key)).toBe('Today')
  })
})
