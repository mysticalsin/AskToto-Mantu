import { JarvisOrbButton } from './JarvisOrbButton'
import { ObsidianOrb } from './ObsidianOrb'
import type { OrbMood } from '../lib/bar-pill-orb'
import type { OverlayOrbStyle } from '@shared/overlay-orb'

/**
 * Bar-only minimized control: the same thinking-orb as the docked Bar circle
 * (64 avatar, 2x backing, 41 visible host).
 * Click (not drag) expands to the full bar. Hide/Island never mount this.
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
  if (orbStyle === 'obsidian') {
    return (
      <ObsidianOrb
        title={degradedNote || 'Expand Métis'}
        ariaLabel="Expand Métis"
        onActivate={onExpand}
        enableDrag
        hugWidth
      />
    )
  }
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
