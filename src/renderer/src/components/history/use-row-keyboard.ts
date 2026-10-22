import { useCallback, type KeyboardEvent, type RefObject } from 'react'
import { neighborAfterRemoval, rowStep } from './list-keyboard'

const ROW = '[data-meeting-row]'

/**
 * Keyboard handling for History's list. Each row's main button carries `data-meeting-row`; focus on one of them
 * lets Up/Down/Home/End move the selection (and focus) between rows and Enter open the row, without a Tab stop
 * per button. `focusAfterRemoval` hands focus to the neighbouring row before a delete unmounts the focused one.
 */
export function useRowKeyboard(
  listRef: RefObject<HTMLElement | null>,
  onSelect: (file: string) => void,
  onOpen: (file: string, notDownloaded: boolean) => void
): { rowKeyDown: (event: KeyboardEvent<HTMLElement>) => void; focusAfterRemoval: (file: string) => void } {
  const rows = useCallback(
    (): HTMLElement[] => Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW) ?? []),
    [listRef]
  )
  const rowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(ROW) : null
      if (!current || event.target !== current || event.nativeEvent.isComposing) return
      const file = current.dataset.meetingRow ?? ''
      if (event.key === 'Enter') {
        event.preventDefault() // opens the row; the platform's Enter-click would only select it
        onOpen(file, current.dataset.notDownloaded === 'true')
        return
      }
      const all = rows()
      const index = all.indexOf(current)
      const to = rowStep(event.key, index, all.length)
      if (to === null) return
      event.preventDefault()
      if (to === index) return
      all[to].focus()
      all[to].scrollIntoView?.({ block: 'nearest' })
      onSelect(all[to].dataset.meetingRow ?? '')
    },
    [rows, onSelect, onOpen]
  )
  const focusAfterRemoval = useCallback(
    (file: string): void => {
      const all = rows()
      const next = neighborAfterRemoval(
        all.map((row) => row.dataset.meetingRow ?? ''),
        file
      )
      const target = all.find((row) => row.dataset.meetingRow === next)
      if (target) {
        target.focus()
        onSelect(next ?? '')
      } else listRef.current?.focus()
    },
    [rows, onSelect, listRef]
  )
  return { rowKeyDown, focusAfterRemoval }
}
