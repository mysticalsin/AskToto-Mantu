import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

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
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-2)]'
            : danger
              ? 'text-[var(--color-danger)] hover:bg-white/10'
              : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** Rounded-full action pill — the single source-of-truth for chip geometry across the app.
 *  variant 'neutral': semi-transparent surface, ink-2 label, brightens on hover.
 *  variant 'accent':  solid accent fill, white label, brightens on hover.
 *  Optionally renders a left-aligned icon at size 13. */
export function Chip({
  icon: Icon,
  children,
  onClick,
  variant = 'neutral',
  title,
  disabled
}: {
  icon?: LucideIcon
  children: ReactNode
  onClick: () => void
  variant?: 'neutral' | 'accent'
  title?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={[
        'no-drag focus-ring flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors duration-[var(--duration-hover)]',
        'disabled:opacity-60 disabled:pointer-events-none',
        variant === 'accent'
          ? 'bg-[var(--color-accent)] text-white hover:brightness-110'
          : 'bg-white/[0.08] text-white hover:bg-white/[0.16]'
      ].join(' ')}
    >
      {Icon && (
        <Icon
          size={13}
          className={variant === 'neutral' ? 'text-[var(--color-accent-2)]' : undefined}
        />
      )}
      {/* Only wrap a plain text/number label in the truncate span. Call sites that compose their own
          icon + text (or text + <kbd>) as children must keep them as separate flex-row siblings, or a
          single truncate span glues them together with no gap. */}
      {typeof children === 'string' || typeof children === 'number' ? (
        <span className="truncate">{children}</span>
      ) : (
        children
      )}
    </button>
  )
}

/** Low-emphasis inline text action — secondary/tertiary surface with optional left icon at size 11.
 *  Pass `ariaLabel` for icon-only buttons that have no visible text. */
export function TextButton({
  icon: Icon,
  children,
  onClick,
  title,
  disabled,
  ariaLabel
}: {
  icon?: LucideIcon
  children?: ReactNode
  onClick?: () => void
  title?: string
  disabled?: boolean
  ariaLabel?: string
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className="no-drag focus-ring flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)] disabled:opacity-40"
    >
      {Icon && <Icon size={11} />}
      {children != null &&
        (typeof children === 'string' || typeof children === 'number' ? (
          <span className="truncate">{children}</span>
        ) : (
          children
        ))}
    </button>
  )
}

/** Instant custom tooltip on hover — same mechanism as Bar.tsx's IconTool, reused here so Settings
 *  can move a control's explanation off always-visible body text and onto a hover trigger (e.g. an
 *  info glyph next to the label). Unlike IconTool's tooltip (a few words, `whitespace-nowrap`), Settings
 *  descriptions run full sentences — this wraps at a fixed width instead of stretching off-screen. */
export function FieldHint({ text, children }: { text: string; children: ReactNode }): JSX.Element {
  return (
    <span className="group focus-ring relative inline-flex" tabIndex={0} role="button" aria-label={text}>
      {children}
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-max max-w-[260px] rounded-lg bg-black/90 px-2.5 py-1.5 text-left text-[11px] font-medium leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100">
        {text}
      </span>
    </span>
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
