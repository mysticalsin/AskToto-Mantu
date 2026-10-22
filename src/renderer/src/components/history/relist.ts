import { useEffect, useRef } from 'react'

/** Focus and visibility changes arrive together when the window returns; one re-list per this gap is enough. */
export const RELIST_MIN_GAP_MS = 2_000

/** Whether History should re-list now: its window is visible, no search is on screen, and it has not just done so. */
export function shouldRelist(state: { visible: boolean; searching: boolean; sinceLastMs: number }): boolean {
  return state.visible && !state.searching && state.sinceLastMs >= RELIST_MIN_GAP_MS
}

/**
 * Re-lists History when the window regains focus or becomes visible, so a meeting saved or synced from another
 * device shows up without leaving and re-entering the view. `isSearching` is read at the event, never closed
 * over; `refresh` is the list fetch that shares the view's request-ordering guard.
 */
export function useRelistOnFocus(refresh: () => void, isSearching: () => boolean): void {
  const lastRef = useRef(Date.now())
  const latest = useRef({ refresh, isSearching })
  latest.current = { refresh, isSearching }
  useEffect(() => {
    const onReturn = (): void => {
      const now = Date.now()
      const visible = document.visibilityState !== 'hidden'
      if (!shouldRelist({ visible, searching: latest.current.isSearching(), sinceLastMs: now - lastRef.current }))
        return
      lastRef.current = now
      latest.current.refresh()
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [])
}
