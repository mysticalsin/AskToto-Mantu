import { BrowserWindow, shell, app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * The Mantu Intelligence dashboard — a normal, resizable window (not the overlay). Loads the
 * bundled static build of the intelligence/ workspace; its own minimal preload (see
 * src/preload/intelligence.ts) exposes only read access to the brain via IPC, decrypted in main.
 */

let intelWin: BrowserWindow | null = null

/** IPC guard helper: is this sender the Intelligence window? (index.ts combines with its main check.) */
export function isIntelligenceSender(wc: Electron.WebContents): boolean {
  return !!intelWin && !intelWin.isDestroyed() && wc === intelWin.webContents
}

function bundleIndexHtml(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'intelligence', 'index.html'), // packaged app
    join(app.getAppPath(), 'intelligence', 'dist', 'index.html') // repo/dev fallback
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function openIntelligenceWindow(): { ok: boolean; error?: string } {
  if (intelWin && !intelWin.isDestroyed()) {
    intelWin.show()
    intelWin.focus()
    return { ok: true }
  }
  const html = bundleIndexHtml()
  if (!html) return { ok: false, error: 'Intelligence dashboard bundle not found — rebuild the app.' }
  intelWin = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Mantu Intelligence',
    backgroundColor: '#120022',
    webPreferences: {
      preload: join(__dirname, '../preload/intelligence.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  intelWin.on('closed', () => {
    intelWin = null
  })
  // Same discipline as the overlay: external links open in the real browser, never in-window.
  intelWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  void intelWin.loadFile(html)
  return { ok: true }
}
