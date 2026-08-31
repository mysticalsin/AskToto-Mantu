import { JarvisOrbButton } from './JarvisOrbButton'
import type { OrbMood } from '../lib/bar-pill-orb'

/**
 * Bar-only minimized control: the same 52 glass sphere as the docked Bar circle.
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
  /** Tooltip only. Rec-dot stays red on the sphere. */
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
