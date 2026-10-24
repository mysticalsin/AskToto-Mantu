import { BrowserWindow } from 'electron'

let current: BrowserWindow | null = null

/**
 * The one place a preview window is built (G55, FF-11). The page is main-built, escaped, script-free HTML carrying its
 * own CSP. The window has no preload (so no `window.toto`), no node, JavaScript off, its own in-memory partition, and
 * may not navigate or open anything.
 */
export function openArtifactPreviewWindow(doc: { title: string; html: string }): void {
  if (current && !current.isDestroyed()) current.destroy()
  const win = new BrowserWindow({
    width: 720,
    height: 600,
    title: 'Métis preview',
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webviewTag: false,
      webSecurity: true,
      partition: 'artifact-preview',
      devTools: false
    }
  })
  current = win
  win.setContentProtection(true)
  win.setTitle(doc.title)
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('closed', () => {
    if (current === win) current = null
  })
  const contents = win.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(doc.html)}`)
}
