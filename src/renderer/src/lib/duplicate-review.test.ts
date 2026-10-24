import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS,
  INTERVENTION_DUPLICATE_THRESHOLD
} from '@shared/intervention-contract'
import type { AnswerState } from './ask-types'
import {
  lexicalDuplicateScore,
  SuggestionCardController,
  type CardOutcome,
  type DuplicateReviewer
} from './duplicate-review'

const card = (id: string, text: string): AnswerState => ({
  id,
  cardId: id,
  text,
  streaming: false,
  completion: 'complete',
  error: null,
  prompt: '',
  ephemeral: true
})

function setup(reviewer: DuplicateReviewer) {
  const outcomes: Array<[string, CardOutcome]> = []
  const rollbacks: AnswerState[] = []
  const controller = new SuggestionCardController({
    reviewer,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    onRollback: (previous) => {
      rollbacks.push(previous)
      return true
    },
    onOutcome: (id, outcome) => outcomes.push([id, outcome])
  })
  return { controller, outcomes, rollbacks }
}

describe('lexicalDuplicateScore', () => {
  it('identical text scores 1', () => {
    expect(lexicalDuplicateScore('Synthetic card alpha', 'Synthetic card alpha')).toBe(1)
  })
  it('case and punctuation changes stay at or above 0.75', () => {
    expect(
      lexicalDuplicateScore('Ask about the synthetic budget.', 'ask about the SYNTHETIC budget!')
    ).toBeGreaterThanOrEqual(INTERVENTION_DUPLICATE_THRESHOLD)
  })
  it('different facts score below 0.75', () => {
    expect(lexicalDuplicateScore('Synthetic card alpha budget', 'Synthetic beta timeline risk')).toBeLessThan(
      INTERVENTION_DUPLICATE_THRESHOLD
    )
  })
  it('empty input scores 0', () => {
    expect(lexicalDuplicateScore('', 'Synthetic')).toBe(0)
    expect(lexicalDuplicateScore('!!!', '...')).toBe(0)
  })
})

describe('SuggestionCardController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rolls back to the previous card when the reviewer reports a duplicate within 4 s', async () => {
    const { controller, outcomes, rollbacks } = setup(async () => 0.9)
    const previous = card('a1', 'Synthetic card alpha')
    controller.painted(card('a2', 'Synthetic card alpha'))
    controller.completed(card('a2', 'Synthetic card alpha'), previous)
    await vi.advanceTimersByTimeAsync(0)
    expect(rollbacks).toEqual([previous])
    expect(outcomes).toEqual([['a2', 'duplicate_rolled_back']])
  })

  it('retains the new card and confirms the ticket when not a duplicate', async () => {
    const { controller, outcomes, rollbacks } = setup(() => 0.1)
    controller.painted(card('b2', 'Synthetic beta'))
    controller.completed(card('b2', 'Synthetic beta'), card('b1', 'Synthetic alpha'))
    await vi.advanceTimersByTimeAsync(0)
    expect(rollbacks).toEqual([])
    expect(outcomes).toEqual([['b2', 'duplicate_retained']])
  })

  it('retains the new card when the reviewer throws', async () => {
    const { controller, outcomes, rollbacks } = setup(() => {
      throw new Error('synthetic reviewer failure')
    })
    controller.painted(card('c2', 'x'))
    controller.completed(card('c2', 'x'), card('c1', 'y'))
    await vi.advanceTimersByTimeAsync(0)
    expect(rollbacks).toEqual([])
    expect(outcomes).toEqual([['c2', 'duplicate_retained']])
  })

  it('expires at 4 000 ms and ignores a late duplicate score', async () => {
    let finish: (score: number) => void = () => {}
    let aborted = false
    const { controller, outcomes, rollbacks } = setup(
      (_p, _c, signal) =>
        new Promise<number>((resolve) => {
          finish = resolve
          signal.addEventListener('abort', () => (aborted = true))
        })
    )
    controller.painted(card('d2', 'x'))
    controller.completed(card('d2', 'x'), card('d1', 'x'))
    await vi.advanceTimersByTimeAsync(INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS - 1)
    expect(outcomes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(outcomes).toEqual([['d2', 'review_expired']])
    expect(aborted).toBe(true)
    finish(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(rollbacks).toEqual([])
    expect(outcomes).toHaveLength(1)
  })

  it('a newer swap before the review result reports review_superseded and never rolls back', async () => {
    let finish: (score: number) => void = () => {}
    const { controller, outcomes, rollbacks } = setup(() => new Promise<number>((resolve) => (finish = resolve)))
    controller.painted(card('e2', 'x'))
    controller.completed(card('e2', 'x'), card('e1', 'x'))
    controller.painted(card('e3', 'newer'))
    finish(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(rollbacks).toEqual([])
    expect(outcomes).toEqual([['e2', 'review_superseded']])
  })

  it('invalidate during review drops it with no rollback and no outcome', async () => {
    let finish: (score: number) => void = () => {}
    const { controller, outcomes, rollbacks } = setup(() => new Promise<number>((resolve) => (finish = resolve)))
    controller.painted(card('f2', 'x'))
    controller.completed(card('f2', 'x'), card('f1', 'x'))
    controller.invalidate('clear')
    finish(1)
    await vi.advanceTimersByTimeAsync(INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS)
    expect(rollbacks).toEqual([])
    expect(outcomes).toEqual([])
  })

  it('no previous card means no review and no outcome', async () => {
    const reviewer = vi.fn(() => 1)
    const { controller, outcomes } = setup(reviewer)
    controller.painted(card('g1', 'x'))
    controller.completed(card('g1', 'x'), null)
    await vi.advanceTimersByTimeAsync(INTERVENTION_DUPLICATE_REVIEW_DEADLINE_MS)
    expect(reviewer).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })

  it('never reviews a card that was not painted through the guard', async () => {
    const reviewer = vi.fn(() => 1)
    const { controller, outcomes } = setup(reviewer)
    controller.completed(card('h2', 'x'), card('h1', 'x'))
    await vi.advanceTimersByTimeAsync(0)
    expect(reviewer).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })
})
