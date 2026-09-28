import {
  createContext,
  useContext,
  useId,
  type ComponentType,
  type ReactNode
} from 'react'
import { Info, type LucideIcon } from 'lucide-react'
import { FieldHint } from '../components/ui'

// Shared control class for inputs + native <select>s. The trailing bits fix a Windows-only bug where a
// native <select> rendered as a blank white box (white text on a white native control) until you clicked
// it to open the popup: `[color-scheme:dark]` makes Chromium paint the native select control dark on
// Windows, and the `[&>option]:…` rules give the dropdown options an explicit dark background + light text
// (Windows renders <option> from its OWN colors, defaulting to white — the app's bg/text don't cascade in).
// The `option` selector only matches <select> children, so plain inputs sharing this class are unaffected.
export const ctl =
  'no-drag font-body cl-input cl-focus min-w-0 max-w-full px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)] [color-scheme:dark] [&>option]:bg-[#1A0033] [&>option]:text-white'

/**
 * Settings tabpanel scroll classes. Vertical scroll only — overflow-x must stay hidden/clip.
 * overflow-y-auto alone computes overflow-x: auto (CSS overflow pairing), which is the Win
 * Settings sideways-pan bug on Audio / AI.
 */
export const SETTINGS_CONTENT_SCROLL_CLASS =
  'cl-content scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden'

const OVERFLOW_X_CLIP = new Set(['overflow-x-hidden', 'overflow-x-clip'])
const OVERFLOW_X_ALLOW = new Set(['overflow-x-auto', 'overflow-x-scroll', 'overflow-x-visible'])
const OVERFLOW_Y_SCROLL = new Set(['overflow-y-auto', 'overflow-y-scroll'])

/** True when a Settings scroll-root class allows Y scroll and clips X (no sideways bar/pan). */
export function settingsScrollClipsOverflowX(className: string): boolean {
  const tokens = className.trim().split(/\s+/)
  const allowsY = tokens.some((t) => OVERFLOW_Y_SCROLL.has(t))
  const clipsX = tokens.some((t) => OVERFLOW_X_CLIP.has(t))
  const allowsX = tokens.some((t) => OVERFLOW_X_ALLOW.has(t))
  return allowsY && clipsX && !allowsX
}

export const managedChipCls =
  'inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-1.5 py-0 text-[10px] font-medium text-[color:var(--cl-primary)]'

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

function Toggle({
  id,
  on,
  onChange,
  label,
  disabled = false
}: {
  id?: string
  on: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        if (disabled) return
        e.stopPropagation()
        onChange(!on)
      }}
      className={[
        'no-drag cl-focus relative h-[24px] w-[42px] shrink-0 rounded-full transition-colors duration-[var(--duration-hover)]',
        on ? 'bg-[var(--cl-primary)]' : 'bg-white/15',
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-[2px] h-[20px] w-[20px] rounded-full bg-white transition-all duration-[var(--duration-hover)]',
          on ? 'left-[20px]' : 'left-[2px]'
        ].join(' ')}
      />
    </button>
  )
}

export function ToggleRow({
  label,
  desc,
  on,
  onChange,
  children,
  disabled = false,
  icon: Icon
}: {
  label: string
  desc: string
  on: boolean
  onChange: (v: boolean) => void
  children?: ReactNode
  disabled?: boolean
  icon?: LucideIcon
}): JSX.Element {
  const id = useId()
  const toggleId = `${id}-toggle`
  return (
    <label
      htmlFor={toggleId}
      className={[
        'no-drag flex w-full items-center justify-between gap-3 rounded-[var(--cl-radius)] px-1 py-2 text-left',
        disabled ? 'cursor-default' : 'cursor-pointer'
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
          {Icon && <Icon size={14} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />}
          {label}
          {desc && (
            <FieldHint text={desc}>
              <Info size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]" />
            </FieldHint>
          )}
          {disabled && <span className={managedChipCls}>Managed by your organization</span>}
        </div>
        {children}
      </div>
      <Toggle id={toggleId} on={on} onChange={onChange} label={label} disabled={disabled} />
    </label>
  )
}
