import { useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'

const DEFAULT_TIMEOUT_MS = 10000

export interface MeetingDetectedToastProps {
  open: boolean
  app?: string
  /** Auto-start countdown in ms. Set to a very large number to disable. Defaults to 10s. */
  timeoutMs?: number
  onCancel: () => void
  onStart: () => void
}

export function MeetingDetectedToast({
  open,
  app,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onCancel,
  onStart
}: MeetingDetectedToastProps): JSX.Element | null {
  const [remaining, setRemaining] = useState(timeoutMs)
  const onStartRef = useRef(onStart)
  onStartRef.current = onStart

  useEffect(() => {
    if (!open) return
    setRemaining(timeoutMs)
    const start = Date.now()
    const iv = setInterval(() => {
      const left = Math.max(0, timeoutMs - (Date.now() - start))
      setRemaining(left)
      if (left === 0) {
        clearInterval(iv)
        onStartRef.current()
      }
    }, 250)
    return () => clearInterval(iv)
  }, [open, timeoutMs])

  if (!open) return null

  const seconds = Math.ceil(remaining / 1000)

  return (
    <div role="alert" aria-live="assertive" className="fade-up rounded-xl border border-[var(--color-hair-soft)] bg-[var(--glass-fill-strong)] px-3.5 py-2.5 shadow-[var(--shadow-float)]">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2">
          <Mic size={15} className="shrink-0 text-[var(--color-accent)]" />
          <div>
            <div className="text-[13px] font-medium text-[color:var(--color-ink)]">
              Meeting detected{app ? ` — ${app}` : ''} — start recording?
            </div>
            <div className="text-[11px] text-[color:var(--color-ink-2)]">
              Auto-starts in {seconds}s
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="no-drag focus-ring flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
        >
          <X size={13} /> Cancel
        </button>
        <button
          type="button"
          onClick={onStart}
          className="no-drag focus-ring rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
        >
          Start Now
        </button>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full bg-[var(--color-accent)] transition-all duration-300 ease-linear"
          style={{ width: `${(remaining / timeoutMs) * 100}%` }}
        />
      </div>
    </div>
  )
}
