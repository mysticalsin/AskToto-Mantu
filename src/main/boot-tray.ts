/** The slice of BrowserWindow the tray scheduler reads. */
export interface TrayGateWindow {
  isDestroyed(): boolean
  once(event: 'ready-to-show', listener: () => void): unknown
  webContents: {
    isLoading(): boolean
    getURL(): string
    once(event: 'did-finish-load', listener: () => void): unknown
  }
}

const FALLBACK_MS = 5000

/** Ends the current main-thread task so the next boot step starts in a new one. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** M2-0422: the tray is not needed to paint, so it is built in its own task after the window's first paint.
 *  If the window never came up (createWindow threw) the tray is the user's only Show/Quit path, so it is built
 *  at once; a paint that never reports is covered by a bounded fallback timer. `buildTray` runs at most once. */
export function scheduleTrayAfterFirstPaint(win: TrayGateWindow | null | undefined, buildTray: () => void): void {
  if (!win || win.isDestroyed()) {
    buildTray()
    return
  }
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    setImmediate(buildTray)
  }
  // The exclusive-onboarding hoist can have created the window (and painted it) before this runs.
  if (!win.webContents.isLoading() && win.webContents.getURL() !== '') {
    start()
    return
  }
  win.once('ready-to-show', start)
  win.webContents.once('did-finish-load', start)
  setTimeout(start, FALLBACK_MS).unref?.()
}
