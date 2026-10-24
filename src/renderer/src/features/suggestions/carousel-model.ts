/**
 * The suggestion carousel's state (G69): which card is current, by id and never by index, so a refetch that reorders
 * or drops cards keeps the owner on the card they were reading. Pure reducer; no storage, the starting position comes
 * from main's `lastShownId`.
 */
import type { CardRef, CardView } from '@shared/suggestions'

export interface CarouselState {
  cards: CardView[]
  currentId: string | null
  /** `id:revision` keys main refused as stale. A refetched newer revision is fresh again. */
  stale: ReadonlySet<string>
  now: number
  loaded: boolean
}

export type CarouselAction =
  | { type: 'loaded'; cards: CardView[]; lastShownId: string | null }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'removed'; id: string }
  | { type: 'markStale'; id: string }
  | { type: 'tick'; now: number }

const key = (card: Pick<CardView, 'id' | 'revision'>): string => `${card.id}:${card.revision}`

export const initialCarousel = (now: number): CarouselState => ({
  cards: [],
  currentId: null,
  stale: new Set(),
  now,
  loaded: false
})

const has = (cards: CardView[], id: string | null): id is string => id !== null && cards.some((c) => c.id === id)

export function carouselReducer(state: CarouselState, action: CarouselAction): CarouselState {
  const index = state.cards.findIndex((c) => c.id === state.currentId)
  switch (action.type) {
    case 'loaded': {
      const { cards, lastShownId } = action
      let currentId: string | null = null
      if (has(cards, state.currentId)) currentId = state.currentId
      else if (has(cards, lastShownId)) currentId = lastShownId
      else if (cards.length > 0) currentId = cards[Math.min(Math.max(index, 0), cards.length - 1)]!.id
      const live = new Set(cards.map(key))
      const stale = new Set([...state.stale].filter((k) => live.has(k)))
      return { ...state, cards, currentId, stale, loaded: true }
    }
    case 'next':
      return index < 0 || index >= state.cards.length - 1 ? state : { ...state, currentId: state.cards[index + 1]!.id }
    case 'prev':
      return index <= 0 ? state : { ...state, currentId: state.cards[index - 1]!.id }
    case 'removed': {
      const at = state.cards.findIndex((c) => c.id === action.id)
      if (at < 0) return state
      const cards = state.cards.filter((c) => c.id !== action.id)
      if (state.currentId !== action.id) return { ...state, cards }
      const next = cards[at] ?? cards[at - 1] ?? null
      return { ...state, cards, currentId: next ? next.id : null }
    }
    case 'markStale': {
      const card = state.cards.find((c) => c.id === action.id)
      if (!card) return state
      return { ...state, stale: new Set([...state.stale, key(card)]) }
    }
    case 'tick':
      return { ...state, now: action.now }
  }
}

export function currentCard(state: CarouselState): CardView | null {
  return state.cards.find((c) => c.id === state.currentId) ?? null
}

export function isCardStale(state: CarouselState, card: CardView): boolean {
  return state.now >= card.expiresAt || state.stale.has(key(card))
}

export const refOf = (card: CardView): CardRef => ({ id: card.id, revision: card.revision, nonce: card.nonce })

/** Acks `shown` once per card revision for the life of one mount. */
export function createShownTracker(): { shouldAck(card: Pick<CardView, 'id' | 'revision'>): boolean } {
  const seen = new Set<string>()
  return {
    shouldAck(card) {
      const k = key(card)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }
  }
}
