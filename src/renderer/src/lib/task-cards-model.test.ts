import { describe, expect, it } from 'vitest'
import type { TaskCardView } from '@shared/task-card'
import { changedTaskCards, nextShownCards, TASK_CARD_EXIT_MS, visibleTaskCards } from './task-cards-model'

const view = (n: number, over: Partial<TaskCardView> = {}): TaskCardView => ({
  cardId: n.toString(16).padStart(32, '0'),
  actionId: 'desktop.open_notes',
  phase: 'running',
  stoppable: true,
  dismissible: false,
  ...over
})

describe('nextShownCards', () => {
  it('keeps a card that main dropped only for its exit, then removes it', () => {
    const first = nextShownCards([], [view(1), view(2)], 0)
    const leaving = nextShownCards(first, [view(2)], 100)
    expect(leaving.map((c) => [c.view.cardId.slice(-1), c.leaving])).toEqual([
      ['2', false],
      ['1', true]
    ])
    expect(nextShownCards(leaving, [view(2)], 100 + TASK_CARD_EXIT_MS - 1)).toHaveLength(2)
    expect(nextShownCards(leaving, [view(2)], 100 + TASK_CARD_EXIT_MS)).toHaveLength(1)
  })

  it('brings a card back to live if main lists it again during its exit', () => {
    const leaving = nextShownCards(nextShownCards([], [view(1)], 0), [], 10)
    expect(nextShownCards(leaving, [view(1)], 20)).toEqual([{ view: view(1), leaving: false }])
  })
})

describe('visibleTaskCards', () => {
  it('draws the newest three live cards and folds the rest into a count', () => {
    const shown = nextShownCards([], [view(1), view(2), view(3), view(4), view(5)], 0)
    const { cards, more } = visibleTaskCards(shown)
    expect(cards.map((c) => c.view.cardId.slice(-1))).toEqual(['3', '4', '5'])
    expect(more).toBe(2)
  })

  it('never counts a leaving card as more', () => {
    const shown = nextShownCards(nextShownCards([], [view(1), view(2)], 0), [view(2)], 5)
    expect(visibleTaskCards(shown).more).toBe(0)
  })
})

describe('changedTaskCards', () => {
  it('announces a new card and a phase change once, and nothing for an unchanged card', () => {
    const a = [view(1, { phase: 'queued' })]
    const b = [view(1, { phase: 'running' }), view(2)]
    expect(changedTaskCards([], a)).toHaveLength(1)
    expect(changedTaskCards(a, b).map((c) => c.cardId.slice(-1))).toEqual(['1', '2'])
    expect(changedTaskCards(b, b)).toEqual([])
  })
})
