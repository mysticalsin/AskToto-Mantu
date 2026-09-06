/**
 * Bar rest look. Overlay chrome (hide / island / bar) stays a separate enum.
 * This key only changes the Bar circle. Hide and Island ignore it.
 */

export const OVERLAY_ORB_STYLES = ['bar', 'jakub', 'obsidian'] as const
export type OverlayOrbStyle = (typeof OVERLAY_ORB_STYLES)[number]

export const DEFAULT_OVERLAY_ORB_STYLE: OverlayOrbStyle = 'jakub'

export const OVERLAY_ORB_COPY: Record<OverlayOrbStyle, { title: string; desc: string }> = {
  bar: {
    title: 'Full bar',
    desc: 'The Ask bar stays on screen.'
  },
  jakub: {
    title: 'Circle',
    desc: 'Original thinking orb. Default rest.'
  },
  obsidian: {
    title: 'Jarvis',
    desc: 'Particle sphere. Small rest pill.'
  }
}

/** Settings cards. Circle is default (thinking-orbs). Jarvis is the particle sphere. */
export const OVERLAY_ORB_PICKER_CARDS = ['jakub', 'obsidian', 'bar'] as const
export type OverlayOrbPickerCard = (typeof OVERLAY_ORB_PICKER_CARDS)[number]

export function overlayOrbPickerSelected(style: OverlayOrbStyle): OverlayOrbPickerCard {
  return (OVERLAY_ORB_PICKER_CARDS as readonly string[]).includes(style)
    ? (style as OverlayOrbPickerCard)
    : DEFAULT_OVERLAY_ORB_STYLE
}

export function isOverlayOrbStyle(v: unknown): v is OverlayOrbStyle {
  return v === 'bar' || v === 'jakub' || v === 'obsidian'
}

export function parseOverlayOrbStyle(v: unknown): OverlayOrbStyle {
  return isOverlayOrbStyle(v) ? v : DEFAULT_OVERLAY_ORB_STYLE
}

/** Circle idle rest is Bar only. Hide/Island never collapse to an orb. */
export function overlayOrbRestIsCircle(layout: string, style: OverlayOrbStyle): boolean {
  return layout === 'bar' && (style === 'jakub' || style === 'obsidian')
}

/** Jarvis particle sphere. Bar + persist `obsidian` only. Hide/Island never show it. */
export function overlayUsesJarvisOrb(layout: string, style?: OverlayOrbStyle): boolean {
  return layout === 'bar' && style === 'obsidian'
}

/** Jakub thinking-orb. Default Circle rest and the Full-bar minimize control. */
export function overlayUsesThinkingOrb(layout: string, style?: OverlayOrbStyle): boolean {
  return layout === 'bar' && style !== 'obsidian'
}

/** Persist key may still say obsidian. Same wire as overlayUsesJarvisOrb. */
export function overlayUsesObsidianOrb(layout: string, style: OverlayOrbStyle): boolean {
  return overlayUsesJarvisOrb(layout, style)
}
