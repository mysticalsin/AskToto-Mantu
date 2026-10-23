import { useEffect, useRef, useState } from 'react'
import { Check, Minus, Square, TriangleAlert, X } from 'lucide-react'
import { taskCardAnnouncement, taskCardCopy, type TaskCardView } from '@shared/task-card'
import {
  changedTaskCards,
  nextShownCards,
  TASK_CARD_EXIT_MS,
  visibleTaskCards,
  type ShownTaskCard
} from '../lib/task-cards-model'
import { AgentStatus } from './AgentStatus'

export interface TaskCardsProps {
  /** Main's live list (TASK_CARD_IPC.cards). Already validated by the preload bridge. */
  cards: readonly TaskCardView[]
  onStop: (cardId: string) => void
  onDismiss: (cardId: string) => void
}

/**
 * Live desktop tasks in the sidecar (G33): what is running, what waits, what finished and whether it worked.
 * Main owns every state; this only draws it, keeps a leaving card for its exit, and announces changes once.
 * Design: G33-TASK-CARD-DESIGN.md. Never shows an argument (a note title, a query).
 */
export function TaskCards({ cards, onStop, onDismiss }: TaskCardsProps): JSX.Element | null {
  const [shown, setShown] = useState<ShownTaskCard[]>(() => nextShownCards([], cards, 0))
  const [announcement, setAnnouncement] = useState<{ polite: string; assertive: string }>({
    polite: '',
    assertive: ''
  })
  const previous = useRef<readonly TaskCardView[]>(cards)

  useEffect(() => {
    const now = Date.now()
    setShown((before) => nextShownCards(before, cards, now))
    const changed = changedTaskCards(previous.current, cards)
    previous.current = cards
    if (changed.length > 0) {
      const lines = changed.map(taskCardAnnouncement)
      setAnnouncement({
        polite: lines
          .filter((line) => line.politeness === 'polite')
          .map((line) => line.text)
          .join(' '),
        assertive: lines
          .filter((line) => line.politeness === 'assertive')
          .map((line) => line.text)
          .join(' ')
      })
    }
    // One timer clears whatever finished leaving; a later list change re-arms it.
    const timer = setTimeout(() => setShown((before) => nextShownCards(before, cards, Date.now())), TASK_CARD_EXIT_MS)
    return () => clearTimeout(timer)
  }, [cards])

  const { cards: visible, more } = visibleTaskCards(shown)
  if (visible.length === 0) return null

  return (
    <section className="task-cards" aria-label="Desktop tasks">
      {more > 0 ? (
        <p className="task-cards__more" data-task-cards-more={more}>
          {more === 1 ? '1 more task' : `${more} more tasks`}
        </p>
      ) : null}
      {visible.map(({ view, leaving }) => (
        <TaskCard key={view.cardId} view={view} leaving={leaving} onStop={onStop} onDismiss={onDismiss} />
      ))}
      <p className="sr-only" aria-live="polite">
        {announcement.polite}
      </p>
      <p className="sr-only" aria-live="assertive">
        {announcement.assertive}
      </p>
    </section>
  )
}

function TaskCard({
  view,
  leaving,
  onStop,
  onDismiss
}: {
  view: TaskCardView
  leaving: boolean
  onStop: (cardId: string) => void
  onDismiss: (cardId: string) => void
}): JSX.Element {
  const { title, status } = taskCardCopy(view)
  const titleId = `task-card-${view.cardId}-title`
  const statusId = `task-card-${view.cardId}-status`
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={statusId}
      className="task-card"
      data-task-card={view.phase}
      data-leaving={leaving ? 'true' : undefined}
    >
      <span className="task-card__mark" aria-hidden="true">
        <TaskCardMark view={view} />
      </span>
      <span className="task-card__text">
        <span id={titleId} className="task-card__title">
          {title}
        </span>
        <span id={statusId} className="task-card__status">
          {status}
        </span>
      </span>
      {view.stoppable && !leaving ? (
        <button
          type="button"
          className="task-card__control no-drag focus-ring"
          aria-label={`Stop ${title}`}
          onClick={() => onStop(view.cardId)}
        >
          <Square size={11} strokeWidth={2.4} aria-hidden="true" />
          <span>Stop</span>
        </button>
      ) : null}
      {view.dismissible && !leaving ? (
        <button
          type="button"
          className="task-card__control task-card__control--icon no-drag focus-ring"
          aria-label={`Dismiss ${title}`}
          onClick={() => onDismiss(view.cardId)}
        >
          <X size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

function TaskCardMark({ view }: { view: TaskCardView }): JSX.Element {
  switch (view.phase) {
    case 'running':
      return <AgentStatus kind="working" size="inline" caption={false} />
    case 'queued':
    case 'stopping':
      return <span className="task-card__dot" />
    case 'done':
      return <Check size={14} strokeWidth={2.4} />
    case 'not_done':
      return <Minus size={14} strokeWidth={2.4} />
    case 'uncertain':
      return <TriangleAlert size={14} strokeWidth={2.2} />
  }
}
