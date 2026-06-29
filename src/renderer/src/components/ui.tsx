import type { ReactNode } from 'react'

export function IconButton({
  children,
  onClick,
  title,
  active = false,
  danger = false,
  solid = false
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  active?: boolean
  danger?: boolean
  /** Accent-filled primary action (the hero submit pill). */
  solid?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={[
        'no-drag focus-ring-strong grid h-[30px] w-[30px] place-items-center rounded-full transition-[transform,background-color,color] duration-[var(--duration-hover)] ease-[var(--ease-spring)] active:scale-[0.9]',
        solid
          ? 'bg-[var(--color-accent)] text-white shadow-[0_4px_14px_-4px_rgba(127,0,218,0.45)] hover:brightness-110'
          : active
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            : danger
              ? 'text-[var(--color-danger)] hover:bg-white/10'
              : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="font-ui rounded-[5px] border border-[var(--color-hair-soft)] bg-white/[0.06] px-1.5 py-0.5 text-[10px] leading-none text-[color:var(--color-ink-3)]">
      {children}
    </kbd>
  )
}

export function Spinner({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="status"
      aria-label="Loading"
      className="loading-spinner animate-spin text-[color:var(--color-ink-2)]"
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
