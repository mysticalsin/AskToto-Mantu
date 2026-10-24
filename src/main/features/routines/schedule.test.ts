import { describe, expect, it } from 'vitest'
import {
  civilToInstant,
  compileSchedule,
  expiryOf,
  localLabel,
  nextOccurrence,
  occurrencesBetween,
  parseSchedulePhrase,
  type RoutineSchedule
} from './schedule'

const NY = 'America/New_York'
const daily = (time: string, timeZone: string): RoutineSchedule => ({
  kind: 'recurring',
  cadence: 'daily',
  time,
  timeZone
})

describe('routine schedule (G66, R074)', () => {
  it('daily 09:00 New York keeps local time across 2026-03-08 and 2026-11-01', () => {
    const s = daily('09:00', NY)
    for (const [start, days] of [
      ['2026-03-06T00:00:00Z', 5],
      ['2026-10-30T00:00:00Z', 5]
    ] as const) {
      const from = Date.parse(start)
      const runs = occurrencesBetween(s, from, from + days * 86_400_000)
      expect(runs.length).toBeGreaterThanOrEqual(4)
      for (const run of runs) expect(localLabel(run.dueAt, NY).endsWith('09:00')).toBe(true)
    }
    // 09:00 EST is 14:00Z, 09:00 EDT is 13:00Z.
    expect(nextOccurrence(s, Date.parse('2026-03-07T20:00:00Z'))!.dueAt).toBe(Date.parse('2026-03-08T13:00:00Z'))
    expect(nextOccurrence(s, Date.parse('2026-10-31T20:00:00Z'))!.dueAt).toBe(Date.parse('2026-11-01T14:00:00Z'))
  })

  it('spring-forward gap moves to first valid minute', () => {
    // 02:30 on 2026-03-08 does not exist in New York; the gap ends at 03:00 EDT = 07:00Z.
    expect(civilToInstant('2026-03-08', '02:30', NY)).toBe(Date.parse('2026-03-08T07:00:00Z'))
    // Lord Howe shifts by 30 minutes: 02:15 on 2026-10-04 does not exist, 02:30 does.
    const lh = civilToInstant('2026-10-04', '02:15', 'Australia/Lord_Howe')
    expect(localLabel(lh, 'Australia/Lord_Howe')).toBe('2026-10-04 02:30')
  })

  it('fall-back ambiguity picks earlier instant', () => {
    // 01:30 on 2026-11-01 happens twice in New York; the first is EDT = 05:30Z.
    expect(civilToInstant('2026-11-01', '01:30', NY)).toBe(Date.parse('2026-11-01T05:30:00Z'))
  })

  it('keeps wall-clock time in Paris and Sao Paulo too', () => {
    const paris = occurrencesBetween(
      daily('08:00', 'Europe/Paris'),
      Date.parse('2026-03-27T00:00:00Z'),
      Date.parse('2026-03-31T00:00:00Z')
    )
    for (const r of paris) expect(localLabel(r.dueAt, 'Europe/Paris').endsWith('08:00')).toBe(true)
    expect(paris[0]!.key).toBe('2026-03-27T08:00@Europe/Paris')
    const sp = civilToInstant('2026-06-01', '09:00', 'America/Sao_Paulo')
    expect(sp).toBe(Date.parse('2026-06-01T12:00:00Z'))
  })

  it('weekdays skips Sat/Sun', () => {
    const s: RoutineSchedule = { kind: 'recurring', cadence: 'weekdays', time: '09:00', timeZone: 'UTC' }
    // 2026-11-06 is a Friday.
    const runs = occurrencesBetween(s, Date.parse('2026-11-06T10:00:00Z'), Date.parse('2026-11-10T10:00:00Z'))
    expect(runs.map((r) => r.key)).toEqual(['2026-11-09T09:00@UTC', '2026-11-10T09:00@UTC'])
  })

  it('invalid IANA zone is refused', () => {
    const r = compileSchedule({ spec: daily('09:00', 'Mars/Olympus') }, 0, 'UTC')
    expect(r).toEqual({ ok: false, reason: 'invalid_zone' })
    expect(compileSchedule({ phrase: 'every day at 9am', timeZone: 'Nope/Nope' }, 0, 'UTC')).toEqual({
      ok: false,
      reason: 'invalid_zone'
    })
  })

  it('phrase "every weekday at 8:30" compiles; unknown phrase → unrecognized_schedule', () => {
    const ok = compileSchedule(
      { phrase: 'Every weekday at 8:30', timeZone: NY },
      Date.parse('2026-11-06T10:00:00Z'),
      'UTC'
    )
    expect(ok.ok && ok.compiled.schedule).toEqual({
      kind: 'recurring',
      cadence: 'weekdays',
      time: '08:30',
      timeZone: NY
    })
    expect(compileSchedule({ phrase: 'whenever you feel like it' }, 0, 'UTC')).toEqual({
      ok: false,
      reason: 'unrecognized_schedule'
    })
    expect(parseSchedulePhrase('every monday and wednesday at 9pm', 'UTC')).toEqual({
      kind: 'recurring',
      cadence: 'weekly',
      weekdays: [1, 3],
      time: '21:00',
      timeZone: 'UTC'
    })
    expect(parseSchedulePhrase('every day at 25:00', 'UTC')).toBeNull()
  })

  it('previews three runs and the owner copy', () => {
    const r = compileSchedule({ spec: daily('09:00', NY) }, Date.parse('2026-03-07T20:00:00Z'), 'UTC')
    expect(r.ok && r.compiled.nextRuns).toHaveLength(3)
    expect(r.ok && r.compiled.copy).toBe('Every day 09:00 New York; next run 2026-03-08 09:00')
  })

  it('a once schedule yields one run and none after it passes', () => {
    const once: RoutineSchedule = { kind: 'once', date: '2026-11-02', time: '09:00', timeZone: 'UTC' }
    const r = compileSchedule({ spec: once }, Date.parse('2026-11-01T00:00:00Z'), 'UTC')
    expect(r.ok && r.compiled.nextRuns).toHaveLength(1)
    expect(r.ok && r.compiled.copy.startsWith('Runs once')).toBe(true)
    expect(nextOccurrence(once, Date.parse('2026-11-03T00:00:00Z'))).toBeNull()
    const due = nextOccurrence(once, 0)!
    expect(expiryOf(once, due)).toBe(due.dueAt + 86_400_000)
  })
})
