/**
 * A transient popover beside the control that opened it (G69): dismiss reasons, the accept receipt, the edit field.
 * Transient UI sits at the pointer's control, persistent UI at the top edge. Escape or a click outside closes it and
 * returns focus to the trigger.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const GAP = 6
const MARGIN = 8

export function AnchoredPopover({
  anchor,
  label,
  onClose,
  children
}: {
  anchor: HTMLElement | null
  label: string
  onClose: () => void
  children: ReactNode
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const width = ref.current?.offsetWidth ?? 0
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN))
    setPos({ top: rect.bottom + GAP, left })
  }, [anchor])

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('button, input, [tabindex]')
    first?.focus()
    const close = (): void => {
      onClose()
      anchor?.focus()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target && !ref.current?.contains(target) && !anchor?.contains(target)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [anchor, onClose])

  if (!anchor) return null
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="no-drag glass-strong z-50 flex max-w-[280px] flex-col gap-1 rounded-[12px] px-2 py-2 text-[12px] text-[color:var(--cl-foreground)]"
    >
      {children}
    </div>
  )
}
