import { BrowserWindow, screen, shell, app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { getSettings } from './store'
import { devEnv, devToolsEnabled, isPackagedBuild } from './dev-env'

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
  let x = Math.round(workArea.x + (workArea.width - width) / 2)
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
  // dead. Being fully reachable beats honouring the gap. Clamp x too — a dead/off-screen workArea must
  // still keep the window inside the chosen rect (resolveIntelligenceWorkArea picks a visible one).
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))
  return { x, y, width, height }
}

export type IntelRect = { x: number; y: number; width: number; height: number }

function rectsIntersect(a: IntelRect, b: IntelRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function pointInRect(p: { x: number; y: number }, r: IntelRect): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}

/**
 * Cap3 blank/"won't open": overlay avoid can sit at x≈8960 (dead/off-screen AX).
 * getDisplayMatching(avoid) then yields that invisible display's workArea and placeAvoiding
 * centres the dashboard there — skipTaskbar leaves no recovery. Pure + exported for unit tests.
 */
export function resolveIntelligenceWorkArea(args: {
  displays: Array<{ bounds: IntelRect; workArea: IntelRect }>
  primaryWorkArea: IntelRect
  cursorPoint?: { x: number; y: number }
  avoid?: IntelRect
}): { workArea: IntelRect; avoid?: IntelRect } {
  const displays = args.displays.filter((d) => d.workArea.width > 0 && d.workArea.height > 0)
  const primary = args.primaryWorkArea
  const pickByPoint = (p: { x: number; y: number } | undefined): IntelRect | null => {
    if (!p || displays.length === 0) return null
    const hit = displays.find((d) => pointInRect(p, d.bounds) || pointInRect(p, d.workArea))
    return hit?.workArea ?? null
  }

  let workArea: IntelRect | null = null
  let avoid = args.avoid

  // Prefer avoid ONLY when it intersects a currently visible display. Off-screen overlay coords
  // (Tony FAIL x=8960) must never choose that phantom display.
  if (avoid && displays.some((d) => rectsIntersect(avoid!, d.bounds) || rectsIntersect(avoid!, d.workArea))) {
    workArea = pickByPoint({ x: avoid.x + avoid.width / 2, y: avoid.y + avoid.height / 2 })
  }

  if (!workArea) workArea = pickByPoint(args.cursorPoint)
  if (!workArea) {
    const primaryHit = displays.find(
      (d) =>
        d.workArea.x === primary.x &&
        d.workArea.y === primary.y &&
        d.workArea.width === primary.width &&
        d.workArea.height === primary.height
    )
    workArea = primaryHit?.workArea ?? displays[0]?.workArea ?? primary
  }

  // Drop avoid when it does not intersect the chosen visible workArea — otherwise placeAvoiding
  // can still push using dead geometry even after we picked a good display.
  if (avoid && !rectsIntersect(avoid, workArea)) avoid = undefined

  return { workArea, avoid }
}

export function rectFullyOnDisplays(rect: IntelRect, displays: Array<{ bounds: IntelRect }>): boolean {
  // Require majority of the window area to sit on some display bounds (not a 1px touch).
  const area = Math.max(1, rect.width * rect.height)
  let covered = 0
  for (const d of displays) {
    const w = Math.max(0, Math.min(rect.x + rect.width, d.bounds.x + d.bounds.width) - Math.max(rect.x, d.bounds.x))
    const h = Math.max(0, Math.min(rect.y + rect.height, d.bounds.y + d.bounds.height) - Math.max(rect.y, d.bounds.y))
    covered += w * h
  }
  return covered / area >= 0.5
}

function visibleDisplays(): Array<{ bounds: IntelRect; workArea: IntelRect }> {
  return screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea }))
}

function raiseIntelligenceWindow(): void {
  if (!intelWin || intelWin.isDestroyed()) return
  if (intelWin.isMinimized()) intelWin.restore()
  intelWin.show()
  intelWin.focus()
  // Always-on-top overlay can bury a normal window; moveTop recovers without making Intelligence alwaysOnTop.
  try {
    intelWin.moveTop()
  } catch {
    /* older Electron */
  }
}

export function openIntelligenceWindow(avoid?: {
  x: number
  y: number
  width: number
  height: number
}): { ok: boolean; error?: string } {
  const displays = visibleDisplays()
  const primaryWorkArea = screen.getPrimaryDisplay().workArea
  let cursorPoint: { x: number; y: number } | undefined
  try {
    cursorPoint = screen.getCursorScreenPoint()
  } catch {
    cursorPoint = undefined
  }
  const resolved = resolveIntelligenceWorkArea({
    displays,
    primaryWorkArea,
    cursorPoint,
    avoid
  })
  const place = placeAvoiding(
    { width: 1280, height: 840, minHeight: 600 },
    resolved.workArea,
    resolved.avoid
  )

  if (intelWin && !intelWin.isDestroyed()) {
    // Re-open path: if a prior open parked us off-screen (Tony Cap3 FAIL), pull back onto a visible display.
    const cur = intelWin.getBounds()
    if (!rectFullyOnDisplays(cur, displays)) {
      intelWin.setBounds(place)
    }
    raiseIntelligenceWindow()
    return { ok: true }
  }
  const html = bundleIndexHtml()
  if (!html)
    return {
      ok: false,
      error: 'Intelligence dashboard bundle not found — run `npm run build:intelligence`, then restart.'
    }
  // Prefer the overlay's display when the bar is on a real visible monitor; never inherit dead/off-screen
  // overlay coords (getDisplayMatching alone followed x≈8960 and Tony saw blank/won't-open).
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
  // Cap3 QA: Private View blacks screen-capture AND can present as a blank feel window when verifying.
  // Force paint for Cap3 tip prove when Resources/QA_TIP.txt exists — but ONLY in unpackaged builds.
  // Same fail-closed packaging gate as ASKTOTO_DISABLE_CP / devEnv(): a shipped QA_TIP.txt must never
  // leave the most sensitive aggregated view screen-capturable while Private View appears on.
  const qaTip = join(process.resourcesPath || '', 'QA_TIP.txt')
  const cap3QaForcePaint = !isPackagedBuild() && existsSync(qaTip)
  if (cap3QaForcePaint) {
    intelWin.setContentProtection(false)
  } else {
    // Private View covers the dashboard too — without this the most sensitive aggregated view stayed
    // screen-capturable even with Private View on everywhere else.
    intelWin.setContentProtection(intelCpOn())
  }
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
  intelWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[intelligence] did-fail-load', code, desc, url)
  })
  intelWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[intelligence] render-process-gone', details)
  })
  intelWin.webContents.on('dom-ready', () => {
    console.log('[intelligence] dom-ready', html, 'qaForcePaint=', cap3QaForcePaint)
  })
  void intelWin.loadFile(html)
  raiseIntelligenceWindow()
  return { ok: true }
}
