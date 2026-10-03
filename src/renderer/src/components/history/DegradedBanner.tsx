import { CloudOff } from 'lucide-react'
import type { DegradedBanner as Banner } from './list-status'

/** History's degraded-source banner (see degradedBanner): a failed load is an alert, the rest are status. */
export function DegradedBanner({ banner, onRetry }: { banner: Banner; onRetry: () => void }): JSX.Element {
  return (
    <div
      role={banner.kind === 'failed' ? 'alert' : 'status'}
      className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-1.5 text-[11px] leading-snug text-[color:var(--color-warn)]"
    >
      <CloudOff size={12} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{banner.message}</span>
      {banner.retry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry loading meetings"
          className="no-drag focus-ring shrink-0 rounded-full px-2 py-0.5 font-medium hover:bg-[var(--color-warn)]/15"
        >
          Retry
        </button>
      )}
    </div>
  )
}
