import { BrowserWindow, shell, app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

/**
 * The Mantu Intelligence dashboard — a normal, resizable window (not the overlay). Loads the
 * bundled static build of the intelligence/ workspace; its own minimal preload (see
 * src/preload/intelligence.ts) exposes only read access to the brain via IPC, decrypted in main.
 */

let intelWin: BrowserWindow | null = null
let intelUrl = '' // file:// URL of the bundled index.html, set at open — the only document allowed to read the brain

/** IPC guard helper: is this sender the Intelligence window, still showing OUR bundled document?
 *  (index.ts combines with its main check.) The URL match means that even if a navigation somehow slipped
 *  past the will-navigate deny below, a foreign document in this window could not read the brain. */
export function isIntelligenceSender(wc: Electron.WebContents): boolean {
  if (!intelWin || intelWin.isDestroyed() || wc !== intelWin.webContents) return false
  try {
    return !!intelUrl && new URL(wc.getURL()).pathname === new URL(intelUrl).pathname
  } catch {
    return false
  }
}

function bundleIndexHtml(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'intelligence', 'index.html'), // packaged app
    join(__dirname, '..', '..', 'intelligence', 'dist', 'index.html'), // `electron out/main/index.js` (QA/local runs)
    join(app.getAppPath(), 'intelligence', 'dist', 'index.html') // `electron .` dev run
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
  if (!html)
    return {
      ok: false,
      error: 'Intelligence dashboard bundle not found — run `npm run build:intelligence`, then restart.'
    }
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
  // The dashboard is a single bundled document and never legitimately navigates. Deny every renderer-
  // initiated navigation outright — this window's preload can read the decrypted brain, so a navigation
  // to any other document (however it were induced) must be impossible. loadFile below is unaffected
  // (will-navigate only fires for renderer-initiated navigations).
  intelWin.webContents.on('will-navigate', (e) => e.preventDefault())
  intelUrl = pathToFileURL(html).href
  void intelWin.loadFile(html)
  return { ok: true }
}
