import { clampHeight, type Rect } from './geometry'

/** The native calls the overlay surface makes; an Electron BrowserWindow satisfies it. */
export interface OverlaySurfaceWindow {
  getBounds(): Rect
  setBounds(bounds: Rect, animate?: boolean): void
  isVisible(): boolean
  showInactive(): void
  getOpacity(): number
  setOpacity(opacity: number): void
  getBackgroundColor(): string
  setBackgroundColor(color: string): void
}

export type OverlayChromeSetter = Pick<OverlaySurfaceWindow, 'setBackgroundColor' | 'setOpacity'>

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function backgroundIs(w: OverlaySurfaceWindow, color: string): boolean {
  try {
    return w.getBackgroundColor().toLowerCase() === color.slice(0, 7).toLowerCase()
  } catch {
    return false
  }
}

/** Chrome setters that never re-apply a value the window already has. The overlay re-applies its chrome on
 *  every reveal, park and surface change, and a repeated setBackgroundColor/setOpacity repaints the whole
 *  native surface. getBackgroundColor drops alpha; every overlay background has a distinct RGB, so comparing
 *  RGB is exact. */
export function skipUnchangedChrome(w: OverlaySurfaceWindow): OverlayChromeSetter {
  return {
    setBackgroundColor: (color) => {
      if (!backgroundIs(w, color)) w.setBackgroundColor(color)
    },
    setOpacity: (opacity) => {
      if (w.getOpacity() !== opacity) w.setOpacity(opacity)
    }
  }
}

/** Transparent rest chrome, opacity first: a window leaving Settings for the Hide park drops to opacity 0
 *  while it still has the Settings frame, so neither the rest background nor the park bounds that follow is
 *  ever shown at a size the window is about to leave. */
export function applyRestChrome(chrome: OverlayChromeSetter, background: string, opacity: number): void {
  chrome.setOpacity(opacity)
  chrome.setBackgroundColor(background)
}

/** Reveal order: bounds, then visibility, then chrome. The window keeps its parked opacity (0 for Hide) and
 *  stays hidden until it has its revealed bounds, so the parked frame is never shown and then resized as a
 *  second hard cut. Bounds the window already has (below the notch, or the open drawer) are not re-applied,
 *  which would fight the OS clamp. A hidden window (LSUIElement, tray Show/Hide) is shown with showInactive,
 *  never show+focus. */
export function revealOverlaySurface(w: OverlaySurfaceWindow, next: Rect, applyChrome: () => void): void {
  if (!sameRect(w.getBounds(), next)) w.setBounds(next, false)
  try {
    if (!w.isVisible()) w.showInactive()
  } catch {
    /* headless */
  }
  applyChrome()
}

/** The Settings surface: the settingsOpenRect `open` at its content height (normalised by the caller with
 *  settingsContentHeight; the open rect's 800 px by default), capped to the work area like every overlay
 *  height. Opening Settings and every later content resize use it, so the two agree: on a display shorter
 *  than 800 px (a 1024×768 Windows screen) Settings opened at 800 and the renderer's first resize then cut it
 *  to the work-area height at opacity 1. */
export function fitSettingsSurface(open: Rect, workAreaHeight: number, minHeight: number, contentHeight = open.height): Rect {
  return { ...open, height: clampHeight(contentHeight, workAreaHeight, minHeight) }
}

/** Settings resizes before its opaque chrome: applied first, the Settings background painted the old bar or
 *  park bounds as a dark slab for a frame. */
export function openOverlaySettingsSurface(w: OverlaySurfaceWindow, rect: Rect, applyChrome: () => void): void {
  w.setBounds(rect, false)
  applyChrome()
}
