import { describe, it, expect, afterEach } from 'vitest'
import { computeWeeklyBars } from './BrainView'
import type { MeetingSummary } from '@shared/ipc'

const DAY_MS = 24 * 60 * 60 * 1000

/** A meeting at a local wall-clock time, saved the way transcripts.ts saves them: a full ISO instant. */
function meetingAt(y: number, mZeroBased: number, d: number, hour: number): MeetingSummary {
  const at = new Date(y, mZeroBased, d, hour)
  return {
    file: `${at.toISOString()}.md`,
    title: 'Test meeting',
    date: at.toISOString(),
    mode: 'call',
    durationMin: 30,
    participants: []
  }
}

/** Local midnight of a calendar day, as a ms timestamp — the shape a column key must have. */
const localMidnight = (y: number, mZeroBased: number, d: number): number => new Date(y, mZeroBased, d).getTime()

const total = (weeks: { n: number }[]): number => weeks.reduce((s, x) => s + x.n, 0)

/**
 * MQA-194 — the "Meetings per week" histogram buckets each meeting under its local Monday midnight
 * (`weekStart`), so the 12 rendered columns must be built the same way. Building them by subtracting
 * a fixed 7*24h instead makes every column on the far side of a DST transition an hour off the real
 * bucket key, and those bars silently read zero.
 *
 * Both DST directions are pinned deliberately: fall-back skews the synthetic keys an hour LATE, and
 * spring-forward skews them an hour EARLY (onto Sunday 23:00), which also mislabels the axis. The
 * timezone is pinned to America/New_York rather than trusted from the host — Node/V8 re-resolve the
 * zone from process.env.TZ on every Date call, so this reproduces deterministically anywhere.
 */
describe('MQA-194 — meetings-per-week columns survive a DST transition', () => {
  const ORIGINAL_TZ = process.env.TZ

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  it('MQA-194: counts meetings from before a fall-back transition (US DST ended 2026-11-01)', () => {
    process.env.TZ = 'America/New_York'
    const now = new Date(2026, 10, 16, 12).getTime() // Mon 2026-11-16 12:00 EST, two weeks after fall-back
    const meetings = [
      meetingAt(2026, 8, 15, 10), // Tue 2026-09-15 — week of Mon Sep 14 (EDT)
      meetingAt(2026, 9, 6, 10), //  Tue 2026-10-06 — week of Mon Oct 05 (EDT)
      meetingAt(2026, 9, 20, 10), // Tue 2026-10-20 — week of Mon Oct 19 (EDT)
      meetingAt(2026, 10, 3, 10) //  Tue 2026-11-03 — week of Mon Nov 02 (EST)
    ]

    const { weeks, maxIdx } = computeWeeklyBars(meetings, now)

    // Every meeting inside the 12-week window is drawn by exactly one column — nothing falls between bars.
    expect(total(weeks)).toBe(4)
    expect(weeks.find((x) => x.w === localMidnight(2026, 8, 14))?.n).toBe(1)
    expect(weeks.find((x) => x.w === localMidnight(2026, 9, 5))?.n).toBe(1)
    expect(weeks.find((x) => x.w === localMidnight(2026, 9, 19))?.n).toBe(1)
    expect(weeks.find((x) => x.w === localMidnight(2026, 10, 2))?.n).toBe(1)
    // The "busiest week" highlight must land on a week that actually has meetings.
    expect(weeks[maxIdx].n).toBe(1)
  })

  it('MQA-194: columns stay Monday-anchored and gapless across a spring-forward transition (US DST began 2026-03-08)', () => {
    process.env.TZ = 'America/New_York'
    const now = new Date(2026, 2, 30, 12).getTime() // Mon 2026-03-30 12:00 EDT
    const meetings = [
      meetingAt(2026, 2, 4, 10), // Wed 2026-03-04 \
      meetingAt(2026, 2, 5, 10), // Thu 2026-03-05  > all week of Mon Mar 02 (EST, pre-transition)
      meetingAt(2026, 2, 6, 10), // Fri 2026-03-06 /
      meetingAt(2026, 2, 24, 10) // Tue 2026-03-24 — week of Mon Mar 23 (EDT)
    ]

    const { weeks, max, maxIdx } = computeWeeklyBars(meetings, now)

    // Every column key is a real local Monday midnight — the tooltip/axis label reads off this value,
    // so a key that has drifted to Sunday 23:00 labels the wrong day as well as counting nothing.
    for (const { w } of weeks) {
      const d = new Date(w)
      expect(d.getDay()).toBe(1)
      expect(d.getHours()).toBe(0)
    }
    // 12 distinct, consecutive weeks: no duplicated column, and no week missing from the chart.
    expect(new Set(weeks.map((x) => x.w)).size).toBe(12)
    for (let i = 1; i < weeks.length; i++) {
      expect(Math.round((weeks[i].w - weeks[i - 1].w) / DAY_MS)).toBe(7)
    }
    expect(weeks[weeks.length - 1].w).toBe(localMidnight(2026, 2, 30)) // newest column is the current week

    expect(total(weeks)).toBe(4)
    expect(weeks.find((x) => x.w === localMidnight(2026, 2, 2))?.n).toBe(3)
    expect(max).toBe(3)
    expect(weeks[maxIdx].w).toBe(localMidnight(2026, 2, 2)) // the highlighted busiest week
  })
})
