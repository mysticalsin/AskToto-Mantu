/**
 * permission-helper.ts — the guided grant helper's controller (C32 Part D). See src/shared/permission-helper.ts for
 * the flow. This module owns one helper at a time: it opens the exact pane, shows the helper window, re-reads the
 * real status every HELPER_POLL_MS and whenever Métis becomes active, and closes the helper on Cancel, on the
 * window's own close, or HELPER_SUCCESS_CLOSE_MS after a grant. It never raises a system prompt.
 *
 * Everything OS-facing is injected, so the state machine and its timers are unit-tested without Electron.
 */
import {
  HELPER_POLL_MS,
  HELPER_SUCCESS_CLOSE_MS,
  helperReducer,
  helperSupported,
  type HelperEvent,
  type HelperKind,
  type HelperState,
  type HelperStatus,
  type HelperTowards
} from '@shared/permission-helper'

export interface HelperWindow {
  send: (state: HelperState) => void
  close: () => void
  onClosed: (listener: () => void) => void
}

export interface PermissionHelperDeps {
  platform: NodeJS.Platform
  /** The exact privacy pane for a kind, or null (screen-permission-ipc's permissionSettingsUrl). */
  paneUrl: (kind: unknown) => string | null
  openPane: (url: string) => void
  readStatus: (kind: HelperKind) => Promise<HelperStatus>
  /** Where the helper goes on the display the person is using, and which way the pane lies from it. */
  place: (platform: 'darwin' | 'win32') => { x: number; y: number; towards: HelperTowards }
  showWindow: (state: HelperState, at: { x: number; y: number }) => HelperWindow
  poll: (read: () => void, everyMs: number) => () => void
  delay: (run: () => void, ms: number) => () => void
  relaunch: () => void
}

export interface PermissionHelper {
  /** Opens the pane, and the helper when this platform has one for `kind`. True when the helper showed. */
  open: (kind: unknown) => boolean
  /** Métis became active again (back from System Settings): re-read now. */
  appActive: () => void
  cancel: () => void
  /** Only while the helper offers Relaunch. */
  relaunch: () => void
  state: () => HelperState | null
}

export function createPermissionHelper(deps: PermissionHelperDeps): PermissionHelper {
  let state: HelperState | null = null
  let win: HelperWindow | null = null
  let stopPoll: (() => void) | null = null
  let stopDelay: (() => void) | null = null
  let reading = false

  const stopTimers = (): void => {
    stopPoll?.()
    stopPoll = null
    stopDelay?.()
    stopDelay = null
  }

  const dispatch = (event: HelperEvent): void => {
    const next = helperReducer(state, event)
    if (next === state || !next) return
    state = next
    if (next.phase !== 'waiting') {
      stopPoll?.()
      stopPoll = null
    }
    if (next.phase === 'closed') {
      stopTimers()
      const closing = win
      win = null
      closing?.close()
      return
    }
    win?.send(next)
    if (next.phase === 'granted')
      stopDelay = deps.delay(() => dispatch({ type: 'success-shown' }), HELPER_SUCCESS_CLOSE_MS)
  }

  const check = async (): Promise<void> => {
    if (!state || state.phase !== 'waiting' || reading) return
    const asked = state
    reading = true
    try {
      const status = await deps.readStatus(asked.kind).catch(() => null)
      // A helper closed or replaced while the read was in flight ignores its answer.
      if (status && state === asked) dispatch({ type: 'status', status })
    } finally {
      reading = false
    }
  }

  return {
    open(kind) {
      const url = deps.paneUrl(kind)
      if (url) deps.openPane(url)
      if (!helperSupported(kind, deps.platform)) return false
      if (state && state.phase !== 'closed') dispatch({ type: 'cancel' })
      const platform = deps.platform as 'darwin' | 'win32'
      const at = deps.place(platform)
      dispatch({ type: 'open', kind, platform, towards: at.towards })
      const opened = state as HelperState | null
      if (!opened) return false
      const shown = deps.showWindow(opened, at)
      win = shown
      shown.onClosed(() => {
        if (win !== shown) return
        win = null
        if (state && state.phase !== 'closed') dispatch({ type: 'cancel' })
      })
      stopPoll = deps.poll(() => void check(), HELPER_POLL_MS)
      void check()
      return true
    },
    appActive() {
      void check()
    },
    cancel() {
      dispatch({ type: 'cancel' })
    },
    relaunch() {
      if (state?.phase === 'relaunch') deps.relaunch()
    },
    state: () => state
  }
}
