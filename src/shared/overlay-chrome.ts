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
 * The sentient circle exists only as Bar chrome.
 * Hide idle and Island never show it — even if a leftover minimized flag is true.
 */
export function overlayShowsBarOrb(layout: OverlayLayout, minimized: boolean): boolean {
  return layout === 'bar' && minimized
}

/** Bar idle docks the circle on the full bar. Hide/Island never. */
export function overlayDocksBarCircle(layout: OverlayLayout): boolean {
  return layout === 'bar'
}

/**
 * Closing Settings (or leaving any non-idle surface) onto Hide/Island must park
 * immediately. A leftover full bar or Settings-tall window is a fat hover trigger
 * and reveals Métis when Tony hits Teams mute / camera / share.
 */
export function shouldForceParkOnBecameIdle(input: { becameIdle: boolean; usesHover: boolean }): boolean {
  return input.becameIdle && input.usesHover
}

/**
 * Hide/Island stay hover-idle on the answer surface even with a live answer or
 * listening chrome (Tony 2026-09-06). Mouse leave auto-hides. Re-hover restores
 * the same answer. Settings / History / Review / capture stay fully shown.
 */
export function overlayHoverIdle(input: {
  usesHover: boolean
  minimized: boolean
  onboardingDone: boolean
  view: string
  capturing: boolean
}): boolean {
  return (
    input.usesHover &&
    !input.minimized &&
    input.onboardingDone &&
    input.view === 'answer' &&
    !input.capturing
  )
}

/** Toasts and typed input force the bar open. Listening and a standing answer do not. */
export function overlayHoverForced(input: {
  updateReady: boolean
  toast: boolean
  typedInput: boolean
}): boolean {
  return input.updateReady || input.toast || input.typedInput
}

/**
 * Hug-width is the minimized pill or a parked island peek.
 * Revealed Hide/Island must stay the full Ask bar (880). Ultron f12003d:
 * OverlayPeek hug + 120 floor + BAR_MIN_HEIGHT 44 opened 120×44 Show Métis.
 */
export function overlayAllowsHugWidth(input: {
  minimized: boolean
  islandResting: boolean
  restWidth: number
  nextWidth: number
}): boolean {
  if (input.minimized) return true
  return input.islandResting && input.nextWidth <= input.restWidth + 24
}

/** Ultron 2026-09-06: top-edge hover opened this stub instead of the 880 Ask bar. */
export function isShowMetisHugStub(win: { width: number; height: number }): boolean {
  return win.width === 120 && win.height === 44
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
