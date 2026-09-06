/**
 * Bar rest look. Overlay chrome (hide / island / bar) stays a separate enum.
 * This key only changes the Bar circle. Hide and Island ignore it.
 */

export const OVERLAY_ORB_STYLES = ['bar', 'jakub', 'obsidian'] as const
export type OverlayOrbStyle = (typeof OVERLAY_ORB_STYLES)[number]

export const DEFAULT_OVERLAY_ORB_STYLE: OverlayOrbStyle = 'bar'

export const OVERLAY_ORB_COPY: Record<OverlayOrbStyle, { title: string; desc: string }> = {
  bar: {
    title: 'Full bar',
    desc: 'The bar stays on screen.'
  },
  jakub: {
    title: 'Circle',
    desc: 'Métis orb on the bar.'
  },
  obsidian: {
    title: 'Jarvis / Obsidian',
    desc: 'Tony particle orb. Blue cloud, lines, electrons.'
  }
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

export function overlayUsesObsidianOrb(layout: string, style: OverlayOrbStyle): boolean {
  return layout === 'bar' && style === 'obsidian'
}
