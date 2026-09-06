import { SETTINGS_SURFACE_BACKGROUND, SETTINGS_WINDOW_MIN } from './settings-bounds'

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

/** Classic Bar idle hug. Settings is 800+. A leftover 800 slab under the bar is the ghost panel. */
export const BAR_IDLE_HEIGHT_PX = 84

/** Idle Ask + Settings chrome. Peek 2px / hug 44 / Ultron 880×44 must not win after reveal. */
export const ASK_REVEAL_MIN_HEIGHT_PX = 120

/** Settings / exclusive-stage heights. Never remember these as the Bar hug. */
export function isSettingsTallHeight(height: number): boolean {
  return Number.isFinite(height) && height >= SETTINGS_WINDOW_MIN.height
}

/**
 * lastBarHeight must stay a bar / answer hug, not Settings 800+ or the 816 onboarding card.
 * A long Review can grow again via useAutoResize after Settings closes.
 */
export function rememberBarContentHeight(height: number, fallback = BAR_IDLE_HEIGHT_PX): number {
  if (!Number.isFinite(height) || height <= 0) return fallback
  if (isSettingsTallHeight(height)) return fallback
  return Math.round(height)
}

/**
 * Tony live FAIL: Overlay=Bar, Settings closed, gray Settings-like slab under the bar
 * (window still settings-tall and/or SETTINGS_SURFACE_BACKGROUND leftover).
 */
export function isBarIdleGhostPanel(input: {
  layout: string
  settingsSurfaceOpen: boolean
  width: number
  height: number
  background?: string
  minimized?: boolean
}): boolean {
  if (input.layout !== 'bar' || input.settingsSurfaceOpen) return false
  if (input.background === SETTINGS_SURFACE_BACKGROUND) return true
  return isSettingsTallHeight(input.height)
}

/** Ultron 2026-09-06: top-edge hover opened this stub instead of the 880 Ask bar. */
export function isShowMetisHugStub(win: { width: number; height: number }): boolean {
  return win.width === 120 && win.height === 44
}

/**
 * After hug-width is blocked, OverlayPeek can still report 2–20px. clampHeight
 * then floors to BAR_MIN_HEIGHT 44 → 880×44 Show Métis. Force restore.
 */
export function isIncompleteAskReveal(win: { width: number; height: number }): boolean {
  if (isShowMetisHugStub(win)) return true
  return win.width >= 800 && win.height > 0 && win.height <= 44
}

/** Revealed Hide/Island keeps at least the idle Ask bar. Park, Bar idle, and the mini-pill stay exact. */
export function overlayRevealedContentHeight(input: {
  islandResting: boolean
  minimized: boolean
  settingsOpen: boolean
  reportedHeight: number
  minBarHeight?: number
  usesHover?: boolean
}): number {
  const floor = input.minBarHeight ?? ASK_REVEAL_MIN_HEIGHT_PX
  if (input.islandResting || input.minimized || input.settingsOpen) return input.reportedHeight
  if (input.usesHover === false) return input.reportedHeight
  return Math.max(input.reportedHeight, floor)
}

/**
 * Ultron CDP after top-edge dwell. FAIL: widened Show Métis stub, no Ask field.
 * PASS: Ask chrome (hasAsk) at full bar width and taller than the 44px peek.
 */
export function isShowMetisOnlyStub(input: {
  width: number
  height: number
  hasAsk: boolean
  buttons: readonly string[]
}): boolean {
  if (input.hasAsk) return false
  const onlyShowMetis =
    input.buttons.length > 0 &&
    input.buttons.every((b) => b === 'Show Métis')
  if (onlyShowMetis && input.height <= 44) return true
  return isIncompleteAskReveal(input)
}

export function isFullAskReveal(input: {
  width: number
  height: number
  hasAsk: boolean
}): boolean {
  return (
    input.hasAsk &&
    input.width >= 800 &&
    input.height > 44 &&
    input.height >= ASK_REVEAL_MIN_HEIGHT_PX
  )
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
