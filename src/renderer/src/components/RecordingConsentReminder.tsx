import { useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import { AUTO_DISMISS_MS, shouldShowConsentReminder } from '../lib/consent'

export interface RecordingConsentReminderProps {
  listening: boolean
  lastReminderAt: number
  requireIndicator: boolean
  onAck: () => void
}

export function RecordingConsentReminder({
  listening,
  lastReminderAt,
  requireIndicator,
  onAck
}: RecordingConsentReminderProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ackRef = useRef(onAck)
  ackRef.current = onAck

  useEffect(() => {
    if (!listening) {
      setOpen(false)
      return
    }
    if (shouldShowConsentReminder(Date.now(), lastReminderAt, requireIndicator)) {
      setOpen(true)
      const t = setTimeout(() => {
        setOpen(false)
        ackRef.current()
      }, AUTO_DISMISS_MS)
      return () => clearTimeout(t)
    }
  }, [listening, lastReminderAt, requireIndicator])

  if (!open) return null

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="fade-up rounded-xl border border-[var(--color-danger)]/20 bg-[var(--glass-fill-strong)] px-3.5 py-2.5 shadow-[var(--shadow-float)]">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger-soft)]">
          <Mic size={14} className="text-[var(--color-danger)]" />
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-medium text-[color:var(--color-ink)]">
            AskToto is listening
          </div>
          <div className="text-[11px] leading-snug text-[color:var(--color-ink-2)]">
            Other participants are being recorded. Make sure everyone has consented.
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => {
            setOpen(false)
            onAck()
          }}
          className="no-drag focus-ring rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-ink)] hover:bg-white/10"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
