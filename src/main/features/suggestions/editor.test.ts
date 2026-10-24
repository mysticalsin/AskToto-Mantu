import { describe, expect, it } from 'vitest'
import { buildCandidates, evidenceDigest, filterByFeedback, termsOf, type Candidate } from './editor'
import { DAY, HOUR, NOW, anchor, support } from './__fixtures__/suggestions-harness'

const BUDGET = ['budget', 'review', 'forecast']

describe('suggestion editor (G67)', () => {
  it('derives lowercase terms of 4+ characters, capped at 12', () => {
    expect(termsOf('The Budget review: FORECAST for Q4 and q4 budget')).toEqual(['budget', 'review', 'forecast'])
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    expect(termsOf(many)).toHaveLength(12)
  })

  it('keeps eventAt and retrievedAt distinct on the card evidence (T083)', () => {
    const a = anchor(1, 'Budget review', BUDGET, NOW + 2 * HOUR)
    const [card] = buildCandidates([a], NOW)
    expect(card!.evidence[0]).toMatchObject({ eventAt: NOW + 2 * HOUR, retrievedAt: NOW })
    expect(card!.evidence[0]!.eventAt).not.toBe(card!.evidence[0]!.retrievedAt)
  })

  it('ignores an anchor older than 24 hours and drops a stale item that no fresh anchor matches (T083)', () => {
    const staleAnchor = anchor(1, 'Old review', BUDGET, NOW - 3 * DAY)
    expect(buildCandidates([staleAnchor], NOW)).toEqual([])
    const fresh = anchor(2, 'Roadmap sync', ['roadmap', 'sync', 'launch'])
    const staleUnrelated = support(3, 'Old note', ['budget', 'review'], NOW - 10 * DAY)
    const cards = buildCandidates([fresh, staleUnrelated], NOW)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.evidence.map((e) => e.label)).toEqual(['Roadmap sync'])
  })

  it('keeps a stale item that matches a fresh anchor (T083)', () => {
    const fresh = anchor(1, 'Budget review', BUDGET)
    const stale = support(2, 'Last quarter forecast', ['forecast', 'budget'], NOW - 10 * DAY)
    const cards = buildCandidates([fresh, stale], NOW)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.evidence.map((e) => e.label)).toEqual(['Budget review', 'Last quarter forecast'])
  })

  it('needs two shared terms before an item supports an anchor', () => {
    const cards = buildCandidates([anchor(1, 'Budget review', BUDGET), support(2, 'One word', ['budget'])], NOW)
    expect(cards[0]!.evidence).toHaveLength(1)
  })

  it('merges the same topic from two sources into one card listing both (T084)', () => {
    const cards = buildCandidates(
      [
        anchor(1, 'Budget review', BUDGET),
        anchor(4, 'Budget review (second account)', BUDGET),
        support(2, 'Forecast first', ['forecast', 'budget'])
      ],
      NOW
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]!.evidence.map((e) => e.sourceKind).sort()).toEqual(['calendar', 'calendar', 'memory'])
    expect(cards[0]!.title).toBe('Prepare for: Budget review')
  })

  it('caps a card at 8 evidence items, a title at 160 and a label at 120 characters', () => {
    const items = [
      anchor(1, 'x'.repeat(300), BUDGET),
      ...Array.from({ length: 12 }, (_, i) => support(10 + i, `m${i}`, ['forecast', 'budget']))
    ]
    const [card] = buildCandidates(items, NOW)
    expect(card!.evidence).toHaveLength(8)
    expect(card!.title.length).toBeLessThanOrEqual(160)
    expect(card!.evidence[0]!.label.length).toBeLessThanOrEqual(120)
  })

  it('filters a dismissed fingerprint whose evidence digest is unchanged, and lets it back when the digest changes (T087)', () => {
    const [card] = buildCandidates([anchor(1, 'Budget review', BUDGET)], NOW) as [Candidate]
    const feedback = [
      {
        fingerprint: card.fingerprint,
        evidenceDigest: card.evidenceDigest,
        verdict: 'dismissed' as const,
        reason: 'not_useful' as const,
        at: NOW
      }
    ]
    expect(filterByFeedback([card], feedback)).toEqual([])
    const [changed] = buildCandidates(
      [anchor(1, 'Budget review', BUDGET), support(2, 'Forecast first', ['forecast', 'budget'])],
      NOW
    ) as [Candidate]
    expect(changed.fingerprint).toBe(card.fingerprint)
    expect(changed.evidenceDigest).not.toBe(card.evidenceDigest)
    expect(filterByFeedback([changed], feedback)).toEqual([changed])
  })

  it('digests an evidence set independent of order', () => {
    const a = anchor(1, 'A topic', BUDGET).evidence
    const b = support(2, 'B topic', BUDGET).evidence
    expect(evidenceDigest([a, b])).toBe(evidenceDigest([b, a]))
  })
})
