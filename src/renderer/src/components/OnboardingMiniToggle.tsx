/** Act 3's opt-out toggle (screenAsk) — a small local switch so this scene doesn't need to reach into
 *  Settings.tsx's `Toggle` (which is styled against the separate `--cl-*` settings-panel token set this
 *  onboarding shell never mounts). Same on/off mechanics, themed with the onboarding's own
 *  `--color-accent` tokens instead. */
export function MiniToggle({
  on,
  onChange,
  label,
  disabled = false
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  /** Managed settings are locked: a native disabled switch, dimmed, with no pointer affordance. */
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
      className={
        'no-drag focus-ring relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-150 ' +
        (on ? 'bg-[var(--color-accent)]' : 'bg-white/15') +
        (disabled ? ' cursor-default opacity-60' : '')
      }
    >
      <span
        className={
          'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white transition-all duration-150 ' +
          (on ? 'left-[16px]' : 'left-[2px]')
        }
      />
    </button>
  )
}
