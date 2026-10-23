/**
 * window-layering.ts — the layering and capture matrix for every native Métis window (R038, G47).
 *
 * One typed record answers, for each native window and each UI surface drawn in it: is it ever composited, does
 * "Hide from screen capture" (content protection) govern it, what always-on-top level it takes, and whether it can
 * appear in Métis's own screen context or in a screen share. The matrix is the policy; the contract test in
 * src/main/window-layering.contract.test.ts holds the real `new BrowserWindow` creation sites to it, so a window
 * added later cannot appear without a decision here.
 *
 * Policy: every window that reaches the screen follows the one `contentProtection` setting (default ON), so with it
 * on, Métis's own UI is excluded from other apps' capture, from its own screen asks and from screen recordings.
 * With the user's setting OFF the window is capturable on purpose. Hidden worker windows are never composited.
 */

export type NativeWindowId = 'overlay' | 'intelligence' | 'permission-helper' | 'import-decoder' | 'recap-pdf'

/** `screen-saver` keeps the bar above full-screen apps; `floating` sits above System Settings, below system alerts. */
export type AlwaysOnTopLevel = 'screen-saver' | 'floating' | null

export interface NativeWindowPolicy {
  id: NativeWindowId
  /** Where the real BrowserWindow is constructed: module under src/main (no extension) and the variable it is assigned to. */
  site: { module: string; variable: string }
  /** True when the window is ever drawn on screen. False for hidden worker windows (`show: false`, never shown). */
  composited: boolean
  /** `follows-setting`: setContentProtection(<the Hide from screen capture setting>). `none-never-shown`: no decision needed. */
  contentProtection: 'follows-setting' | 'none-never-shown'
  alwaysOnTop: AlwaysOnTopLevel
  /** With the setting ON can this window show in Métis's own captures or in a screen share or recording? */
  appearsInCaptureWhenProtected: false
  /** With the setting OFF (the user's explicit choice) it can. Never composited windows cannot at all. */
  appearsInCaptureWhenUnprotected: boolean
}

export const NATIVE_WINDOW_MATRIX: readonly NativeWindowPolicy[] = [
  {
    id: 'overlay',
    site: { module: 'index', variable: 'win' },
    composited: true,
    contentProtection: 'follows-setting',
    alwaysOnTop: 'screen-saver',
    appearsInCaptureWhenProtected: false,
    appearsInCaptureWhenUnprotected: true
  },
  {
    id: 'intelligence',
    site: { module: 'intelligence', variable: 'intelWin' },
    composited: true,
    contentProtection: 'follows-setting',
    alwaysOnTop: null,
    appearsInCaptureWhenProtected: false,
    appearsInCaptureWhenUnprotected: true
  },
  {
    id: 'permission-helper',
    site: { module: 'windows/permission-helper-window', variable: 'win' },
    composited: true,
    contentProtection: 'follows-setting',
    alwaysOnTop: 'floating',
    appearsInCaptureWhenProtected: false,
    appearsInCaptureWhenUnprotected: true
  },
  {
    id: 'import-decoder',
    site: { module: 'index', variable: 'decoderWin' },
    composited: false,
    contentProtection: 'none-never-shown',
    alwaysOnTop: null,
    appearsInCaptureWhenProtected: false,
    appearsInCaptureWhenUnprotected: false
  },
  {
    id: 'recap-pdf',
    site: { module: 'index', variable: 'pdfWin' },
    composited: false,
    contentProtection: 'none-never-shown',
    alwaysOnTop: null,
    appearsInCaptureWhenProtected: false,
    appearsInCaptureWhenUnprotected: false
  }
] as const

export type UiSurfaceId =
  | 'overlay-bar'
  | 'right-edge-sidecar'
  | 'answer-panels'
  | 'command-confirm-card'
  | 'task-cards'
  | 'voice-pill'
  | 'screen-marks'
  | 'settings-and-onboarding'
  | 'review-and-history'
  | 'intelligence-dashboard'
  | 'permission-guide'

/**
 * Which native window draws each UI surface. Everything the user sees on the bar, the sidecar, the panels, the
 * confirm card, the task cards, the voice pill and screen marks is drawn inside the one overlay window, so it
 * inherits that window's protection and level. There is no separate native annotation window: a future one must
 * be added to NATIVE_WINDOW_MATRIX first, or the creation-site contract test fails.
 */
export const UI_SURFACE_HOST: Readonly<Record<UiSurfaceId, NativeWindowId>> = {
  'overlay-bar': 'overlay',
  'right-edge-sidecar': 'overlay',
  'answer-panels': 'overlay',
  'command-confirm-card': 'overlay',
  'task-cards': 'overlay',
  'voice-pill': 'overlay',
  'screen-marks': 'overlay',
  'settings-and-onboarding': 'overlay',
  'review-and-history': 'overlay',
  'intelligence-dashboard': 'intelligence',
  'permission-guide': 'permission-helper'
}

export function windowPolicy(id: NativeWindowId): NativeWindowPolicy {
  const found = NATIVE_WINDOW_MATRIX.find((w) => w.id === id)
  if (!found) throw new Error(`unknown native window: ${id}`)
  return found
}

/** The policy a UI surface inherits from the window that draws it. */
export function surfacePolicy(surface: UiSurfaceId): NativeWindowPolicy {
  return windowPolicy(UI_SURFACE_HOST[surface])
}
