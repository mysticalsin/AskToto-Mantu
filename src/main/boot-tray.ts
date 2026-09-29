import { join } from 'node:path'
import type { BootStage } from './infra/observability/projection'

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

export interface TrayStages<Icon, Menu = unknown> {
  /** Produces the sized tray image with the build's phase timer; the decode must not run as one long main-thread task. */
  loadIcon(time: TrayPhaseTimer): Promise<Icon>
  /** Constructs the native tray item from the loaded image. */
  create(icon: Icon): void
  /** Gives the created item its image, when `create` built it without one. */
  setImage?(icon: Icon): void
  /** Sets the created item's title, tooltip and click handler; receives the loaded image. */
  decorate?(icon: Icon): void
  /** Builds the context menu handed to `attachMenu`. */
  buildMenu?(): Menu
  /** Attaches the menu `buildMenu` built (undefined when there is no `buildMenu`, so it builds the menu itself).
   *  Absent when the menu is attached later, on the tray's first open (attachMenuOnFirstOpen). */
  attachMenu?(menu: Menu | undefined): void
  /** Times one stage (the boot phase trace), so a slow stage is named on its own. */
  time: TrayPhaseTimer
  fail(error: unknown): void
}

/** M2-0031, M2-0433: every tray stage (image load, native item, its image, its title, the menu build, the menu
 *  attach) runs in a main-thread task of its own, so no single task holds two native steps together. A failure in
 *  any stage is reported once through `fail` and ends the build; a tray already created stays usable. */
export async function buildTrayInStages<Icon, Menu = unknown>(stages: TrayStages<Icon, Menu>): Promise<void> {
  try {
    const icon = await stages.loadIcon(stages.time)
    await yieldToEventLoop()
    stages.time('createTray.newTray', () => stages.create(icon))
    if (stages.setImage) {
      await yieldToEventLoop()
      stages.time('createTray.setImage', () => stages.setImage?.(icon))
    }
    if (stages.decorate) {
      await yieldToEventLoop()
      stages.time('createTray.decorate', () => stages.decorate?.(icon))
    }
    let menu: Menu | undefined
    if (stages.buildMenu) {
      await yieldToEventLoop()
      menu = stages.time('createTray.buildMenu', () => stages.buildMenu?.())
    }
    if (stages.attachMenu) {
      await yieldToEventLoop()
      stages.time('createTray.attachMenu', () => stages.attachMenu?.(menu))
    }
  } catch (error) {
    stages.fail(error)
  }
}

/** The slice of Electron's Tray the lazy context menu uses. */
export interface LazyMenuTray<Menu> {
  isDestroyed(): boolean
  on(event: 'click', listener: () => void): unknown
  on(event: 'right-click', listener: () => void): unknown
  setContextMenu(menu: Menu | null): void
  popUpContextMenu(menu?: Menu): void
}

export interface LazyTrayMenu {
  /** Rebuilds the attached menu (fresh accelerator labels); before the first open there is nothing to rebuild,
   *  since that open builds the menu from current settings. */
  rebuild(): void
}

/** M2-0433: building and attaching the context menu held the main thread for hundreds of ms at boot, so on macOS
 *  and Windows the menu is built and attached on the tray's first open (right-click everywhere, and the macOS
 *  left click, which opens an attached menu natively) and popped up in that same task; every later open is
 *  native. Platforms that emit no open event get the menu at once. The build and the attach are timed as
 *  'createTray.buildMenu' and 'createTray.attachMenu' whenever they run. */
export function attachMenuOnFirstOpen<Menu>(
  tray: LazyMenuTray<Menu>,
  platform: NodeJS.Platform,
  buildMenu: () => Menu,
  time: TrayPhaseTimer = untimed
): LazyTrayMenu {
  let attached = false
  const attach = (): Menu => {
    const menu = time('createTray.buildMenu', buildMenu)
    time('createTray.attachMenu', () => tray.setContextMenu(menu))
    attached = true
    return menu
  }
  const openFirst = (): void => {
    if (attached || tray.isDestroyed()) return
    tray.popUpContextMenu(attach())
  }
  if (platform === 'darwin' || platform === 'win32') {
    tray.on('right-click', openFirst)
    if (platform === 'darwin') tray.on('click', openFirst)
  } else {
    attach()
  }
  return {
    rebuild() {
      if (attached && !tray.isDestroyed()) tray.setContextMenu(buildMenu())
    }
  }
}

/** Returns a starter that ignores every call while a previous run is still in flight, so a second createTray
 *  during a staged build cannot add a duplicate status item. A settled run (fulfilled or rejected) frees it. */
export function createSingleFlight(): (run: () => Promise<void>) => void {
  let inFlight = false
  return (run) => {
    if (inFlight) return
    inFlight = true
    void run()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
      })
  }
}

/** The tray menu's label for an Electron accelerator: Windows key names on win32, macOS modifier symbols elsewhere;
 *  an unbound shortcut ('') gives ''. */
export function formatTrayAccelerator(accelerator: string, platform: NodeJS.Platform): string {
  if (!accelerator) return ''
  return platform === 'win32'
    ? accelerator.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl').replace(/Command|Meta|Super/g, 'Win').replace(/Return/g, 'Enter')
    : accelerator.replace(/CommandOrControl|CmdOrCtrl|Command|Meta/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/Control/g, 'Ctrl').replace(/Return/g, '↵').replace(/\+/g, '')
}

export interface TraySize {
  width: number
  height: number
}

/** The slice of Electron's NativeImage the tray icon loader uses. */
export interface TrayIconImage<I> {
  isEmpty(): boolean
  resize(size: TraySize): I
}

/** The slice of Electron's nativeImage module the tray icon loader uses. */
export interface TrayImageLoader<I extends TrayIconImage<I>> {
  createThumbnailFromPath(path: string, size: TraySize): Promise<I>
  createFromPath(path: string): I
}

/** Times one synchronous step of the tray build under its boot stage label. */
export type TrayPhaseTimer = <T>(label: BootStage, fn: () => T) => T
const untimed: TrayPhaseTimer = (_label, fn) => fn()

export const TRAY_ICON_SIZE: TraySize = { width: 18, height: 18 }
/** Bound on the off-thread thumbnail; past it the icon is decoded in-process so the tray still appears. */
export const TRAY_THUMBNAIL_TIMEOUT_MS = 2000

/** The 18 px tray image. The bundled icon is a 1024² PNG whose in-process decode and resize held the main thread
 *  for hundreds of ms, so on macOS it is decoded off the main thread by the system thumbnailer; elsewhere, or if
 *  the thumbnailer fails, returns an empty image or does not answer in time, it falls back to the in-process decode. */
export async function loadTrayIcon<I extends TrayIconImage<I>>(
  images: TrayImageLoader<I>,
  iconPath: string,
  platform: NodeJS.Platform,
  time: TrayPhaseTimer = untimed
): Promise<I> {
  if (platform === 'darwin') {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const thumbnail = await Promise.race([
        images.createThumbnailFromPath(iconPath, TRAY_ICON_SIZE),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), TRAY_THUMBNAIL_TIMEOUT_MS)
        })
      ])
      if (thumbnail && !thumbnail.isEmpty()) return thumbnail
    } catch {
      /* fall back to the in-process decode below */
    } finally {
      clearTimeout(timer)
    }
  }
  return time('createTray.loadIcon.fallback', () => {
    const img = images.createFromPath(iconPath)
    return img.isEmpty() ? img : img.resize(TRAY_ICON_SIZE)
  })
}

/** The tray images built from the app icon at build time (scripts/make-tray-icons.mjs) and the icon itself. */
export interface TrayIconPaths {
  /** 18 px image; Electron picks up its 36 px `@2x` sibling on HiDPI displays by itself. */
  presized: string
  /** The 1024² app icon, decoded and resized only when the pre-sized image is missing or unreadable. */
  fullSize: string
}

/** The tray image paths inside a resources directory (the packaged app's, or build/ in development). */
export function trayIconPaths(resourcesDir: string): TrayIconPaths {
  return { presized: join(resourcesDir, 'tray', 'tray.png'), fullSize: join(resourcesDir, 'icon.png') }
}

/** The tray image on every platform. The pre-sized image loads as-is, so nothing is resized or rasterized on the
 *  main thread; only if it is missing or empty does the load fall back to `loadTrayIcon` on the full-size icon. */
export async function loadPresizedTrayIcon<I extends TrayIconImage<I>>(
  images: TrayImageLoader<I>,
  paths: TrayIconPaths,
  platform: NodeJS.Platform,
  time: TrayPhaseTimer = untimed
): Promise<I> {
  const presized = time('createTray.loadIcon', () => images.createFromPath(paths.presized))
  if (!presized.isEmpty()) return presized
  return loadTrayIcon(images, paths.fullSize, platform, time)
}
