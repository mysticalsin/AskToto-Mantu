import { Mic } from 'lucide-react'

function clock(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

/** Highly visible, floating recording indicator shown while Listen is active.
 *  Complements the compact bar pill so the user can see mic state at a glance. */
export function RecordingIndicator({ seconds }: { seconds: number }): JSX.Element {
  return (
    <div className="fade-up pointer-events-none absolute -bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-danger)] shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
      <span className="rec-dot h-[6px] w-[6px] rounded-full bg-[var(--color-danger)]" />
      <Mic size={11} />
      Recording {clock(seconds)}
    </div>
  )
}
