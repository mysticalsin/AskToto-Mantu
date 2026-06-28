import {
  GraduationCap,
  Users,
  TrendingUp,
  MessageSquare,
  Settings2,
  Handshake,
  Presentation,
  Headset
} from 'lucide-react'
import type { ConversationMode } from '@shared/ipc'

const MODES: { id: ConversationMode; label: string; icon: typeof Users }[] = [
  { id: 'interview', label: 'Interview', icon: GraduationCap },
  { id: 'meeting', label: 'Meeting', icon: Users },
  { id: 'sales', label: 'Sales', icon: TrendingUp },
  { id: 'negotiation', label: 'Negotiation', icon: Handshake },
  { id: 'presentation', label: 'Presentation', icon: Presentation },
  { id: 'support', label: 'Support', icon: Headset },
  { id: 'general', label: 'General', icon: MessageSquare }
]

/**
 * Read-only badge of the active mode shown on the overlay. The mode can only be changed in
 * Settings → Personalize (Tony: no mode switching directly on the platform), so this just informs.
 */
export function ModeIndicator({ mode }: { mode: ConversationMode }): JSX.Element {
  const m = MODES.find((x) => x.id === mode) ?? MODES[3]
  return (
    <div className="no-drag inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-ink-2)]">
      <m.icon size={13} className="text-[color:var(--color-accent)]" />
      {m.label}
      <span className="ml-0.5 inline-flex items-center gap-0.5 text-[10px] text-[color:var(--color-ink-3)]">
        <Settings2 size={10} /> change in Settings
      </span>
    </div>
  )
}

export function ModePicker({
  mode,
  onChange,
  size = 'md',
  disabled = false
}: {
  mode: ConversationMode
  onChange: (m: ConversationMode) => void
  size?: 'sm' | 'md'
  disabled?: boolean
}): JSX.Element {
  const pad = size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[12px]'
  return (
    <div className="no-drag inline-flex items-center gap-0.5 rounded-full bg-white/[0.05] p-0.5">
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
              'focus-ring flex items-center gap-1.5 rounded-full font-medium transition-colors duration-[var(--duration-hover)]',
              pad,
              active
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[color:var(--color-ink-2)] hover:bg-white/10 hover:text-[color:var(--color-ink)]',
              disabled ? 'opacity-50 cursor-not-allowed' : ''
            ].join(' ')}
          >
            <m.icon size={13} />
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
