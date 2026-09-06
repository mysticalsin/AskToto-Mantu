import { ObsidianOrb } from './ObsidianOrb'
import { JarvisOrbButton } from './JarvisOrbButton'
import type { OrbMood } from '../lib/bar-pill-orb'
import { overlayUsesJarvisOrb, type OverlayOrbStyle } from '@shared/overlay-orb'

/**
 * Bar-only minimized control. Default Circle is Jakub thinking-orbs.
 * Jarvis (`obsidian`) is the tonys-jarvis particle sphere.
 * Click (not drag) expands to the full bar. Hide/Island never mount this.
 * Never a gray box or CSS rings.
 */
export function ControlPill({
  onExpand,
  orbMood = 'idle',
  listening = false,
  degradedNote,
  orbStyle = 'jakub'
}: {
  onExpand: () => void
  orbMood?: OrbMood
  listening?: boolean
  /** Tooltip only. Listen is the listening orb, not a rec-dot on this circle. */
  degradedNote?: string | null
  orbStyle?: OverlayOrbStyle
}): JSX.Element {
  const title = degradedNote || 'Expand Métis'
  if (overlayUsesJarvisOrb('bar', orbStyle)) {
    return (
      <ObsidianOrb
        orbMood={orbMood}
        listening={listening}
        title={title}
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
      title={title}
      ariaLabel="Expand Métis"
      onActivate={onExpand}
      enableDrag
      hugWidth
    />
  )
}
