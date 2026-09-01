import { RefreshCw } from 'lucide-react'
import { InlineOrb } from './AgentStatus'

/**
 * Update Intelligence control. Shows Updating + a working orb the instant the click is in flight.
 * The parent owns the invoke; this only makes the working state honest and visible.
 */
export function IntelligenceUpdateButton({
  updating,
  disabled,
  onClick,
  variant = 'header',
  idleLabel = 'Update Intelligence',
  title = 'Recap missing summaries and extract people, accounts, deals, coaching, and Today'
}: {
  updating: boolean
  disabled?: boolean
  onClick: () => void
  variant?: 'header' | 'text' | 'accent' | 'retry'
  idleLabel?: string
  title?: string
}): JSX.Element {
  const label = updating ? 'Updating…' : idleLabel
  const icon = updating ? <InlineOrb kind="searching" /> : <RefreshCw size={variant === 'text' ? 11 : 13} />
  const className =
    variant === 'accent'
      ? 'no-drag focus-ring rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-[var(--color-accent-2)] disabled:opacity-50'
      : variant === 'retry'
        ? 'no-drag focus-ring shrink-0 rounded-full bg-white/[0.08] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-ink)] hover:bg-white/[0.14] disabled:opacity-50'
        : variant === 'text'
          ? 'no-drag focus-ring flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)] disabled:opacity-40'
          : 'no-drag focus-ring flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink)] disabled:opacity-50'
  return (
    <button
      type="button"
      data-intelligence-update=""
      onClick={onClick}
      disabled={disabled || updating}
      title={title}
      aria-busy={updating || undefined}
      className={className}
    >
      {icon}
      {label}
    </button>
  )
}
