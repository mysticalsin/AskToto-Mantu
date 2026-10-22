import { useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { createShortcutFailureAnnouncer } from '../lib/shortcut-failures'

const AUTO_DISMISS_MS = 12_000

// One announcer per renderer session: a failure set is shown once, then stays quiet until it changes.
const announce = createShortcutFailureAnnouncer()

/**
 * D10-5: a hotkey Métis could not bind (another app holds it, or the OS reserves it) used to be visible only
 * in Settings → Shortcuts. Pulls the current failures on mount (boot can finish before this renderer
 * subscribes) and listens for each re-registration. Returns the toast copy, or null.
 */
export function useShortcutFailureToast(): { message: string | null; dismiss: () => void } {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    const show = (failures: Parameters<typeof announce>[0]): void => {
      const next = announce(failures)
      if (next) setMessage(next)
    }
    let live = true
    let off = (): void => {}
    // A toast must never take the overlay down: a missing or failing bridge just means no toast.
    try {
      void window.toto
        .getShortcutFailures()
        .then((failures) => live && show(failures))
        .catch(() => {})
      off = window.toto.onShortcutFailures((failures) => show(failures))
    } catch {
      /* no shortcut toast */
    }
    return () => {
      live = false
      off()
    }
  }, [])
  return { message, dismiss: () => setMessage(null) }
}

export interface ShortcutFailureToastProps {
  message: string | null
  onOpenShortcuts: () => void
  onDismiss: () => void
}

/** Non-modal, so a launch-time conflict never blocks the overlay (HIG A1). Same family as OperatorGateToast. */
export function ShortcutFailureToast({
  message,
  onOpenShortcuts,
  onDismiss
}: ShortcutFailureToastProps): JSX.Element | null {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [message])

  if (!message) return null

  return (
    <div role="status" aria-live="polite" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <Keyboard size={14} className="text-[var(--color-accent-text)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[color:var(--color-ink)]">Shortcut not available</div>
          <div className="text-[11px] leading-snug text-[color:var(--color-ink-2)]">{message}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            onOpenShortcuts()
            onDismiss()
          }}
          className="no-drag focus-ring shrink-0 rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110"
        >
          Open Shortcuts
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="no-drag focus-ring shrink-0 rounded-lg px-1.5 py-1 text-[12px] text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
