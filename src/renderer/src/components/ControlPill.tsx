import { JarvisOrbButton } from './JarvisOrbButton'
import type { OrbMood } from '../lib/bar-pill-orb'

/**
 * Bar-only minimized control: Fit Studio sentient circle.
 * Click (not drag) expands to the full bar. Hide/Island never mount this.
 */
export function ControlPill({
  onExpand,
  orbMood = 'idle',
  degradedNote
}: {
  onExpand: () => void
  orbMood?: OrbMood
  /** Tooltip only. Rec-dot stays elsewhere; do not paint this sphere red. */
  degradedNote?: string | null
}): JSX.Element {
  return (
    <JarvisOrbButton
      orbMood={orbMood}
      title={degradedNote || 'Expand Métis'}
      ariaLabel="Expand Métis"
      onActivate={onExpand}
      enableDrag
      hugWidth
    />
  )
}
