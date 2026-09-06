import { ObsidianOrb } from './ObsidianOrb'
import type { OrbMood } from '../lib/bar-pill-orb'
import type { OverlayOrbStyle } from '@shared/overlay-orb'

/**
 * Bar-only minimized control: Jarvis particle orb (tonys-jarvis) in the 41 host.
 * Click (not drag) expands to the full bar. Hide/Island never mount this.
 * Never a gray box or CSS rings.
 */
export function ControlPill({
  onExpand,
  orbMood = 'idle',
  listening = false,
  degradedNote,
  orbStyle = 'bar'
}: {
  onExpand: () => void
  orbMood?: OrbMood
  listening?: boolean
  /** Tooltip only. Listen is the listening orb, not a rec-dot on this circle. */
  degradedNote?: string | null
  orbStyle?: OverlayOrbStyle
}): JSX.Element {
  return (
    <ObsidianOrb
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
