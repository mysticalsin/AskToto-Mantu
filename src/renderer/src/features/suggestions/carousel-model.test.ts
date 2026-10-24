import { describe, expect, it } from 'vitest'
import type { CardView } from '@shared/suggestions'
import { carouselReducer, createShownTracker, currentCard, initialCarousel, isCardStale } from './carousel-model'

const NOW = Date.UTC(2026, 9, 24, 12, 0)
const card = (n: number, over: Partial<CardView> = {}): CardView => ({
  id: String(n).padStart(24, '0'),
  revision: 1,
  nonce: 'f'.repeat(32),
  title: `Card ${n}`,
  evidence: [],
  createdAt: NOW,
  expiresAt: NOW + 3_600_000,
  ...over
})
const load = (cards: CardView[], lastShownId: string | null = null, state = initialCarousel(NOW)) =>
  carouselReducer(state, { type: 'loaded', cards, lastShownId })

describe('carousel model (G69)', () => {
  it('restores current card from lastShownId', () => {
    expect(currentCard(load([card(1), card(2), card(3)], card(2).id))?.id).toBe(card(2).id)
    expect(currentCard(load([card(1), card(2)], 'a'.repeat(24)))?.id).toBe(card(1).id)
    expect(currentCard(load([]))).toBeNull()
  })

  it('keeps identity by id across refetch reorder', () => {
    let state = load([card(1), card(2), card(3)])
    state = carouselReducer(state, { type: 'next' })
    expect(currentCard(state)?.id).toBe(card(2).id)
    state = load([card(3), card(2), card(1)], card(1).id, state)
    expect(currentCard(state)?.id).toBe(card(2).id)
    state = carouselReducer(state, { type: 'next' })
    expect(currentCard(state)?.id).toBe(card(1).id)
    // Next at the end stays put; Previous at the start stays put.
    expect(currentCard(carouselReducer(state, { type: 'next' }))?.id).toBe(card(1).id)
  })

  it('removing current moves to next, then previous, then empty', () => {
    let state = load([card(1), card(2), card(3)], card(2).id)
    state = carouselReducer(state, { type: 'removed', id: card(2).id })
    expect(currentCard(state)?.id).toBe(card(3).id)
    state = carouselReducer(state, { type: 'removed', id: card(3).id })
    expect(currentCard(state)?.id).toBe(card(1).id)
    state = carouselReducer(state, { type: 'removed', id: card(1).id })
    expect(currentCard(state)).toBeNull()
    expect(state.cards).toEqual([])
  })

  it('expired card is stale after tick', () => {
    const soon = card(1, { expiresAt: NOW + 1000 })
    let state = load([soon])
    expect(isCardStale(state, soon)).toBe(false)
    state = carouselReducer(state, { type: 'tick', now: NOW + 1000 })
    expect(isCardStale(state, soon)).toBe(true)
  })

  it('markStale on stale refusal', () => {
    let state = load([card(1)])
    state = carouselReducer(state, { type: 'markStale', id: card(1).id })
    expect(isCardStale(state, card(1))).toBe(true)
    // The refetched newer revision is fresh again.
    state = load([card(1, { revision: 2 })], null, state)
    expect(isCardStale(state, currentCard(state)!)).toBe(false)
  })

  it('shown tracker acks once per id and revision', () => {
    const tracker = createShownTracker()
    expect(tracker.shouldAck(card(1))).toBe(true)
    expect(tracker.shouldAck(card(1))).toBe(false)
    expect(tracker.shouldAck(card(1, { revision: 2 }))).toBe(true)
  })
})
