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
  // A timer callback already starts a task of its own, so the fallback builds the tray directly.
  const startFromTimer = (): void => {
    if (started) return
    started = true
    buildTray()
  }
  // The exclusive-onboarding hoist can have created the window (and painted it) before this runs.
  if (!win.webContents.isLoading() && win.webContents.getURL() !== '') {
    start()
    return
  }
  win.once('ready-to-show', start)
  win.webContents.once('did-finish-load', start)
  setTimeout(startFromTimer, FALLBACK_MS).unref?.()
}

export interface TrayStages<Icon> {
  /** Produces the sized tray image; the decode must not run as one long main-thread task. */
  loadIcon(): Promise<Icon>
  /** Constructs the native tray item from the loaded image. */
  create(icon: Icon): void
  /** Builds and attaches the context menu. */
  attachMenu(): void
  /** Times one stage (the boot phase trace), so a slow stage is named on its own. */
  time<T>(label: string, fn: () => T): T
  fail(error: unknown): void
}

/** M2-0031: the tray is built in three separate main-thread tasks (image load, native item, menu), so no single
 *  task holds the image decode, the status-item construction and the menu build together. A failure in any stage
 *  is reported once through `fail` and ends the build; a tray already created stays usable. */
export async function buildTrayInStages<Icon>(stages: TrayStages<Icon>): Promise<void> {
  try {
    const icon = await stages.loadIcon()
    await yieldToEventLoop()
    stages.time('createTray.newTray', () => stages.create(icon))
    await yieldToEventLoop()
    stages.time('createTray.attachMenu', () => stages.attachMenu())
  } catch (error) {
    stages.fail(error)
  }
}
