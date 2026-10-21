/**
 * permission-helper-window.ts — the guided grant helper's window (C32 Part D): a small frameless, transparent,
 * always-on-top panel that shows without taking focus from System Settings, beside it rather than over it.
 * It is focusable when clicked (keyboard users can Tab to its controls), never resizable, never in the Dock or
 * taskbar, and it loads only its own bundled page with a minimal preload (src/preload/permission-helper.ts).
 */
import { BrowserWindow } from 'electron'
import { devToolsEnabled } from '../dev-env'

export interface PermissionHelperWindowOptions {
  bounds: { x: number; y: number; width: number; height: number }
  preload: string
  /** Dev server URL, or null to load the packaged file. */
  devUrl: string | null
  file: string
}

export function createPermissionHelperWindow(opts: PermissionHelperWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...opts.bounds,
    title: 'Métis',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: opts.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: devToolsEnabled(),
      webSecurity: true
    }
  })
  // Above System Settings / Settings (a normal window), below system alerts.
  win.setAlwaysOnTop(true, 'floating')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  // Never steal focus from the pane the person is about to click in.
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  if (opts.devUrl) void win.loadURL(opts.devUrl)
  else void win.loadFile(opts.file)
  return win
}
