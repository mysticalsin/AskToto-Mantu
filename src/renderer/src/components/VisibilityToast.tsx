import { useEffect, useRef } from 'react'
import { Eye, EyeOff } from 'lucide-react'

const AUTO_DISMISS_MS = 2600

export type VisibilityToastState = 'hidden' | 'visible' | null

export interface VisibilityToastProps {
  state: VisibilityToastState
  onDismiss: () => void
}

/** Confirms the eye (visible/invisible) toggle actually did something. Hiding AskToto from a screen
 *  share has NO effect on the user's own screen — it only changes what others see in Zoom/Teams/a
 *  recording — so without this the click feels broken ("I'm not seeing the screen change"). This is the
 *  moment-of-click confirmation; the bar's calm-rainbow contour is the persistent at-a-glance state. */
export function VisibilityToast({ state, onDismiss }: VisibilityToastProps): JSX.Element | null {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (!state) return
    const t = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
    // Keyed on `state` alone so a fresh onDismiss closure each parent render doesn't restart the timer;
    // toggling hidden↔visible restarts it (the value changes), which is the intended behavior.
  }, [state])

  if (!state) return null

  const hidden = state === 'hidden'
  const Icon = hidden ? EyeOff : Eye

  return (
    <div role="status" aria-live="polite" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <Icon size={14} className="text-[var(--color-accent-2)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">
            {hidden ? 'Hidden from screen sharing' : 'Visible on shared screens'}
          </div>
          <div className="truncate text-[11px] leading-snug text-[color:var(--color-ink-2)]">
            {hidden
              ? 'Others won’t see AskToto when you share or record your screen.'
              : 'AskToto will now appear if you share or record your screen.'}
          </div>
        </div>
      </div>
    </div>
  )
}
