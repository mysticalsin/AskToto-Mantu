/**
 * Full Settings surface. Opening Settings from tray, dock, hotkey, or IPC must use these
 * bounds, never Hide 8×2 or Island peek. Closing Settings re-parks Hide/Island via overlay-chrome.
 */

export const SETTINGS_WINDOW_MIN = { width: 880, height: 560 } as const

/** Dark glass, not white and not solid black. Used while the Settings surface is up. */
export const SETTINGS_SURFACE_BACKGROUND = '#120022'

/** Transparent overlay rest. Hide park and Island peek stay see-through. */
export const OVERLAY_REST_BACKGROUND = '#00000000'

export const ONBOARDING_STAGE_BACKGROUND = '#3A0B6B'

/** Leftover 880×133-class slab at workArea.y (~39 on a notch Mac). Fat hover trigger. */
export const FAT_HOVER_TRIGGER_MIN = { width: 800, height: 100 } as const
export const FAT_HOVER_TRIGGER_MAX_HEIGHT = 699

export function isCrushedSettingsBounds(win: { width: number; height: number }): boolean {
  return win.width < SETTINGS_WINDOW_MIN.width || win.height < SETTINGS_WINDOW_MIN.height
}

/** Hide 8×2 or Island ~142×19. Settings must never keep these. */
export function isHideOrIslandParkSize(win: { width: number; height: number }): boolean {
  return (win.width <= 8 && win.height <= 8) || (win.width <= 150 && win.height <= 24)
}

export function settingsOpenRejectsPark(win: { width: number; height: number }): boolean {
  return isHideOrIslandParkSize(win) || isCrushedSettingsBounds(win)
}

/**
 * 880-wide leftover at the menu-bar / workArea row (Tony: Y=39, 880×133).
 * Mid-flow 880×816 cards are a different bug (`isForbiddenMidFlowCard`).
 */
export function isFatHoverTrigger(
  win: { width: number; height: number; y: number },
  workAreaY: number
): boolean {
  return (
    win.width >= FAT_HOVER_TRIGGER_MIN.width &&
    win.height >= FAT_HOVER_TRIGGER_MIN.height &&
    win.height <= FAT_HOVER_TRIGGER_MAX_HEIGHT &&
    Math.abs(win.y - workAreaY) <= 4
  )
}

export function isForbiddenFlashBackground(color: string): boolean {
  const n = color.trim().toLowerCase()
  return n === '#ffffff' || n === '#fff' || n === '#000000' || n === '#000'
}

export function settingsSurfaceMinSize(): { width: number; height: number } {
  return { width: SETTINGS_WINDOW_MIN.width, height: SETTINGS_WINDOW_MIN.height }
}
