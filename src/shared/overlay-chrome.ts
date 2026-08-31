/**
 * Overlay chrome modes (hide / island / bar). Shared so Settings, the renderer rest surface,
 * and main geometry all read one enum. Default is hide-until-hover (fresh install).
 */

export const OVERLAY_LAYOUTS = ['hide', 'island', 'bar'] as const
export type OverlayLayout = (typeof OVERLAY_LAYOUTS)[number]

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = 'hide'

export const OVERLAY_LAYOUT_COPY: Record<OverlayLayout, { title: string; desc: string }> = {
  hide: {
    title: 'Hide',
    desc: 'Hidden until you move to the top.'
  },
  island: {
    title: 'Island',
    desc: 'A small island stays visible. Hover opens it.'
  },
  bar: {
    title: 'Bar',
    desc: 'The bar stays on screen.'
  }
}

export function isOverlayLayout(v: unknown): v is OverlayLayout {
  return v === 'hide' || v === 'island' || v === 'bar'
}

export function parseOverlayLayout(v: unknown): OverlayLayout {
  return isOverlayLayout(v) ? v : DEFAULT_OVERLAY_LAYOUT
}

/** Hide and island rest collapsed and reveal on hover. Bar does not. */
export function overlayUsesHover(layout: OverlayLayout): boolean {
  return layout === 'hide' || layout === 'island'
}

export function overlayRestsHidden(layout: OverlayLayout): boolean {
  return layout === 'hide'
}

/** Hide and island park at the display top (`bounds.y`) so island hover hits. Bar uses workArea + margin. */
export function overlayUsesSafeTop(layout: OverlayLayout): boolean {
  return layout === 'hide' || layout === 'island'
}

export function autoHideOverlayForLayout(layout: OverlayLayout): boolean {
  return overlayUsesHover(layout)
}

/** Minimize-to-circle is Bar only. Hide and Island ignore minimize. */
export function overlayAllowsMinimize(layout: OverlayLayout): boolean {
  return layout === 'bar'
}

/**
 * The sentient circle exists only as Bar's minimized rest.
 * Hide idle and Island never show it — even if a leftover minimized flag is true.
 */
export function overlayShowsBarOrb(layout: OverlayLayout, minimized: boolean): boolean {
  return layout === 'bar' && minimized
}

/**
 * Map a sparse on-disk user layer onto a layout.
 * - Already has overlayLayout → keep it (Settings switch, no reinstall).
 * - Legacy autoHideOverlay false → bar.
 * - Legacy autoHideOverlay true → island (the always-visible peek they already have).
 * - Neither → undefined so DEFAULT_OVERLAY_LAYOUT (hide) applies on a fresh install.
 */
export function migrateOverlayLayout(raw: Record<string, unknown>): OverlayLayout | undefined {
  if (isOverlayLayout(raw.overlayLayout)) return raw.overlayLayout
  if (raw.autoHideOverlay === false) return 'bar'
  if (raw.autoHideOverlay === true) return 'island'
  return undefined
}
