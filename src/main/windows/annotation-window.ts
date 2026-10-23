/**
 * annotation-window.ts — the transparent layer that draws Métis's marks over one display (G43, CAP-25).
 *
 * It is a pointer, not an app window: frameless, transparent, sized to its display, always on top, click-through
 * (setIgnoreMouseEvents), never focusable, never in the Dock or taskbar, and shown only with showInactive() so it
 * can never take focus or keyboard from the app the person is working in. It is ALWAYS excluded from screen
 * capture (R038): Métis's own screenshots must not contain its own marks, so this does not depend on the
 * Private View setting. It loads only its bundled page through a minimal preload that can receive marks and
 * nothing else.
 */
import { BrowserWindow } from 'electron'
import type { Rect } from '@shared/screen-marks'
import { MarkViewListSchema, SCREEN_MARKS_IPC, type MarkView } from '@shared/screen-marks'
import type { AnnotationWindowHandle } from '../features/screen-marks/annotation-windows'
import { devToolsEnabled } from '../dev-env'

export interface AnnotationWindowOptions {
  bounds: Rect
  preload: string
  /** Dev server URL, or null to load the packaged file. */
  devUrl: string | null
  file: string
}

export function createAnnotationWindow(opts: AnnotationWindowOptions): AnnotationWindowHandle {
  const win = new BrowserWindow({
    ...opts.bounds,
    title: 'Métis',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: opts.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: devToolsEnabled(),
      webSecurity: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.setFocusable(false)
  win.setContentProtection(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (opts.devUrl) void win.loadURL(opts.devUrl)
  else void win.loadFile(opts.file)
  let latest: MarkView[] = []
  let loaded = false
  const push = (): void => {
    if (!win.isDestroyed() && loaded) win.webContents.send(SCREEN_MARKS_IPC.marks, MarkViewListSchema.parse(latest))
  }
  win.webContents.once('did-finish-load', () => {
    loaded = true
    push()
  })
  return {
    setBounds: (bounds) => {
      if (!win.isDestroyed()) win.setBounds(bounds)
    },
    sendMarks: (marks) => {
      latest = marks
      push()
    },
    showInactive: () => {
      if (!win.isDestroyed()) win.showInactive()
    },
    hide: () => {
      if (!win.isDestroyed()) win.hide()
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    },
    isDestroyed: () => win.isDestroyed()
  }
}
