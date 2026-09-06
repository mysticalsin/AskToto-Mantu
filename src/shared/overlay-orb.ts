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

/** Settings cards. Circle is default (thinking-orbs). Jarvis is the particle sphere. No Full bar. */
export const OVERLAY_ORB_PICKER_CARDS = ['jakub', 'obsidian'] as const
export type OverlayOrbPickerCard = (typeof OVERLAY_ORB_PICKER_CARDS)[number]

export function overlayOrbPickerSelected(style: OverlayOrbStyle): OverlayOrbPickerCard {
  return style === 'obsidian' ? 'obsidian' : 'jakub'
}

export function isOverlayOrbStyle(v: unknown): v is OverlayOrbStyle {
  return v === 'bar' || v === 'jakub' || v === 'obsidian'
}

export function parseOverlayOrbStyle(v: unknown): OverlayOrbStyle {
  return isOverlayOrbStyle(v) ? v : DEFAULT_OVERLAY_ORB_STYLE
}

/** Visible Circle / Jarvis host. Same as renderer BAR_PILL_VISIBLE_PX. */
export const CIRCLE_REST_HOST_PX = 41
/** Shadow / glow pad on the 41 host. Same as IPC.windowResize +10. */
export const CIRCLE_REST_SHADOW_PAD_PX = 10
/** Mac CDP: after Bar + Circle/Jarvis minimize, viewport must land in this square band. */
export const CIRCLE_REST_VIEWPORT_MAX_PX = 60

/** Circle idle rest is Bar only. Hide/Island never collapse to an orb. */
export function overlayOrbRestIsCircle(layout: string, style: OverlayOrbStyle): boolean {
  return layout === 'bar' && (style === 'jakub' || style === 'obsidian')
}

/** Circle / Jarvis picker cards exist only when Overlay chrome is Bar. */
export function overlayShowsBarRestPicker(layout: unknown): boolean {
  return layout === 'bar'
}

/** 41 host + shadow pad. Never 220 × lastBarHeight. */
export function circleRestWindowPx(): number {
  return CIRCLE_REST_HOST_PX + CIRCLE_REST_SHADOW_PAD_PX
}

/**
 * Collapse bounds for Circle (jakub) and Jarvis (obsidian) on Bar.
 * Hide/Island and Full bar return null so park / PILL_WIDTH stay untouched.
 */
export function minimizedCircleRestBounds(input: {
  layout: string
  style: OverlayOrbStyle
}): { width: number; height: number } | null {
  if (!overlayOrbRestIsCircle(input.layout, input.style)) return null
  const px = circleRestWindowPx()
  return { width: px, height: px }
}

/** Totos-Mac live fail: 220×192 with jarvis-particles. Pass only a 41–60 square. */
export function isCircleRestWrongSlab(win: { width: number; height: number }): boolean {
  const inBand = (n: number): boolean => n >= CIRCLE_REST_HOST_PX && n <= CIRCLE_REST_VIEWPORT_MAX_PX
  return !(inBand(win.width) && inBand(win.height))
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

/**
 * Auto-collapse only when the user just picked Circle/Jarvis (`styleChanged`).
 * Settings defers this until Done (view leaves settings). Every expanded
 * frame used to hit `!minimized` and snap Expand Métis back.
 */
export function decideCircleRestMinimize(input: {
  layout: string
  style: OverlayOrbStyle
  minimized: boolean
  styleChanged: boolean
}): 'minimize' | 'expand' | 'stay' {
  if (input.layout === 'bar' && input.style === 'bar' && input.minimized) return 'expand'
  if (!overlayOrbRestIsCircle(input.layout, input.style)) return 'stay'
  if (input.styleChanged && !input.minimized) return 'minimize'
  return 'stay'
}
