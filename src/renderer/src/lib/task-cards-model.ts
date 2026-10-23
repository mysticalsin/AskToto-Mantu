/**
 * Which task cards are on screen (G33). Pure, so the enter/exit rules are tested without a DOM.
 *
 * Main decides when a card ends. The renderer only keeps a card that just left for its exit animation, marked
 * `leaving`, and never shows more than three: the rest collapse into a "+N more" count.
 */
import type { TaskCardView } from '@shared/task-card'

export const TASK_CARD_EXIT_MS = 160
export const TASK_CARDS_VISIBLE = 3

export interface ShownTaskCard {
  view: TaskCardView
  leaving: boolean
  /** When the exit started (leaving cards only). */
  leftAt?: number
}

/** Next on-screen list: live cards in main's order, then cards that left less than TASK_CARD_EXIT_MS ago. */
export function nextShownCards(previous: readonly ShownTaskCard[], live: readonly TaskCardView[], now: number) {
  const liveIds = new Set(live.map((view) => view.cardId))
  const shown: ShownTaskCard[] = live.map((view) => ({ view, leaving: false }))
  for (const card of previous) {
    if (liveIds.has(card.view.cardId)) continue
    const leftAt = card.leaving ? (card.leftAt ?? now) : now
    if (now - leftAt < TASK_CARD_EXIT_MS) shown.push({ view: card.view, leaving: true, leftAt })
  }
  return shown
}

/** The cards drawn in full and how many more are folded away. Leaving cards never count as "more". */
export function visibleTaskCards(shown: readonly ShownTaskCard[]): { cards: ShownTaskCard[]; more: number } {
  const live = shown.filter((card) => !card.leaving)
  const cards = [...live.slice(-TASK_CARDS_VISIBLE), ...shown.filter((card) => card.leaving)]
  return { cards, more: Math.max(0, live.length - TASK_CARDS_VISIBLE) }
}

/** Cards whose phase changed since the previous live list: each is announced once. */
export function changedTaskCards(previous: readonly TaskCardView[], live: readonly TaskCardView[]): TaskCardView[] {
  const before = new Map(previous.map((view) => [view.cardId, view.phase]))
  return live.filter((view) => before.get(view.cardId) !== view.phase)
}
