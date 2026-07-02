import { useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'

const AUTO_DISMISS_MS = 3000

export interface NewMeetingToastProps {
  open: boolean
  onDismiss: () => void
}

/** Confirms "New meeting" actually did something — it silently ends the live meeting and resets the
 *  timer to 0:00 with no other visible change, so a misclick mid-call is easy to miss (the only signal
 *  otherwise is the timer snapping back to zero). Auto-dismisses; this is informational, not actionable —
 *  the save already happened by the time this shows. */
export function NewMeetingToast({ open, onDismiss }: NewMeetingToastProps): JSX.Element | null {
  // Keyed on `open` alone — App passes a fresh inline `onDismiss` closure every render, and including it
  // in the deps would restart the 3s timer on every parent re-render (App re-renders often), so the toast
  // would never actually auto-dismiss during any ongoing activity.
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [open])

  if (!open) return null

  return (
    <div role="status" aria-live="polite" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <Plus size={14} className="text-[var(--color-accent-2)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">
            Previous meeting saved
          </div>
          <div className="truncate text-[11px] leading-snug text-[color:var(--color-ink-2)]">
            New session started.
          </div>
        </div>
      </div>
    </div>
  )
}
