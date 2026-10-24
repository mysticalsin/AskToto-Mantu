import {
  INTERVENTION_CARD_SWAP_MAX_CHARS,
  INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS,
  INTERVENTION_DUPLICATE_THRESHOLD
} from '@shared/intervention-contract'
import { CardSwapGuard, type CardSwapTicket } from '@shared/kernel/card-swap-guard'
import { AskCardContext, type AskCardSnapshot } from './ask-card-context'
import type { AnswerState } from './ask-types'

/** Scores how alike two cards are, 0 to 1. Card text stays in the renderer; nothing here sends it anywhere. */
export type DuplicateReviewer = (previous: string, candidate: string, signal: AbortSignal) => Promise<number> | number

export type CardOutcome = 'duplicate_rolled_back' | 'duplicate_retained' | 'review_expired' | 'review_superseded'

/**
 * The production reviewer: deterministic and on-device. NFKC and lowercase, split into letter and number
 * tokens, then the Jaccard overlap of the two token sets. It is lexical, not semantic; a semantic reviewer
 * plugs in through the same `DuplicateReviewer` type.
 */
export function lexicalDuplicateScore(a: string, b: string): number {
  const tokens = (text: string): Set<string> =>
    new Set(
      text
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
    )
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

export interface SuggestionCardControllerDeps {
  reviewer: DuplicateReviewer
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  /** Restore the prior card. Returns false when the card being replaced is no longer on screen. */
  onRollback: (previous: AnswerState, replacedAskId: string) => boolean
  /** Ask id and a closed outcome name only; never card text. */
  onOutcome: (askId: string, outcome: CardOutcome) => void
}

interface Review {
  askId: string
  ticket: CardSwapTicket
  abort: AbortController
  timer: unknown
}

/**
 * One per `useAsk` instance. A suggestion card enters a CardSwapGuard when it is first painted. When it
 * completes and replaced a completed suggestion, a duplicate review runs for at most 4 s; a duplicate is
 * undone only if CardSwapGuard still agrees the card is the newest swap in an unchanged context. Anything
 * else (timeout, error, a newer card, clear, cancel, unmount) keeps what is on screen.
 */
export class SuggestionCardController {
  private readonly context = new AskCardContext()
  private readonly guard = new CardSwapGuard<AskCardSnapshot>(this.context)
  private swapped: { askId: string; ticket: CardSwapTicket } | null = null
  private review: Review | null = null
  private disposed = false

  constructor(private readonly deps: SuggestionCardControllerDeps) {}

  /** A suggestion card just reached the screen with its first text. */
  painted(card: AnswerState): void {
    this.superseded()
    if (this.disposed) return
    try {
      const text = card.text.slice(0, INTERVENTION_CARD_SWAP_MAX_CHARS)
      this.swapped = { askId: card.id, ticket: this.guard.swap(this.context.issue(), { id: card.id, text }) }
    } catch {
      this.swapped = null // an id the guard rejects is simply never reviewed
    }
  }

  /** The suggestion finished successfully. `previous` is the completed suggestion it replaced, if any. */
  completed(card: AnswerState, previous: AnswerState | null): void {
    const swapped = this.swapped
    if (this.disposed || !swapped || swapped.askId !== card.id) return
    this.swapped = null
    if (!previous) {
      this.guard.confirm(swapped.ticket)
      return
    }
    const review: Review = { askId: card.id, ticket: swapped.ticket, abort: new AbortController(), timer: null }
    review.timer = this.deps.setTimer(() => this.expire(review), INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS)
    this.review = review
    void this.score(review, previous, card)
  }

  /** A newer suggestion started or was painted: an unfinished review of an older card ends as superseded. */
  superseded(): void {
    this.swapped = null
    const review = this.review
    if (!review) return
    this.end(review)
    this.deps.onOutcome(review.askId, 'review_superseded')
  }

  /** The visible card changed for another reason (clear, cancel, fail, other mode): nothing may roll back. */
  invalidate(reason: string): void {
    this.swapped = null
    if (this.review) this.end(this.review)
    this.context.invalidate(reason)
  }

  dispose(): void {
    this.invalidate('dispose')
    this.disposed = true
    this.guard.dispose()
  }

  private async score(review: Review, previous: AnswerState, card: AnswerState): Promise<void> {
    let score = 0
    try {
      score = await this.deps.reviewer(previous.text, card.text, review.abort.signal)
    } catch {
      score = 0 // a failing reviewer keeps the new card
    }
    if (this.review !== review) return // expired, superseded or invalidated while scoring
    this.end(review)
    if (Number.isFinite(score) && score >= INTERVENTION_DUPLICATE_THRESHOLD) {
      let rolledBack = false
      try {
        rolledBack = this.guard.rollback(review.ticket)
      } catch {
        rolledBack = false
      }
      const restored = rolledBack && this.deps.onRollback(previous, card.id)
      this.deps.onOutcome(card.id, restored ? 'duplicate_rolled_back' : 'review_superseded')
      return
    }
    this.guard.confirm(review.ticket)
    this.deps.onOutcome(card.id, 'duplicate_retained')
  }

  private expire(review: Review): void {
    if (this.review !== review) return
    this.end(review)
    this.guard.confirm(review.ticket)
    this.deps.onOutcome(review.askId, 'review_expired')
  }

  private end(review: Review): void {
    this.deps.clearTimer(review.timer)
    review.abort.abort()
    if (this.review === review) this.review = null
  }
}
