import { useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'

const DEFAULT_TIMEOUT_MS = 6000

// The detector (src/main/meeting-detect/mac.ts) reports raw process names — some read fine as-is
// ("Slack", "Discord", "RingCentral", browser names), others read like unfinished internal codes.
// Only the latter need a human label; everything else falls through unchanged.
const APP_LABELS: Record<string, string> = {
  'zoom.us': 'Zoom',
  MSTeams: 'Microsoft Teams',
  'Microsoft Teams (work or school)': 'Microsoft Teams',
  'Cisco Webex Meetings': 'Webex',
  GoTo: 'GoTo Meeting'
}

export interface MeetingDetectedToastProps {
  open: boolean
  app?: string
  /** Auto-dismiss delay in ms. Calls onDismiss — never starts recording. Defaults to 6s. */
  timeoutMs?: number
  /** User opted in — start listening now. */
  onStart: () => void
  onDismiss: () => void
}

export function MeetingDetectedToast({
  open,
  app,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onStart,
  onDismiss
}: MeetingDetectedToastProps): JSX.Element | null {
  const [remaining, setRemaining] = useState(timeoutMs)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!open) {
      // Reset so the next open always starts a fresh full-width progress bar,
      // regardless of how quickly open toggles true→false→true.
      setRemaining(timeoutMs)
      return
    }
    setRemaining(timeoutMs)
    const start = Date.now()
    const iv = setInterval(() => {
      const left = Math.max(0, timeoutMs - (Date.now() - start))
      setRemaining(left)
      if (left === 0) {
        clearInterval(iv)
        onDismissRef.current() // auto-dismiss never starts recording; it just hides the banner
      }
    }, 250)
    return () => clearInterval(iv)
  }, [open, timeoutMs])

  if (!open) return null

  const appLabel = app ? (APP_LABELS[app] ?? app) : undefined

  return (
    <div role="alert" aria-live="assertive" className="fade-up glass-strong relative overflow-hidden rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <Mic size={14} className="text-[var(--color-accent-2)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">
            Meeting detected{appLabel ? ` · ${appLabel}` : ''}
          </div>
          <div className="truncate text-[11px] leading-snug text-[color:var(--color-ink-2)]">
            Nothing is recorded until you start.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onStart}
            className="no-drag focus-ring h-[30px] shrink-0 rounded-full border border-white/10 bg-[var(--color-accent)] px-3.5 text-[12px] font-semibold text-white shadow-[0_2px_12px_var(--color-accent-glow)] transition-[filter] duration-[var(--duration-hover)] hover:brightness-110"
          >
            Start listening
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.08]">
        <div
          className="h-full bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] transition-[width] duration-300 ease-linear"
          style={{ width: `${(remaining / timeoutMs) * 100}%` }}
        />
      </div>
    </div>
  )
}
