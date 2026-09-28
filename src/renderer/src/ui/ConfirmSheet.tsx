import { AlertTriangle, Save, Trash2, X } from 'lucide-react'
import type { NavigationGuardChoice, NavigationGuardRequest } from '../lib/navigation-guard'

export function ConfirmSheet({
  request,
  onChoose
}: {
  request: NavigationGuardRequest | null
  onChoose: (choice: NavigationGuardChoice, id: number) => void
}): JSX.Element | null {
  if (!request) return null
  return (
    <div className="pointer-events-auto absolute inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 rounded-[20px] bg-black/45 backdrop-blur-sm" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={`navigation-guard-title-${request.id}`}
        aria-describedby={`navigation-guard-message-${request.id}`}
        className="glass-strong relative w-full max-w-[420px] rounded-2xl border border-white/15 p-4 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--color-warn,#fac775)]/14 text-[color:var(--color-warn,#fac775)]">
            <AlertTriangle size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={`navigation-guard-title-${request.id}`} className="m-0 text-[14px] font-semibold text-[color:var(--color-ink)]">
              {request.title}
            </h2>
            <p id={`navigation-guard-message-${request.id}`} className="m-0 mt-1 text-[12px] leading-snug text-[color:var(--color-ink-2)]">
              {request.message}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onChoose('cancel', request.id)}
            className="no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-white/12 bg-white/[0.03] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/[0.08]"
          >
            <X size={13} />
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => onChoose('discard', request.id)}
            className={[
              'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[12px] font-semibold transition-colors',
              request.destructive
                ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/18'
                : 'border-white/12 bg-white/[0.04] text-[color:var(--color-ink)] hover:bg-white/[0.1]'
            ].join(' ')}
          >
            <Trash2 size={13} />
            {request.discardLabel ?? 'Discard'}
          </button>
          <button
            type="button"
            onClick={() => onChoose('save', request.id)}
            className="no-drag focus-ring flex items-center gap-1.5 rounded-[10px] bg-[var(--color-accent)] px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"
          >
            <Save size={13} />
            {request.saveLabel ?? 'Save'}
          </button>
        </div>
      </section>
    </div>
  )
}
