import { Download, X } from 'lucide-react'

export interface UpdateReadyToastProps {
  open: boolean
  version?: string
  onRestart: () => void
  onDismiss: () => void
}

export function UpdateReadyToast({ open, version, onRestart, onDismiss }: UpdateReadyToastProps): JSX.Element | null {
  if (!open) return null

  return (
    <div role="alert" aria-live="polite" className="fade-up rounded-xl border border-[var(--color-hair-soft)] bg-[var(--glass-fill-strong)] px-3.5 py-2.5 shadow-[var(--shadow-float)]">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2">
          <Download size={15} className="shrink-0 text-[var(--color-accent)]" />
          <div>
            <div className="text-[13px] font-medium text-[color:var(--color-ink)]">
              Update ready{version ? ` · v${version}` : ''}
            </div>
            <div className="text-[11px] text-[color:var(--color-ink-2)]">Restart to apply it.</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRestart}
          className="no-drag focus-ring rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
        >
          Restart now
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="no-drag focus-ring flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
