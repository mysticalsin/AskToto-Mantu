import { useId, type ReactNode } from 'react'
import { Info, type LucideIcon } from 'lucide-react'
import { FieldHint } from '../components/ui'
import { managedChipCls } from './ManagedChip'

export function Toggle({
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
