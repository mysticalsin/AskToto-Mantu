import { BrowserWindow, screen, shell, app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { getSettings } from './store'
import { devEnv, devToolsEnabled } from './dev-env'

/** Private View (content protection) for the dashboard — mirrors the overlay's contentProtectionOn().
 *  The dashboard aggregates the most sensitive cross-meeting data (people/accounts/deals/quotes/
 *  commitments), so it must be excluded from screen capture/share whenever the overlay is.
 *  The env escape hatch is dev/screenshot-only — gated to unpackaged builds so a packaged process can
 *  never have capture protection stripped by `setx ASKTOTO_DISABLE_CP 1` + relaunch. */
const intelCpOn = (): boolean =>
  !devEnv('ASKTOTO_DISABLE_CP') && getSettings().contentProtection

/** Re-apply Private View to the (open) dashboard window — called from settingsSet when the toggle flips,
 *  same as the overlay's win.setContentProtection() re-apply. */
export function syncIntelContentProtection(): void {
  if (intelWin && !intelWin.isDestroyed()) intelWin.setContentProtection(intelCpOn())
}

/**
 * The Mantu Intelligence dashboard — a normal, resizable window (not the overlay). Loads the
 * bundled static build of the intelligence/ workspace; its own minimal preload (see
 * src/preload/intelligence.ts) exposes read access plus the guarded Update Intelligence pass.
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

/** Tear the dashboard down. Called when the session ends: every brain channel is auth-gated, but an
 *  already-open window keeps rendering the decrypted brain (people/accounts/deals/quotes/commitments)
 *  without asking main again, so the gate only holds if the window itself goes. */
export function closeIntelligenceWindow(): void {
  if (intelWin && !intelWin.isDestroyed()) intelWin.destroy()
}

/**
 * Where the dashboard should sit so the overlay does not cover it.
 *
 * Electron centres a window with no x/y, which on a 1800x1082 work area lands the 840-tall dashboard at
 * y=121 — inside the always-on-top bar's 24..144 band. Measured result: the bar covered the dashboard's
 * top 23px across its full 880px width (20,240 px^2), which is exactly the "windows overlap" complaint.
 * The bar is alwaysOnTop and the dashboard is not, so any intersection is always the dashboard losing.
 *
 * Pure and exported so the geometry is unit-testable without opening a real window.
 */
export function placeAvoiding(
  size: { width: number; height: number; minHeight: number },
  workArea: { x: number; y: number; width: number; height: number },
  avoid?: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(size.width, workArea.width)
  let height = Math.min(size.height, workArea.height)
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  let y = Math.round(workArea.y + (workArea.height - height) / 2)

  if (avoid) {
    const GAP = 8
    const horizontallyClear = x + width <= avoid.x || x >= avoid.x + avoid.width
    const intersects = !horizontallyClear && y < avoid.y + avoid.height && y + height > avoid.y
    if (intersects) {
      // Take whichever side of the bar has more room, rather than always going down. The bar is
      // movable, so a user who parked it low would otherwise get the dashboard pushed off the bottom.
      const roomBelow = workArea.y + workArea.height - (avoid.y + avoid.height + GAP)
      const roomAbove = avoid.y - GAP - workArea.y
      if (roomBelow >= roomAbove) {
        height = Math.max(size.minHeight, Math.min(height, roomBelow))
        y = avoid.y + avoid.height + GAP
      } else {
        height = Math.max(size.minHeight, Math.min(height, roomAbove))
        y = avoid.y - GAP - height
      }
    }
  }

  // Final clamp, applied unconditionally. The branch above can still overshoot when NEITHER side has
  // minHeight of room (a tall bar on a short screen), and an unclamped y put the whole window past the
  // screen edge — with skipTaskbar there is no taskbar button to recover it, so the feature just looked
  // dead. Being fully reachable beats honouring the gap.
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))
  return { x, y, width, height }
}

export function openIntelligenceWindow(avoid?: {
  x: number
  y: number
  width: number
  height: number
}): { ok: boolean; error?: string } {
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
  // Open on the display the OVERLAY is on, not whichever one Windows calls primary: with the bar dragged
  // to a second monitor the dashboard used to appear on the other screen entirely, and skipTaskbar left no
  // way to find it. Falls back to the primary display when there is nothing to avoid.
  const workArea = (avoid ? screen.getDisplayMatching(avoid) : screen.getPrimaryDisplay()).workArea
  const place = placeAvoiding({ width: 1280, height: 840, minHeight: 600 }, workArea, avoid)
  intelWin = new BrowserWindow({
    ...place,
    minWidth: 900,
    minHeight: 600,
    title: 'Mantu Intelligence',
    backgroundColor: '#120022',
    // Métis never shows in the Windows taskbar (Tony, 2026-07-16) — this was the only visible window
    // without the flag, so it alone created a taskbar entry. Alt-Tab still reaches it; the tray is the
    // app's persistent affordance.
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/intelligence.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // This window had NO devTools key, so Electron's default (true) applied and DevTools were
      // openable in a packaged build — on the one window whose preload can read the decrypted brain.
      // Same shared gate the three windows in index.ts use.
      devTools: devToolsEnabled(),
      webSecurity: true
    }
  })
  // Private View covers the dashboard too — without this the most sensitive aggregated view stayed
  // screen-capturable even with Private View on everywhere else.
  intelWin.setContentProtection(intelCpOn())
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
