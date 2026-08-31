import { JarvisOrbButton } from './JarvisOrbButton'
import type { OrbMood } from '../lib/bar-pill-orb'

/**
 * Bar-only minimized control: the same thinking-orb as the docked Bar circle
 * (64 canvas, ~20% smaller visible host).
 * Click (not drag) expands to the full bar. Hide/Island never mount this.
 */
export function ControlPill({
  onExpand,
  orbMood = 'idle',
  listening = false,
  degradedNote
}: {
  onExpand: () => void
  orbMood?: OrbMood
  listening?: boolean
  /** Tooltip only. Listen is the listening orb, not a rec-dot on this circle. */
  degradedNote?: string | null
}): JSX.Element {
  return (
    <JarvisOrbButton
      orbMood={orbMood}
      listening={listening}
      title={degradedNote || 'Expand Métis'}
      ariaLabel="Expand Métis"
      onActivate={onExpand}
      enableDrag
      hugWidth
    />
  )
}
