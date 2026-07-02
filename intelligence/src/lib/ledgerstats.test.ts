import { describe, it, expect } from 'vitest'
import {
  ledgerTotals,
  agingBuckets,
  reliabilityByOwner,
  outcomeDistribution,
  bandDistribution,
  stanceMix,
  type CommitmentLike
} from './ledgerstats.ts'

describe('ledgerTotals', () => {
  it('tallies open/kept/broken and computes keptRate from settled rows only', () => {
    const ledgers: CommitmentLike[] = [
      { status: 'open' },
      { status: 'open' },
      { status: 'kept' },
      { status: 'kept' },
      { status: 'kept' },
      { status: 'broken' }
    ]
    expect(ledgerTotals(ledgers)).toEqual({ open: 2, kept: 3, broken: 1, total: 6, keptRate: 0.75 })
  })

  it('returns a null keptRate — never a fabricated 100% — when nothing has settled', () => {
    expect(ledgerTotals([{ status: 'open' }, { status: 'open' }])).toEqual({
      open: 2,
      kept: 0,
      broken: 0,
      total: 2,
      keptRate: null
    })
  })

  it('returns a null keptRate for an empty ledger', () => {
    expect(ledgerTotals([])).toEqual({ open: 0, kept: 0, broken: 0, total: 0, keptRate: null })
  })

  it('defaults a missing status to open, matching the brain schema default', () => {
    expect(ledgerTotals([{}])).toEqual({ open: 1, kept: 0, broken: 0, total: 1, keptRate: null })
  })
})

describe('agingBuckets', () => {
  // now = Mon 2026-06-01. Boundaries: exactly 7 days old falls into '7-30d' (not '<7d'); exactly 30
  // falls into '30-90d'; exactly 90 falls into '>90d' — the upper edge of each band belongs to the
  // NEXT band, matching the `<` comparisons in the implementation.
  const now = Date.UTC(2026, 5, 1, 0, 0, 0)

  it('buckets open commitments by age since their date, respecting the exact day boundaries', () => {
    const items: Array<CommitmentLike & { id: string }> = [
      { id: 'a1', status: 'open', date: '2026-05-31' }, // 1 day old
      { id: 'a2', status: 'open', date: '2026-05-29' }, // 3 days old
      { id: 'b1', status: 'open', date: '2026-05-25' }, // exactly 7 days old
      { id: 'b2', status: 'open', date: '2026-05-03' }, // 29 days old
      { id: 'c1', status: 'open', date: '2026-05-02' }, // exactly 30 days old
      { id: 'c2', status: 'open', date: '2026-03-04' }, // 89 days old
      { id: 'd1', status: 'open', date: '2026-03-03' }, // exactly 90 days old
      { id: 'd2', status: 'open', date: '2025-11-13' } // 200 days old
    ]
    const result = agingBuckets(items, now)
    const idsOf = (label: string): string[] => result.buckets.find((b) => b.label === label)!.items.map((i) => i.id)

    expect(idsOf('<7d')).toEqual(['a1', 'a2'])
    expect(idsOf('7-30d')).toEqual(['b1', 'b2'])
    expect(idsOf('30-90d')).toEqual(['c1', 'c2'])
    expect(idsOf('>90d')).toEqual(['d1', 'd2'])
    expect(result.undated).toEqual([])
  })

  it('excludes settled (kept/broken) rows — only open commitments can age', () => {
    const items: CommitmentLike[] = [
      { status: 'kept', date: '2026-05-31' },
      { status: 'broken', date: '2026-05-31' }
    ]
    const result = agingBuckets(items, now)
    expect(result.buckets.every((b) => b.items.length === 0)).toBe(true)
    expect(result.undated).toEqual([])
  })

  it('puts open commitments with no date or an unparseable date into a separate undated pile', () => {
    const items: CommitmentLike[] = [{ status: 'open' }, { status: 'open', date: 'not-a-date' }]
    const result = agingBuckets(items, now)
    expect(result.buckets.every((b) => b.items.length === 0)).toBe(true)
    expect(result.undated).toHaveLength(2)
  })

  it('defaults a missing status to open when bucketing', () => {
    const result = agingBuckets([{ date: '2026-05-31' }], now)
    expect(result.buckets.find((b) => b.label === '<7d')!.items).toHaveLength(1)
  })
})

describe('reliabilityByOwner', () => {
  it('sorts worst-first by keptRate, with no-settled-rows people last', () => {
    const ledgersByPerson: Record<string, CommitmentLike[]> = {
      Alice: [{ status: 'kept' }, { status: 'kept' }, { status: 'broken' }], // keptRate 2/3
      Bob: [{ status: 'broken' }, { status: 'broken' }], // keptRate 0
      Carol: [{ status: 'open' }, { status: 'open' }], // no settled rows → null
      Dave: [] // no rows at all → null
    }
    expect(reliabilityByOwner(ledgersByPerson)).toEqual([
      { person: 'Bob', kept: 0, broken: 2, open: 0, keptRate: 0 },
      { person: 'Alice', kept: 2, broken: 1, open: 0, keptRate: 2 / 3 },
      { person: 'Carol', kept: 0, broken: 0, open: 2, keptRate: null },
      { person: 'Dave', kept: 0, broken: 0, open: 0, keptRate: null }
    ])
  })

  it('returns an empty array for an empty roster', () => {
    expect(reliabilityByOwner({})).toEqual([])
  })
})

describe('outcomeDistribution', () => {
  it('counts won/lost/open, defaulting missing or unrecognized outcomes to open', () => {
    const deals = [{ outcome: 'open' }, { outcome: 'won' }, { outcome: 'won' }, { outcome: 'lost' }, {}, { outcome: 'unrecognized' }]
    expect(outcomeDistribution(deals)).toEqual({ open: 3, won: 2, lost: 1 })
  })
})

describe('bandDistribution', () => {
  it('counts good/mixed/concerning, with null or missing bands going to an honest unknown bucket', () => {
    const deals = [
      { win_likelihood_band: 'good' },
      { win_likelihood_band: 'mixed' },
      { win_likelihood_band: 'concerning' },
      { win_likelihood_band: null },
      {},
      { win_likelihood_band: 'good' }
    ]
    expect(bandDistribution(deals)).toEqual({ good: 2, mixed: 1, concerning: 1, unknown: 2 })
  })
})

describe('stanceMix', () => {
  it('counts stances nested per category, with unknowns for missing fields', () => {
    const claims = [
      { category: 'pricing', stance: 'objection' },
      { category: 'pricing', stance: 'objection' },
      { category: 'pricing', stance: 'positive-signal' },
      { category: 'relationship', stance: 'positive-signal' },
      { stance: 'objection' }, // missing category
      { category: 'timing' } // missing stance
    ]
    expect(stanceMix(claims)).toEqual({
      pricing: { objection: 2, 'positive-signal': 1 },
      relationship: { 'positive-signal': 1 },
      unknown: { objection: 1 },
      timing: { unknown: 1 }
    })
  })

  it('returns an empty object for no claims', () => {
    expect(stanceMix([])).toEqual({})
  })
})
