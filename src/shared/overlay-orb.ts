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
    desc: 'The bar stays on screen with a Jarvis circle.'
  },
  jakub: {
    title: 'Circle',
    desc: 'Jarvis particle orb.'
  },
  obsidian: {
    title: 'Circle',
    desc: 'Jarvis particle orb.'
  }
}

/** Settings cards. Persist still accepts jakub/obsidian; both are Circle. */
export const OVERLAY_ORB_PICKER_CARDS = ['bar', 'obsidian'] as const

export function overlayOrbPickerSelected(style: OverlayOrbStyle): 'bar' | 'obsidian' {
  return style === 'bar' ? 'bar' : 'obsidian'
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

/** Bar circle is always the tonys-jarvis particle orb. Hide/Island never show it. */
export function overlayUsesJarvisOrb(layout: string, _style?: OverlayOrbStyle): boolean {
  return layout === 'bar'
}

/** @deprecated Tony 2026-09-06: use overlayUsesJarvisOrb. Persist key may still be obsidian. */
export function overlayUsesObsidianOrb(layout: string, style: OverlayOrbStyle): boolean {
  return overlayUsesJarvisOrb(layout, style)
}
