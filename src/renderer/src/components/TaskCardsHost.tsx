import { useCallback, useEffect, useState } from 'react'
import type { TaskCardView } from '@shared/task-card'
import { TaskCards } from './TaskCards'

/**
 * Subscribes the sidecar to main's task cards (G33). Main pushes the full list on every change and owns every
 * state; Stop and Dismiss are requests that main may refuse, and the next pushed list is the answer.
 */
export function useTaskCards(): {
  cards: TaskCardView[]
  stop: (cardId: string) => void
  dismiss: (cardId: string) => void
} {
  const [cards, setCards] = useState<TaskCardView[]>([])
  useEffect(() => {
    const api = window.toto?.taskCards
    if (!api) return
    let live = true
    let receivedPush = false
    const unsubscribe = api.onCards((next) => {
      receivedPush = true
      if (live) setCards(next)
    })
    void api
      .list()
      .then((initial) => {
        if (live && !receivedPush) setCards(initial)
      })
      .catch(() => {})
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  const stop = useCallback((cardId: string) => {
    void window.toto?.taskCards?.stop(cardId).catch(() => {})
  }, [])
  const dismiss = useCallback((cardId: string) => {
    void window.toto?.taskCards?.dismiss(cardId).catch(() => {})
  }, [])
  return { cards, stop, dismiss }
}

export function TaskCardsHost(): JSX.Element | null {
  const { cards, stop, dismiss } = useTaskCards()
  return <TaskCards cards={cards} onStop={stop} onDismiss={dismiss} />
}
