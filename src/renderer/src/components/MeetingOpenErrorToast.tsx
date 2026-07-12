import { useEffect, useRef } from 'react'
import { AlertCircle } from 'lucide-react'

const AUTO_DISMISS_MS = 4200

export interface MeetingOpenErrorToastProps {
  message: string | null
  onDismiss: () => void
}

/** Opening a meeting that can't be read (missing file, corrupt transcript, or encrypted on a different
 *  device) used to be a silent no-op — the click just did nothing, with zero feedback distinguishing
 *  "the app is broken" from "this file is unreadable". Surfaces recallRead's own error string instead. */
export function MeetingOpenErrorToast({ message, onDismiss }: MeetingOpenErrorToastProps): JSX.Element | null {
  // Keyed on `message` alone — App passes a fresh inline onDismiss closure every render, and including it
  // in the deps would restart the auto-dismiss timer on every parent re-render.
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [message])

  if (!message) return null

  return (
    <div role="alert" aria-live="assertive" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger-soft)]">
          <AlertCircle size={14} className="text-[var(--color-danger)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">
            Couldn’t open this meeting
          </div>
          <div className="truncate text-[11px] leading-snug text-[color:var(--color-ink-2)]">{message}</div>
        </div>
      </div>
    </div>
  )
}
