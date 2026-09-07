import { useEffect, useRef } from 'react'
import { ShieldAlert } from 'lucide-react'

const AUTO_DISMISS_MS = 4200

export interface OperatorGateToastProps {
  message: string | null
  onDismiss: () => void
}

/** PLAN.md P2.2b #2: an Operator-gated action (Listen today) refused because this seat's tier doesn't
 *  include it, Operator hasn't confirmed the seat yet, or the grace window has elapsed. Mirrors
 *  MeetingOpenErrorToast's shape (auto-dismiss, role="alert") — same toast family, different reason. */
export function OperatorGateToast({ message, onDismiss }: OperatorGateToastProps): JSX.Element | null {
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
          <ShieldAlert size={14} className="text-[var(--color-danger)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">Not available</div>
          <div className="truncate text-[11px] leading-snug text-[color:var(--color-ink-2)]">{message}</div>
        </div>
      </div>
    </div>
  )
}
