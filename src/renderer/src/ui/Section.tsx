import { createContext, useContext, useState, type ComponentType, type ReactNode } from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'

// Lets a Section pick up its enclosing tab's icon automatically (Settings wraps each tab's content in a
// Provider) so most cards get sensible iconography for free; an explicit `icon` prop on a Section still
// wins, for the cards that want a more specific glyph than their tab's.
export const TabIconContext = createContext<LucideIcon | ComponentType<{ size?: number }> | undefined>(undefined)

export function Section({
  title,
  desc,
  icon,
  children
}: {
  title: string
  desc?: string
  icon?: LucideIcon | ComponentType<{ size?: number }>
  children: ReactNode
}): JSX.Element {
  const tabIcon = useContext(TabIconContext)
  const Icon = icon ?? tabIcon
  return (
    <section className="cl-card flex min-w-0 max-w-full flex-col gap-0 px-4 py-4">
      <div className="mb-3 flex items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)]">
            <Icon size={13} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug text-[color:var(--cl-foreground)]">{title}</div>
          {desc && (
            <div className="mt-1 text-[12px] text-[color:var(--cl-muted-foreground)]">{desc}</div>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

/** Like Section, but its body is collapsed behind a details-style toggle — closed on every mount, no
 *  persisted "remember this was open" state. Used for secondary content (e.g. "Experience: more
 *  models") that shouldn't compete with the primary flow for attention. */
export function ExpandableSection({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex min-w-0 max-w-full flex-col rounded-[14px] border border-dashed border-[var(--cl-border)] px-4 py-3 transition-colors hover:border-[var(--cl-input)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="no-drag cl-focus flex w-full items-center justify-between gap-2 text-left"
      >
        <div>
          <div className="text-[13px] font-semibold leading-snug text-[color:var(--cl-foreground)]">{title}</div>
          {desc && <div className="mt-1 text-[12px] text-[color:var(--cl-muted-foreground)]">{desc}</div>}
        </div>
        <ChevronDown
          size={14}
          className={[
            'mt-0.5 shrink-0 text-[color:var(--cl-muted-foreground)] transition-transform',
            open ? 'rotate-180' : ''
          ].join(' ')}
        />
      </button>
      {open && <div className="fade-up mt-3 flex flex-col gap-5">{children}</div>}
    </section>
  )
}
