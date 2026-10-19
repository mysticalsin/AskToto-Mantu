import { ArchiveRestore, X } from 'lucide-react'

export interface RecoveredDraftToastProps {
  count: number
  onOpenHistory: () => void
  onDismiss: () => void
}

/** Announces only a count; recovered meeting content stays in History and never enters notification state. */
export function RecoveredDraftToast({ count, onOpenHistory, onDismiss }: RecoveredDraftToastProps): JSX.Element | null {
  if (!Number.isSafeInteger(count) || count < 1) return null
  return (
    <div role="status" aria-live="polite" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <ArchiveRestore size={14} className="text-[var(--color-accent-2)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[color:var(--color-ink)]">
            {count} interrupted meeting{count === 1 ? '' : 's'} recovered
          </div>
          <div className="text-[11px] leading-snug text-[color:var(--color-ink-2)]">
            Open History to review{count === 1 ? ' it' : ' them'}.
          </div>
        </div>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-[11px] font-medium text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent-soft)]"
          onClick={onOpenHistory}
        >
          Open History
        </button>
        <button
          type="button"
          aria-label="Dismiss recovered meetings notice"
          className="rounded p-1 text-[color:var(--color-ink-2)] hover:bg-[var(--color-accent-soft)]"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
