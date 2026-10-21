/**
 * permission-helper.ts — the guided "grant access" helper (C32 Part D), as pure data shared by main and the helper
 * window: its states, the one instruction line, which flows get a draggable app, and where the helper sits.
 *
 * Some grants have no prompt that can say yes: macOS Screen Recording is switched on in System Settings, and a
 * Windows privacy page is a toggle. The row's single Continue opens the exact pane and this small always-on-top
 * helper beside it: on macOS it carries Métis itself as a draggable item ("Drag Métis into the list, then turn
 * it on."), on Windows it names the toggle. Main re-reads the real status every second and whenever Métis is
 * active again; on a grant the helper shows a checkmark and closes, or offers one Relaunch when macOS applies
 * the grant to the next process. It never raises a system prompt, so it can never prompt in a loop. Cancel is
 * always there. Microphone on macOS keeps its native prompt (no helper), and Métis uses no camera.
 */

export type HelperKind = 'screenRecording' | 'microphone'
export type HelperPlatform = 'darwin' | 'win32'
export type HelperPhase = 'waiting' | 'granted' | 'relaunch' | 'closed'

export interface HelperState {
  phase: HelperPhase
  kind: HelperKind
  platform: HelperPlatform
  /** macOS: the helper carries the app as a real draggable item (and Show in Finder as its keyboard path). */
  drag: boolean
  /** The one line under the app: what to do in the pane that opened. */
  instruction: string
  /** The pane's name, for the helper's accessible label ("Screen & System Audio Recording"). */
  pane: string
  /** Which way the pane lies from the helper, so the hint arrow points at the list. */
  towards: HelperTowards
}

export type HelperStatus = { granted: boolean; needsRelaunch: boolean }

export type HelperEvent =
  | { type: 'open'; kind: HelperKind; platform: HelperPlatform; towards?: HelperTowards }
  | { type: 'status'; status: HelperStatus }
  | { type: 'cancel' }
  | { type: 'success-shown' }

export const PERMISSION_HELPER_IPC = {
  /** Main window → main: open the pane and the helper for one permission. */
  open: 'permissionHelper:open',
  /** Helper window → main: the current state (on load). */
  getState: 'permissionHelper:getState',
  /** Main → helper window: a new state. */
  state: 'permissionHelper:state',
  /** Helper window → main (send): mousedown/dragstart on the app item begins a native file drag. */
  startDrag: 'permissionHelper:startDrag',
  /** Helper window → main: reveal Métis in Finder (the keyboard path to drag it). */
  reveal: 'permissionHelper:reveal',
  /** Helper window → main: close the helper. */
  cancel: 'permissionHelper:cancel',
  /** Helper window → main: relaunch Métis (the live meeting is flushed by the normal quit path). */
  relaunch: 'permissionHelper:relaunch'
} as const

/** The helper's window size (logical px). */
export const HELPER_SIZE = { width: 360, height: 148 } as const
/** Status re-read cadence while the helper is open. */
export const HELPER_POLL_MS = 1000
/** How long the checkmark shows before the helper closes itself. */
export const HELPER_SUCCESS_CLOSE_MS = 1200

/** Which permissions get the helper on which platform; anything else just opens its pane. */
export function helperSupported(kind: unknown, platform: NodeJS.Platform): kind is HelperKind {
  if (platform === 'darwin') return kind === 'screenRecording'
  if (platform === 'win32') return kind === 'screenRecording' || kind === 'microphone'
  return false
}

const COPY: Record<HelperPlatform, Record<HelperKind, { instruction: string; pane: string }>> = {
  darwin: {
    screenRecording: {
      instruction: 'Drag Métis into the list, then turn it on.',
      pane: 'Screen & System Audio Recording'
    },
    microphone: { instruction: 'Turn on Métis in the list.', pane: 'Microphone' }
  },
  win32: {
    screenRecording: {
      instruction: 'Turn on screen capture for desktop apps on this page.',
      pane: 'Privacy & security'
    },
    microphone: {
      instruction: 'Turn on “Let desktop apps access your microphone”.',
      pane: 'Privacy & security › Microphone'
    }
  }
}

function opened(kind: HelperKind, platform: HelperPlatform, towards: HelperTowards): HelperState {
  return {
    phase: 'waiting',
    kind,
    platform,
    towards,
    drag: platform === 'darwin' && kind === 'screenRecording',
    ...COPY[platform][kind]
  }
}

/**
 * open → waiting; a grant → granted (then closed once the checkmark has shown) or, for macOS Screen Recording,
 * relaunch; cancel → closed from anywhere. A status that is still not granted changes nothing.
 */
export function helperReducer(state: HelperState | null, event: HelperEvent): HelperState | null {
  switch (event.type) {
    case 'open':
      return opened(event.kind, event.platform, event.towards ?? 'left')
    case 'cancel':
      return state ? { ...state, phase: 'closed' } : null
    case 'success-shown':
      return state?.phase === 'granted' ? { ...state, phase: 'closed' } : state
    case 'status': {
      if (!state || state.phase !== 'waiting' || !event.status.granted) return state
      return { ...state, phase: event.status.needsRelaunch ? 'relaunch' : 'granted' }
    }
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where System Settings (macOS) or Settings (Windows) opens by default: centered, about this size. */
const SETTINGS_WINDOW: Record<HelperPlatform, { width: number; height: number }> = {
  darwin: { width: 720, height: 620 },
  win32: { width: 1020, height: 720 }
}
const MARGIN = 16

/**
 * The helper's top-left, inside the work area, beside the settings window rather than over it: to its right
 * (level with the top of its list), else to its left, else below it, else above it, else the work area's
 * bottom-right corner. The settings window is estimated (its real frame is another app's), so the helper is
 * kept clear of that whole estimate, never just its sidebar.
 */
export type HelperTowards = 'left' | 'right' | 'up' | 'down'

export function placeHelper(
  work: Rect,
  size: { width: number; height: number },
  platform: HelperPlatform
): { x: number; y: number; towards: HelperTowards } {
  const est = SETTINGS_WINDOW[platform]
  const sw = Math.min(est.width, work.width - 2 * MARGIN)
  const sh = Math.min(est.height, work.height - 2 * MARGIN)
  const settings = { x: work.x + (work.width - sw) / 2, y: work.y + (work.height - sh) / 2, width: sw, height: sh }
  const right = work.x + work.width
  const bottom = work.y + work.height
  const clampY = (y: number): number => Math.min(Math.max(y, work.y + MARGIN), bottom - MARGIN - size.height)
  const clampX = (x: number): number => Math.min(Math.max(x, work.x + MARGIN), right - MARGIN - size.width)
  const at = (x: number, y: number, towards: HelperTowards) => ({ x: Math.round(x), y: Math.round(y), towards })
  const listTop = clampY(settings.y + 72)
  if (settings.x + settings.width + MARGIN + size.width <= right - MARGIN) {
    return at(settings.x + settings.width + MARGIN, listTop, 'left')
  }
  if (settings.x - MARGIN - size.width >= work.x + MARGIN) return at(settings.x - MARGIN - size.width, listTop, 'right')
  const centeredX = clampX(settings.x + (settings.width - size.width) / 2)
  if (settings.y + settings.height + MARGIN + size.height <= bottom - MARGIN) {
    return at(centeredX, settings.y + settings.height + MARGIN, 'up')
  }
  if (settings.y - MARGIN - size.height >= work.y + MARGIN)
    return at(centeredX, settings.y - MARGIN - size.height, 'down')
  return at(right - MARGIN - size.width, bottom - MARGIN - size.height, 'left')
}

/** What the helper window renders: the state plus the app's name and icon (a data: URL, or null). */
export type HelperView = HelperState & { appName: string; icon: string | null }

/** The helper window's preload API (window.metisHelper). */
export interface PermissionHelperApi {
  getState: () => Promise<HelperView | null>
  onState: (listener: (state: HelperView) => void) => () => void
  /** Call from the app item's dragstart: main begins a native drag of the running app. */
  startDrag: () => void
  reveal: () => Promise<void>
  cancel: () => Promise<void>
  relaunch: () => Promise<void>
}
