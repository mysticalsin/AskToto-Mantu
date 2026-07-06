import {
  GraduationCap,
  UserSearch,
  Users,
  TrendingUp,
  MessageSquare,
  Settings2,
  Handshake,
  Presentation,
  Headset,
  Sparkles
} from 'lucide-react'
import { modeLabel } from '@shared/ipc'
import type { CustomMode } from '@shared/ipc'

const MODES: { id: string; label: string; icon: typeof Users }[] = [
  { id: 'general', label: 'General', icon: MessageSquare },
  { id: 'meeting', label: 'Meeting', icon: Users },
  { id: 'sales', label: 'Sales', icon: TrendingUp },
  { id: 'interview', label: 'Interview', icon: GraduationCap },
  { id: 'recruiting', label: 'Recruiting', icon: UserSearch },
  { id: 'negotiation', label: 'Negotiation', icon: Handshake },
  { id: 'presentation', label: 'Presentation', icon: Presentation },
  { id: 'support', label: 'Support', icon: Headset }
]

/**
 * Read-only badge of the active mode shown on the overlay. The mode can only be changed in
 * Settings → Personalize (Tony: no mode switching directly on the platform), so this just informs.
 */
export function ModeIndicator({
  mode,
  customModes
}: {
  mode: string
  customModes?: CustomMode[]
}): JSX.Element {
  const builtIn = MODES.find((x) => x.id === mode)
  const Icon = builtIn ? builtIn.icon : Sparkles
  const label = modeLabel(mode, customModes ?? [])
  return (
    <div className="no-drag inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-ink-2)]">
      <Icon size={13} className="text-[color:var(--color-accent-text)]" />
      {label}
      <span className="ml-0.5 inline-flex items-center gap-0.5 text-[10px] text-[color:var(--color-ink-3)]">
        <Settings2 size={10} /> change in Settings
      </span>
    </div>
  )
}

export function ModePicker({
  mode,
  onChange,
  customModes,
  size = 'md',
  disabled = false
}: {
  mode: string
  onChange: (m: string) => void
  customModes?: CustomMode[]
  size?: 'sm' | 'md'
  disabled?: boolean
}): JSX.Element {
  const pad = size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]'
  return (
    <div className="no-drag scroll-thin flex max-w-[calc(100vw-24px)] flex-nowrap items-center gap-0.5 overflow-x-auto rounded-full bg-white/[0.05] p-0.5">
      {MODES.map((m) => {
        const active = m.id === mode
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(m.id)}
            className={[
              'focus-ring flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors duration-[var(--duration-hover)]',
              pad,
              active
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]',
              disabled ? 'opacity-50 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <m.icon size={13} className="shrink-0" />
            <span className="truncate">{m.label}</span>
          </button>
        )
      })}
      {customModes?.map((cm) => {
        const active = cm.id === mode
        return (
          <button
            key={cm.id}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(cm.id)}
            className={[
              'focus-ring flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors duration-[var(--duration-hover)]',
              pad,
              active
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]',
              disabled ? 'opacity-50 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <Sparkles size={13} className="shrink-0" />
            <span className="max-w-[110px] truncate">{cm.label}</span>
          </button>
        )
      })}
    </div>
  )
}
