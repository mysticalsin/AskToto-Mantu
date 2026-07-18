import { useState } from 'react'
import { Download, X, ChevronDown } from 'lucide-react'

export interface UpdateReadyToastProps {
  open: boolean
  version?: string
  /** Release notes for the downloaded version (the GitHub release body) — shown in the "What's new" panel. */
  notes?: string
  onRestart: () => void
  onDismiss: () => void
}

export function UpdateReadyToast({ open, version, notes, onRestart, onDismiss }: UpdateReadyToastProps): JSX.Element | null {
  const [showNotes, setShowNotes] = useState(false)
  if (!open) return null
  const trimmed = notes?.trim()

  return (
    <div role="alert" aria-live="polite" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <Download size={14} className="text-[var(--color-accent-2)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[color:var(--color-ink)]">
            Update ready{version ? ` · v${version}` : ''}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] leading-snug text-[color:var(--color-ink-2)]">
            <span className="truncate">Your meetings are kept — restart to apply.</span>
            {trimmed && (
              <button
                type="button"
                onClick={() => setShowNotes((v) => !v)}
                aria-expanded={showNotes}
                className="no-drag focus-ring inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium text-[color:var(--color-accent-2)] hover:bg-white/10"
              >
                What&apos;s new
                <ChevronDown size={11} className={showNotes ? 'rotate-180' : ''} />
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRestart}
            className="no-drag focus-ring h-[30px] shrink-0 rounded-full border border-white/10 bg-[var(--color-accent)] px-3.5 text-[12px] font-semibold text-white shadow-[0_2px_12px_var(--color-accent-glow)] transition-[filter] duration-[var(--duration-hover)] hover:brightness-110"
          >
            Restart now
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
      {trimmed && showNotes && (
        <div className="scroll-thin mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-[10px] border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-[color:var(--color-ink-2)]">
          {trimmed}
        </div>
      )}
    </div>
  )
}
