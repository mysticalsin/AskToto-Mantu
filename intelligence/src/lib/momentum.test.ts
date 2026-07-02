import { describe, it, expect } from 'vitest'
import { meetingsPerWeek, sentimentSeries, rollingAverage, accountCadence, type MeetingLike } from './momentum.ts'

describe('meetingsPerWeek', () => {
  // now = Thu 2026-01-15 → its ISO week starts Mon 2026-01-12. With weeks=4 the buckets are the
  // four Mondays ending there: 2025-12-22, 2025-12-29, 2026-01-05, 2026-01-12.
  const now = Date.UTC(2026, 0, 15, 10, 0, 0)

  it('zero-fills silent weeks and buckets meetings into the ISO week containing their date', () => {
    const meetings: MeetingLike[] = [
      { date: '2025-12-22' }, // Monday of bucket 0, exactly on the boundary
      { date: '2025-12-23' }, // still bucket 0
      { date: '2026-01-06' }, // bucket 2 (week of 2026-01-05)
      { date: '2026-01-14' } // bucket 3 (week of 2026-01-12, now's own week)
    ]
    const result = meetingsPerWeek(meetings, now, 4)
    expect(result.buckets).toEqual([
      { weekStartISO: '2025-12-22', count: 2 },
      { weekStartISO: '2025-12-29', count: 0 },
      { weekStartISO: '2026-01-05', count: 1 },
      { weekStartISO: '2026-01-12', count: 1 }
    ])
    expect(result.undated).toBe(0)
  })

  it('excludes undated/unparseable meetings from buckets and counts them separately', () => {
    const meetings: MeetingLike[] = [{ date: '2026-01-06' }, {}, { date: 'not-a-date' }]
    const result = meetingsPerWeek(meetings, now, 4)
    expect(result.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1)
    expect(result.undated).toBe(2)
  })

  it('does not fabricate an undated bucket for dated meetings outside the window', () => {
    // 2025-11-01 falls well before the 4-week window starting 2025-12-22 — it must vanish silently,
    // not get miscounted as undated (it has a perfectly valid date, just an old one).
    const meetings: MeetingLike[] = [{ date: '2025-11-01' }]
    const result = meetingsPerWeek(meetings, now, 4)
    expect(result.buckets.every((b) => b.count === 0)).toBe(true)
    expect(result.undated).toBe(0)
  })

  it('defaults to a 12-week window', () => {
    const result = meetingsPerWeek([], now)
    expect(result.buckets).toHaveLength(12)
    expect(result.buckets[11].weekStartISO).toBe('2026-01-12')
  })
})

describe('sentimentSeries', () => {
  it('maps recognized sentiment vocabulary to scores, sorted by date, skipping the rest', () => {
    const meetings: MeetingLike[] = [
      { date: '2026-02-03', sentiment: 'good' },
      { date: '2026-02-01', sentiment: 'concerning' },
      { date: '2026-02-02', sentiment: 'mixed' },
      { date: '2026-02-04', sentiment: 'unrecognized-value' }, // skipped: not in the vocabulary
      { sentiment: 'good' }, // skipped: no date
      { date: '2026-02-06' } // skipped: no sentiment
    ]
    expect(sentimentSeries(meetings)).toEqual([
      { date: '2026-02-01', score: -1 },
      { date: '2026-02-02', score: 0 },
      { date: '2026-02-03', score: 1 }
    ])
  })

  it('accepts both the positive/neutral/negative and good/mixed/concerning vocabularies', () => {
    const meetings: MeetingLike[] = [
      { date: '2026-03-01', sentiment: 'positive' },
      { date: '2026-03-02', sentiment: 'neutral' },
      { date: '2026-03-03', sentiment: 'negative' }
    ]
    expect(sentimentSeries(meetings).map((p) => p.score)).toEqual([1, 0, -1])
  })
})

describe('rollingAverage', () => {
  const series = [
    { date: '2026-02-01', score: -1 },
    { date: '2026-02-02', score: 0 },
    { date: '2026-02-03', score: 1 }
  ]

  it('defaults to a trailing 3-point window, shrinking at the start of the series', () => {
    expect(rollingAverage(series)).toEqual([
      { date: '2026-02-01', avg: -1 },
      { date: '2026-02-02', avg: -0.5 },
      { date: '2026-02-03', avg: 0 }
    ])
  })

  it('honors a custom window size k', () => {
    expect(rollingAverage(series, 2)).toEqual([
      { date: '2026-02-01', avg: -1 },
      { date: '2026-02-02', avg: -0.5 },
      { date: '2026-02-03', avg: 0.5 }
    ])
  })

  it('returns an empty series for an empty input', () => {
    expect(rollingAverage([])).toEqual([])
  })
})

describe('accountCadence', () => {
  // now = Sun 2026-03-01 (2026 is not a leap year: Jan has 31 days, Feb has 28).
  const now = Date.UTC(2026, 2, 1, 0, 0, 0)

  it('computes count, lastDate, daysSinceLast and a full-tenure meetingsPerMonth, sorted stalest-first', () => {
    const meetings: MeetingLike[] = [
      { account: 'Acme', date: '2026-01-01' },
      { account: 'Acme', date: '2026-02-01' },
      { account: 'Globex', date: '2026-02-15' }
    ]
    const cadence = accountCadence(meetings, now)

    // Acme: first 2026-01-01, last 2026-02-01 → tenure 59 days, daysSinceLast 28.
    // Globex: single meeting 2026-02-15 → tenure 14 days, daysSinceLast 14.
    // Stalest-first: Acme (28 days quiet) before Globex (14 days quiet).
    expect(cadence.map((c) => c.account)).toEqual(['Acme', 'Globex'])

    const acme = cadence[0]
    expect(acme.count).toBe(2)
    expect(acme.lastDate).toBe('2026-02-01')
    expect(acme.daysSinceLast).toBe(28)
    expect(acme.meetingsPerMonth).toBeCloseTo((2 / 59) * 30, 10)

    const globex = cadence[1]
    expect(globex.count).toBe(1)
    expect(globex.lastDate).toBe('2026-02-15')
    expect(globex.daysSinceLast).toBe(14)
    expect(globex.meetingsPerMonth).toBeCloseTo((1 / 14) * 30, 10)
  })

  it('excludes meetings missing an account or a valid date entirely', () => {
    const meetings: MeetingLike[] = [
      { date: '2026-02-01' }, // no account
      { account: 'Initech' }, // no date
      { account: 'Initech', date: 'garbage' } // unparseable date
    ]
    expect(accountCadence(meetings, now)).toEqual([])
  })
})
