import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  desktopCapturer,
  session,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  protocol,
  net
} from 'electron'
import { join, basename, resolve, relative, isAbsolute, extname } from 'node:path'
import { readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  IPC,
  AskStartSchema,
  SetApiKeyPayloadSchema,
  ClearApiKeyPayloadSchema,
  TestApiKeyPayloadSchema,
  DEFAULT_SHORTCUTS,
  type HotkeyAction,
  type PublicSettings,
  type CalendarEvent
} from '@shared/ipc'
import {
  getSettings,
  setSettings,
  getLockedKeys,
  getAllowedProviders,
  getEnvKeyProviders,
  getApiKey,
  setApiKey,
  clearApiKey,
  testApiKey,
  hasApiKey,
  hasKeysMap,
  encryptionAvailable,
  listDustAgents
} from './store'
import { createStream } from './llm'
import { buildSystem } from './personas'
import { initLogging, mainLog, auditLog } from './logger'
import { authStatus, signIn as authSignIn, signOut as authSignOut, requireAuth } from './auth'
import { calendarToday } from './calendar'
import { parakeetModelReady, ensureParakeetModel, parakeetTranscribe } from './parakeet'
import {
  saveMeeting,
  saveNote,
  parseRecapMarkdown,
  resolveMeetingsFolder,
  ensureMeetingsFolder,
  isEncryptedFile,
  decryptToTemp
} from './transcripts'
import { detectMeeting } from './meeting-detect'
import { titleMatchesCalendar } from './meeting-detect/shared'
import { getPlatformPermissions } from './platform-perms'
import { listMeetings, searchMeetings } from './recall'
import { initAutoUpdate } from './updater'
import { runSelfTest } from './selftest'
import { refreshDustCliSession, setupDustCli } from './dustcli'
import { detectCli, testCli, setupCli, installCli, loginCli, prewarmCli } from './cli'
import {
  graphifyStatus,
  buildGraph,
  relatedNotes,
  graphHtml,
  scheduleRebuild,
  purgeGraphArtifacts
} from './graphify'
import { SaveMeetingSchema, SaveNoteSchema } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import { routeTier } from '@shared/routing'

const BAR_WIDTH = 940
const BAR_HEIGHT = 84 // initial idle height of the slimmer two-row widget; useAutoResize grows it for answers
const BAR_MIN_HEIGHT = 44 // floor for the resize clamp so the collapsed control mini-pill can shrink fully
const PILL_WIDTH = 220 // narrow width for the collapsed control mini-pill (so it isn't a wide click-trap)

/** Content protection hides the window from screen capture. Disable via env for dev/screenshots. */
function contentProtectionOn(): boolean {
  if (process.env.ASKTOTO_DISABLE_CP) return false
  return getSettings().contentProtection
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let audioArmed = false // loopback capture only granted during an explicit user-initiated Listen
let lastBarHeight = BAR_HEIGHT // remember the bar's content height to restore on settings exit
let currentWidth = BAR_WIDTH // window width; narrows to PILL_WIDTH while collapsed to the control mini-pill
const streams = new Map<string, { abort: () => void }>()

/** Security: every privileged IPC handler must come from the main window's top frame.
 *  Compromised subframes, devtools, or unexpected webContents are rejected here. */
function assertMainWindow(event: Electron.IpcMainInvokeEvent): void {
  if (!win) throw new Error('Main window not available')
  if (event.sender !== win.webContents) {
    throw new Error('IPC denied: sender is not the main window')
  }
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || frame.url !== win.webContents.getURL()) {
    throw new Error('IPC denied: not main frame')
  }
}

/** Minimal .env loader (no dep) — dev convenience; prod uses in-app key. */
function loadDotEnv(): void {
  for (const p of [join(process.cwd(), '.env'), join(app.getAppPath(), '.env')]) {
    if (!existsSync(p)) continue
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    } catch {
      /* ignore */
    }
    break
  }
}

function publicSettings(): PublicSettings {
  const s = getSettings()
  let loginItemOpenAtLogin = false
  try {
    loginItemOpenAtLogin = app.getLoginItemSettings().openAtLogin
  } catch {
    /* not supported on this platform */
  }
  // Active provider is usable: key present AND any provider-specific setup done (Dust needs a workspace +
  // a chosen base agent; custom needs an https base URL). Drives the add-key CTA so it only shows when the
  // app genuinely can't answer yet — not when a key for a DIFFERENT provider exists.
  const activeDef = PROVIDERS[s.provider]
  const providerReady =
    activeDef.kind === 'cli'
      ? !!s.cliConnected[s.provider]
      : hasApiKey(s.provider) &&
        (s.provider === 'dust'
          ? !!s.dustWorkspaceId.trim() && !!s.providerModels.dust
          : s.provider === 'custom'
            ? /^https:\/\//i.test(s.customBaseUrl) && !!s.providerModels.custom
            : true)
  return {
    ...s,
    hasApiKey: hasApiKey(s.provider),
    providerReady,
    visionReady: providerReady && activeDef.vision, // gates screen-ask so shots never hit a non-vision model
    hasKeys: hasKeysMap(),
    hasEncryption: encryptionAvailable(),
    resolvedMeetingsFolder: resolveMeetingsFolder(s),
    managedKeys: getLockedKeys(),
    envKeys: getEnvKeyProviders(),
    loginItemOpenAtLogin
  }
}

function topCenter(width: number, height: number): { x: number; y: number } {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 24
  }
}

function createWindow(): void {
  const { x, y } = topCenter(BAR_WIDTH, BAR_HEIGHT)
  win = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false, // panel paints its own shadow; window shadow would box the transparent area
    resizable: false,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    acceptFirstMouse: true, // macOS: first click activates + hits the target without needing a second click
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(contentProtectionOn())
  win.setHiddenInMissionControl?.(true)

  win.on('closed', () => {
    // Abort any in-flight LLM streams so their callbacks don't fire against a destroyed window.
    streams.forEach((s) => s.abort())
    streams.clear()
    win = null
  })

  // Security: never let model-output links navigate the trusted renderer or open child windows
  // that inherit the privileged preload. External https links open in the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  // Window-scoped ⌘Q / Ctrl+Q: only quits when this overlay is focused, not system-wide.
  win.webContents.on('before-input-event', (e, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'q' && input.type === 'keyDown') {
      e.preventDefault()
      app.quit()
    }
  })

  // Dev-only: screenshot ONLY this window (no desktop) for verification. Privacy-safe.
  if (process.env.ASKTOTO_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win?.webContents
          .capturePage()
          .then((img) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              require('node:fs').writeFileSync(process.env.ASKTOTO_SHOT as string, img.toPNG())
            } catch {
              /* ignore */
            }
          })
          .catch(() => {})
      }, 4500)
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    const params = new URLSearchParams()
    if (process.env.ASKTOTO_DEMO) params.set('demo', process.env.ASKTOTO_DEMO)
    // make the overlay visible in the capture; ASKTOTO_SHOTBG=light tests legibility over a bright backdrop
    if (process.env.ASKTOTO_SHOT) params.set('shotbg', process.env.ASKTOTO_SHOTBG || 'dark')
    const qs = params.toString()
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (qs ? `?${qs}` : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function resizeTo(height: number): void {
  if (!win) return
  // Clamp + reposition against the display the OVERLAY is actually on (not the cursor's). Otherwise, on a
  // laptop + external monitor of different heights, a streaming answer clamps to the wrong monitor and the
  // window jumps vertically while the cursor sits on the other screen.
  const { workArea } = screen.getDisplayMatching(win.getBounds())
  const h = Math.max(BAR_MIN_HEIGHT, Math.min(Math.round(height), workArea.height - 48))
  const b = win.getBounds()
  if (h === b.height && currentWidth === b.width) {
    lastBarHeight = h
    return // idempotent — skip a no-op setBounds (belt-and-braces with the renderer-side resize dedup)
  }
  lastBarHeight = h
  // Keep the panel fully on-screen; if it would grow below the work area, slide it up.
  const maxY = workArea.y + workArea.height - h - 8
  const y = Math.min(b.y, maxY)
  // When the width changes (collapse to / expand from the mini-pill), recenter around the old midpoint
  // so the overlay stays put; otherwise keep the left edge. Clamp x into the work area either way.
  let x = currentWidth === b.width ? b.x : Math.round(b.x + (b.width - currentWidth) / 2)
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - currentWidth - 8))
  win.setBounds({ x, y, width: currentWidth, height: h }, false)
}

/** Collapse to / expand from the control mini-pill by switching the window width; the renderer's
 *  auto-resize then settles the height to whichever surface is shown. */
function setMinimizedWidth(narrow: boolean): void {
  currentWidth = narrow ? PILL_WIDTH : BAR_WIDTH
  resizeTo(lastBarHeight) // re-apply immediately so width + recenter land before the renderer re-measures
}

/**
 * Switch the overlay between the compact 'bar' and the wide, fixed 'settings' surface.
 * Settings keeps the same top edge (so it grows downward from the bar) and centers horizontally,
 * clamped to the work area. Exiting restores the bar's width and last content height.
 */
// Re-center the compact bar on its current display. The old fixed 'settings' window-mode was removed —
// settings renders as a panel under the bar now, so the window only ever lives in 'bar' mode.
function setWindowMode(): void {
  if (!win) return
  const { workArea } = screen.getDisplayMatching(win.getBounds())
  const b = win.getBounds()
  let x = Math.round(b.x + (b.width - currentWidth) / 2)
  x = Math.max(workArea.x + 16, Math.min(x, workArea.x + workArea.width - currentWidth - 16))
  win.setBounds({ x, y: b.y, width: currentWidth, height: lastBarHeight }, false)
}

function sendHotkey(action: HotkeyAction): void {
  if (!win) return
  if (!win.isVisible()) win.show()
  win.webContents.send(IPC.hotkey, action)
}

let fatalHandled = false
/**
 * Log + audit + dump any unhandled error. For a fatal exception, offer a ONE-TIME relaunch — but default to
 * "Continue" so a benign async error never kills the overlay. No crashReporter upload by design (zero telemetry).
 */
function onFatal(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const detail = err instanceof Error ? err.stack || err.message : String(err)
  try {
    mainLog.error(`[${kind}]`, detail)
    auditLog('app.crash', { kind, message: err instanceof Error ? err.message : String(err) })
    writeFileSync(
      join(app.getPath('userData'), `crash-${Date.now()}.log`),
      `${new Date().toISOString()} ${kind}\n${detail}\n`,
      { mode: 0o600 }
    )
  } catch {
    /* logging is best-effort — never throw out of the crash handler */
  }
  if (kind !== 'uncaughtException' || fatalHandled) return
  fatalHandled = true
  try {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'AskToto hit a problem',
      message: 'AskToto ran into an unexpected error.',
      detail: 'A crash report was saved to your AskToto data folder. Relaunch now, or keep going.',
      buttons: ['Relaunch AskToto', 'Continue'],
      defaultId: 1,
      cancelId: 1
    })
    if (choice === 0) {
      app.relaunch()
      app.exit(0)
    }
  } catch {
    /* if the dialog itself fails, leave the app running */
  }
}

// --- Screen capture (cached + pre-warmable for vision latency) -----------------------------------------
// A vision ask issued within CAPTURE_TTL_MS of a (pre-warmed) capture reuses the JPEG instead of paying the
// ~150-450ms capture cost again. Kept tiny so the screen the model sees is never visibly stale.
const CAPTURE_TTL_MS = 1500
let shotCache: { image: string; width: number; height: number; ts: number } | null = null

async function captureScreenshot(): Promise<{ image: string; width: number; height: number }> {
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sf = disp.scaleFactor || 1
  // Render the thumbnail already capped at VISION_MAX_EDGE (smaller = faster capture + ~50% smaller upload
  // + ~33% less model prefill). 1280px keeps dense on-screen text legible; q72 JPEG.
  const VISION_MAX_EDGE = 1280
  const VISION_JPEG_Q = 72
  const fullW = Math.round(disp.size.width * sf)
  const fullH = Math.round(disp.size.height * sf)
  const capScale = Math.min(1, VISION_MAX_EDGE / Math.max(fullW, fullH))
  const thumbnailSize = {
    width: Math.max(1, Math.round(fullW * capScale)),
    height: Math.max(1, Math.round(fullH * capScale))
  }
  let sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  if (!sources.length) {
    // getSources can return empty transiently (right after launch or a fresh Screen-Recording grant).
    // Retry once before giving up so a momentary gap doesn't surface as a failed capture.
    await new Promise((r) => setTimeout(r, 250))
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  }
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) ?? sources[0]
  if (!src) throw new Error('No screen source available (grant Screen Recording permission)')
  let img = src.thumbnail
  const sz = img.getSize()
  const maxEdge = Math.max(sz.width, sz.height)
  if (maxEdge > VISION_MAX_EDGE) {
    const scale = VISION_MAX_EDGE / maxEdge
    img = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale) })
  }
  const jpeg = img.toJPEG(VISION_JPEG_Q)
  const size = img.getSize()
  return { image: jpeg.toString('base64'), width: size.width, height: size.height }
}

async function getScreenshot(): Promise<{ image: string; width: number; height: number }> {
  if (shotCache && Date.now() - shotCache.ts < CAPTURE_TTL_MS) {
    const { image, width, height } = shotCache
    return { image, width, height }
  }
  const shot = await captureScreenshot()
  shotCache = { ...shot, ts: Date.now() }
  auditLog('capture.screen', { width: shot.width, height: shot.height, bytes: shot.image.length })
  return shot
}

/** Fill the cache + warm the OS capture pipeline ahead of a real ask. Fire-and-forget; auth-gated. */
function prewarmCapture(): void {
  if (!requireAuth()) return
  getScreenshot().catch(() => {
    /* best-effort warm */
  })
}

function moveBy(dx: number, dy: number): void {
  if (!win) return
  const b = win.getBounds()
  // Clamp to the matching display's work area so the bar can never be flung fully off-screen with no
  // way back (now that the whole bar is a drag handle). Keeps the entire window reachable.
  const { workArea } = screen.getDisplayMatching(b)
  const x = Math.min(Math.max(b.x + dx, workArea.x), workArea.x + workArea.width - b.width)
  const y = Math.min(Math.max(b.y + dy, workArea.y), workArea.y + workArea.height - b.height)
  win.setBounds({ ...b, x, y })
}

/**
 * Keep the overlay reachable across display topology changes (monitor unplugged, lid closed, resolution
 * change). Without this the window stays anchored to a display that no longer exists and is stranded
 * off-screen with no fix but a restart. On any change, if the window no longer intersects the visible work
 * area of its matched display, clamp it back in (same math as moveBy). App-scoped listeners; live for the
 * app's lifetime, so they're never removed.
 */
function registerScreenListeners(): void {
  const reanchor = (): void => {
    if (!win) return
    const b = win.getBounds()
    const { workArea: wa } = screen.getDisplayMatching(b)
    const visible =
      b.x + b.width > wa.x && b.x < wa.x + wa.width && b.y + b.height > wa.y && b.y < wa.y + wa.height
    if (visible) return // still (partly) on a real display — leave it where the user put it
    const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width)
    const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height)
    win.setBounds({ ...b, x, y })
  }
  screen.on('display-removed', reanchor)
  screen.on('display-added', reanchor)
  screen.on('display-metrics-changed', reanchor)
}

function toggleVisible(): void {
  if (!win) return
  if (win.isVisible()) win.hide()
  else {
    win.show()
    win.webContents.send(IPC.hotkey, 'ask')
  }
}

const shortcutActions: Record<string, () => void> = {
  ask: () => sendHotkey('ask'),
  hide: () => toggleVisible(),
  reset: () => sendHotkey('reset'),
  'toggle-listen': () => sendHotkey('toggle-listen'),
  capture: () => sendHotkey('capture'),
  factcheck: () => sendHotkey('factcheck'),
  'scroll-up': () => moveBy(0, -60),
  'scroll-down': () => moveBy(0, 60)
}

function resolveShortcut(action: HotkeyAction, user: Record<string, string>): string {
  return user[action] ?? DEFAULT_SHORTCUTS[action] ?? ''
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll()
  const user = getSettings().shortcuts ?? {}
  for (const [action, fn] of Object.entries(shortcutActions)) {
    const accel = resolveShortcut(action as HotkeyAction, user)
    if (!accel) continue
    try {
      const ok = globalShortcut.register(accel, fn)
      if (!ok) mainLog.warn(`[shortcuts] failed to register ${action}: ${accel}`)
    } catch (e) {
      mainLog.warn(`[shortcuts] invalid accelerator for ${action}: ${accel}`, e)
    }
  }
}

let meetingTimer: ReturnType<typeof setInterval> | null = null
let meetingActive = false
let meetingDetecting = false
let meetingDetectFailures = 0 // consecutive poll failures → one degraded-audit signal once it's persistent

// Cache today's agenda (~30s) so the 7s poller can cross-reference detected meetings against real calendar
// events without hammering Graph. Validation only RESTRICTS auto-start when there are events to match
// against; it always degrades OPEN when calendar is unavailable, so behavior is unchanged off Azure.
let calendarCache: { events: CalendarEvent[]; ts: number } | null = null
const CALENDAR_CACHE_TTL_MS = 30_000

/**
 * Should a window-title-detected meeting auto-start? Cross-references the detected title against today's
 * Outlook agenda to reject false positives (e.g. "Q4 Review | Microsoft Teams" — a chat, not a call).
 * Degrades OPEN (true) whenever calendar can't disprove it: browser-URL meetings (already high confidence),
 * not signed in, Graph unavailable/consent-needed, or an empty agenda. Only an authenticated agenda WITH
 * events and NO title match suppresses the auto-start (manual start always works regardless).
 */
async function shouldAutoStart(hit: string): Promise<boolean> {
  const detail = hit.slice(hit.indexOf('|') + 1)
  const d = detail.trim()
  // Resolve today's events (or leave null = unavailable). The match/degrade-open logic itself lives in the
  // pure, unit-tested titleMatchesCalendar (handles URL / unavailable / empty / match).
  let events: CalendarEvent[] | null = null
  if (d && !/^https?:\/\//i.test(d) && requireAuth()) {
    if (!calendarCache || Date.now() - calendarCache.ts > CALENDAR_CACHE_TTL_MS) {
      let tz = 'UTC'
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      } catch {
        /* keep UTC */
      }
      const res = await calendarToday(tz)
      if (res.ok && res.events) {
        calendarCache = { events: res.events, ts: Date.now() }
        events = res.events
      }
    } else {
      events = calendarCache.events
    }
  }
  return titleMatchesCalendar(detail, events)
}

function startMeetingPoller(): void {
  if (meetingTimer) return
  meetingTimer = setInterval(async () => {
    if (meetingDetecting) return // skip if the previous detect is still running (no overlap)
    if (!getSettings().onboardingDone || !getSettings().autoStartOnMeeting) {
      return
    }
    meetingDetecting = true
    try {
      const hit = await detectMeeting(getSettings().customMeetingApps)
      meetingDetectFailures = 0 // a completed poll (hit or not) clears the failure streak
      if (hit && !meetingActive) {
        if (await shouldAutoStart(hit)) {
          meetingActive = true
          if (win && !win.isVisible()) win.show() // surface the overlay so the user sees recording start
          win?.webContents.send(IPC.meetingDetected, { app: hit.split('|')[0], active: true })
        }
        // else: probable false positive (no matching calendar event) — skip auto-start; manual still works
      } else if (!hit && meetingActive) {
        meetingActive = false
        win?.webContents.send(IPC.meetingDetected, { active: false }) // meeting ended → renderer wraps up
      }
    } catch (e) {
      // osascript timeout / Automation-denied etc. Without this catch a broken detector looks identical to
      // "no meeting". Log every failure; emit ONE degraded-audit signal once it's clearly persistent.
      meetingDetectFailures++
      mainLog.error('[meeting-detect] poll failed:', e instanceof Error ? e.message : String(e))
      if (meetingDetectFailures === 3) {
        auditLog('meeting.detect.degraded', { consecutiveFailures: meetingDetectFailures })
      }
    } finally {
      meetingDetecting = false
    }
  }, 7000)
}

function createTray(): void {
  try {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../build/icon.png')
    let img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) img = img.resize({ width: 18, height: 18 })
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
    if (process.platform === 'darwin' && img.isEmpty()) tray.setTitle(' ◉ Toto')
    const menu = Menu.buildFromTemplate([
      { label: 'Show / Hide  (⌘\\)', click: toggleVisible },
      { label: 'Settings…', click: () => {
        if (win && !win.isVisible()) win.show()
        sendHotkey('settings')
      } },
      { label: 'Listen / Stop listening  (⌘⇧L)', click: () => sendHotkey('toggle-listen') },
      { label: "Today's agenda", click: () => {
        if (win && !win.isVisible()) win.show()
        sendHotkey('agenda')
      } },
      { label: 'New  (⌘⇧R)', click: () => sendHotkey('reset') },
      { type: 'separator' },
      { label: 'Quit AskToto', click: () => app.quit() }
    ])
    tray.setToolTip('AskToto')
    tray.setContextMenu(menu)
  } catch {
    /* tray optional */
  }
}

/** Updates the tray/menubar to reflect whether recording is active. */
function setTrayRecording(on: boolean): void {
  if (!tray) return
  if (on) {
    tray.setToolTip('🔴 AskToto — Recording')
    if (process.platform === 'darwin') tray.setTitle(' 🔴 Toto')
  } else {
    tray.setToolTip('AskToto')
    if (process.platform === 'darwin') tray.setTitle(' ◉ Toto')
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, (e) => {
    assertMainWindow(e)
    return publicSettings()
  })
  ipcMain.handle(IPC.permissionsGet, (e) => {
    assertMainWindow(e)
    return getPlatformPermissions()
  })

  ipcMain.handle(IPC.settingsSet, (e, patch) => {
    assertMainWindow(e)
    const p = patch ?? {}
    const wasEncrypted = getSettings().encryptTranscripts
    const next = setSettings(p)
    auditLog('settings.changed', { keys: Object.keys(p) })
    // At-rest encryption just turned on → purge any previously-built CLEARTEXT knowledge graph so it
    // can't leak meeting topics/entities the encryption is meant to protect. (Builds are already
    // blocked while encryption is on, so no graph will be regenerated until it's turned back off.)
    if (!wasEncrypted && next.encryptTranscripts) {
      purgeGraphArtifacts()
      auditLog('graph.purged', { reason: 'encryption-enabled' })
    }
    win?.setContentProtection(contentProtectionOn())
    // Only reconfigure the OS login item when that setting actually changed. Calling it on every
    // unrelated save is wasteful and, on unsigned/dev builds, logs a noisy "Operation not permitted".
    if ('launchAtLogin' in p) {
      try {
        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
      } catch {
        /* not supported on this platform */
      }
    }
    // Shortcuts may have changed — re-register from the new settings.
    registerShortcuts()
    return publicSettings()
  })

  ipcMain.handle(IPC.setApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = SetApiKeyPayloadSchema.parse(payload)
    setApiKey(parsed.provider, parsed.key)
    auditLog('key.set', { provider: parsed.provider })
    return { hasKeys: hasKeysMap() }
  })

  ipcMain.handle(IPC.clearApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = ClearApiKeyPayloadSchema.parse(payload)
    clearApiKey(parsed.provider)
    auditLog('key.removed', { provider: parsed.provider })
    return { hasKeys: hasKeysMap() }
  })

  ipcMain.handle(IPC.testApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = TestApiKeyPayloadSchema.parse(payload)
    return testApiKey(parsed.provider, parsed.key)
  })

  ipcMain.handle(IPC.dustListAgents, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return listDustAgents()
  })

  // Connect to Dust locally by importing the Dust CLI's keychain session (token + workspace + region).
  // refreshDustCliSession first runs `dust status` so the CLI mints a fresh access token before we read
  // it — without this, a reconnect after the ~1h OAuth token expires imports the stale token (import
  // "succeeds" but every agent call then 401s). Refresh is cheap when the token is still valid.
  ipcMain.handle(IPC.dustImportCli, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const s = await refreshDustCliSession()
    if (!s.ok || !s.token || !s.workspaceId) return { ok: false, error: s.error }
    setApiKey('dust', s.token)
    setSettings({ dustWorkspaceId: s.workspaceId, dustBaseUrl: s.baseUrl || 'https://dust.tt' })
    return { ok: true, workspaceId: s.workspaceId, baseUrl: s.baseUrl }
  })

  // No CLI session yet → kick off the install + interactive login for the user (opens a Terminal window).
  ipcMain.handle(IPC.dustSetupCli, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return setupDustCli()
  })

  // CLI provider detection/testing/setup (claude-cli, codex-cli).
  ipcMain.handle(IPC.cliDetect, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return detectCli(typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli')
  })
  ipcMain.handle(IPC.cliTest, async (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli'
    const r = await testCli(p)
    if (r.ok) {
      const s = getSettings()
      setSettings({ cliConnected: { ...s.cliConnected, [p]: true } })
    }
    return r
  })
  ipcMain.handle(IPC.cliSetup, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return setupCli(typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli')
  })
  ipcMain.handle(IPC.cliInstall, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli'
    return installCli(p, (line) => win?.webContents.send(IPC.cliInstallProgress, { provider: p, line }))
  })
  ipcMain.handle(IPC.cliLogin, (e, provider: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return loginCli(typeof provider === 'string' ? (provider as ProviderId) : 'claude-cli')
  })

  ipcMain.handle(IPC.authStatus, (e) => {
    assertMainWindow(e)
    return authStatus()
  })
  ipcMain.handle(IPC.authSignIn, async (e) => {
    assertMainWindow(e)
    const status = await authSignIn()
    prewarmCapture() // warm the cold capture pipeline now that we're signed in (no-op if not authed)
    prewarmCli() // warm the CLI binary cache so the first CLI ask doesn't stall on a login-shell lookup
    return status
  })
  ipcMain.handle(IPC.authSignOut, (e) => {
    assertMainWindow(e)
    return authSignOut()
  })
  ipcMain.handle(IPC.calendarToday, async (e, tz: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return calendarToday(typeof tz === 'string' ? tz : 'UTC')
  })

  // Parakeet (on-device, main-process). Whisper stays the renderer default; these only run when the user
  // selects the Parakeet engine. All wrapped so a failure degrades to Whisper rather than breaking Listen.
  ipcMain.handle(IPC.parakeetStatus, (e) => {
    assertMainWindow(e)
    return { ready: parakeetModelReady() }
  })
  ipcMain.handle(IPC.parakeetEnsure, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false }
    try {
      await ensureParakeetModel((pct) => win?.webContents.send(IPC.parakeetProgress, { pct }))
      return { ok: parakeetModelReady() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.parakeetFeed, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const p = payload as { samples?: unknown }
    if (!(p?.samples instanceof Float32Array)) return ''
    return parakeetTranscribe(p.samples)
  })

  ipcMain.handle(IPC.captureScreen, async (event) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    return getScreenshot()
  })
  // Pre-warm: prime the cache + spin up the OS capture pipeline so the next real vision ask is instant.
  ipcMain.handle(IPC.prewarmCapture, (e) => {
    assertMainWindow(e)
    prewarmCapture()
  })

  ipcMain.handle(IPC.askStart, (e, raw) => {
    assertMainWindow(e)
    const id =
      raw && typeof raw === 'object' && 'id' in (raw as object)
        ? String((raw as { id: unknown }).id)
        : ''
    if (!requireAuth()) {
      win?.webContents.send(IPC.streamError, {
        id,
        message: 'Sign in with your Mantu account to use AskToto.'
      })
      return
    }
    try {
    const req = AskStartSchema.parse(raw)
    const s = getSettings()
    const allowed = getAllowedProviders() // org allowlist (null = unrestricted)

    // Find the next eligible keyed provider not yet tried — for failover when the primary can't answer.
    const failover = (tried: ProviderId[]): boolean => {
      const tier = routeTier(req, s.thinkingMode)
      const next = (Object.keys(PROVIDERS) as ProviderId[]).find(
        (p) =>
          !tried.includes(p) &&
          (!allowed || allowed.includes(p)) &&
          (PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : getApiKey(p).length > 0) &&
          (req.mode !== 'vision' || PROVIDERS[p].vision) &&
          !!resolveModelTier(p, s.providerModels, s.providerModelsThinking, tier)
      )
      if (!next) return false
      attempt(next, tried)
      return true
    }

    // Validate a provider, start the stream, and on a PRE-token (TTFT) failure fall over to the next one.
    const attempt = (provider: ProviderId, attempted: ProviderId[]): void => {
      const def = PROVIDERS[provider]
      if (allowed && !allowed.includes(provider)) {
        auditLog('provider.blocked', { provider })
        if (attempted.length === 0)
          win?.webContents.send(IPC.streamError, {
            id: req.id,
            message: `${def.label} is not on your organization's approved provider list.`
          })
        else if (!failover(attempted.concat(provider))) win?.webContents.send(IPC.streamError, { id: req.id, message: 'No approved provider could answer.' })
        return
      }
      const key = getApiKey(provider)
      const tier = routeTier(req, s.thinkingMode)
      const model = resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep)
      const ineligible = def.kind === 'cli' && !s.cliConnected[provider]
        ? `${def.label} is not connected. Open Settings → CLI Integration to set it up.`
        : def.kind !== 'cli' && !key
        ? `No API key for ${def.label}. Open Settings (gear) and add it.`
        : def.kind !== 'cli' && !model
          ? provider === 'dust'
            ? `No ${tier === 'think' ? 'thinking' : 'base'} Dust agent set. Open Settings → Connect Dust and pick your agents.`
            : `No model set for ${def.label}. Pick a model in Settings.`
          : req.mode === 'vision' && !def.vision
            ? `${def.label} can't read screenshots. Switch to Claude or GPT in Settings, or ask without a screen capture.`
            : provider === 'dust' && !s.dustWorkspaceId
              ? 'Add your Dust workspace ID in Settings → Your AI → Dust setup.'
              : ''
      if (ineligible) {
        if (attempted.length === 0) win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
        else failover(attempted.concat(provider)) // a bad fallback — just skip to the next
        return
      }
      const baseURL =
        provider === 'custom' ? s.customBaseUrl : provider === 'dust' ? s.dustBaseUrl : def.baseUrl
      auditLog('provider.request', { provider, model, mode: req.mode, tier, retry: attempted.length > 0 })
      // Per-tier idle budget: a live suggest gives up fast to stay real-time; recaps + deep answers get the
      // full headroom. Bounds time-to-first-token and triggers failover when a provider stalls before a token.
      const idleMs =
        req.mode === 'suggest'
          ? 15_000
          : req.mode === 'recap' || req.mode === 'summary'
            ? 120_000
            : tier === 'deep'
              ? 120_000
              : tier === 'think'
                ? 90_000
                : req.mode === 'vision'
                  ? 60_000
                  : 45_000
      const startedAt = Date.now()
      let gotToken = false
      let ttftMs: number | undefined
      const handle = createStream({
        providerId: provider,
        kind: def.kind,
        apiKey: key,
        baseURL,
        workspaceId: s.dustWorkspaceId,
        // Dust OAuth tokens (imported from the local CLI) expire after ~1h. On a pre-token 401 the
        // stream asks for fresh creds: re-mint via the CLI, persist them, and replay once — so an
        // expired token self-heals invisibly instead of surfacing an error.
        refreshDustAuth:
          provider === 'dust'
            ? async () => {
                const fresh = await refreshDustCliSession()
                if (!fresh.ok || !fresh.token || !fresh.workspaceId) return null
                setApiKey('dust', fresh.token)
                const baseUrl = fresh.baseUrl || 'https://dust.tt'
                setSettings({ dustWorkspaceId: fresh.workspaceId, dustBaseUrl: baseUrl })
                auditLog('dust.token.refreshed', {})
                return { apiKey: fresh.token, workspaceId: fresh.workspaceId, baseURL: baseUrl }
              }
            : undefined,
        model,
        temperature: s.temperature,
        idleMs,
        system: buildSystem(req, s.mode, s.profile, s.modePrompts, s.contextDocs[s.mode] || [], s.outputLanguage, s.summaryLanguage, s.systemPrompt),
        req,
        handlers: {
          onDelta: (text) => {
            if (!gotToken) ttftMs = Date.now() - startedAt
            gotToken = true
            win?.webContents.send(IPC.streamDelta, { id: req.id, text })
          },
          onDone: (u) => {
            streams.delete(req.id)
            // Latency telemetry (metadata only) — feeds the p50/p95 TTFT + answer-latency evals (section H/D).
            auditLog('provider.request', { provider, model, mode: req.mode, tier, phase: 'done', ttftMs, totalMs: Date.now() - startedAt })
            win?.webContents.send(IPC.streamDone, { id: req.id, ...u })
          },
          onError: (message) => {
            streams.delete(req.id)
            auditLog('provider.failed', { provider, gotToken })
            // Fall over only on a PRE-token failure (the user hasn't seen a partial answer yet).
            if (!gotToken && failover(attempted.concat(provider))) return
            // A Dust auth error here means the token expired AND the silent refresh failed (session
            // truly gone) — give a clear one-click path instead of a raw API error.
            const friendly =
              provider === 'dust' &&
              /oauth|unauthor|expired|authentication credential|invalid.*(token|credential)/i.test(message)
                ? 'Your Dust session expired and could not refresh automatically. Open Settings and reconnect Dust once.'
                : message
            win?.webContents.send(IPC.streamError, { id: req.id, message: friendly })
          }
        }
      })
      streams.set(req.id, handle)
    }

    attempt(s.provider, [])
    } catch (e) {
      win?.webContents.send(IPC.streamError, {
        id,
        message: e instanceof Error ? e.message : 'Could not start the answer.'
      })
    }
  })

  ipcMain.handle(IPC.askCancel, (e, id: string) => {
    assertMainWindow(e)
    streams.get(id)?.abort()
    streams.delete(id)
  })

  ipcMain.handle(IPC.armAudio, (e, on: boolean) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    audioArmed = !!on
  })

  ipcMain.handle(IPC.saveTranscript, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const m = SaveMeetingSchema.parse(raw)
    const r = { path: await saveMeeting(getSettings(), m) }
    scheduleRebuild() // refresh the knowledge graph with the new note (debounced; no-op if disabled)
    return r
  })

  ipcMain.handle(IPC.saveNote, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const n = SaveNoteSchema.parse(raw)
    const r = { path: await saveNote(getSettings(), n) }
    scheduleRebuild()
    return r
  })

  // Answer feedback (good/bad) → audit log only. Metadata-only: the rating + answer kind, NEVER the
  // answer text or question (those would be content). Seeds the H-section acceptance-rate eval later.
  ipcMain.handle(IPC.answerFeedback, (e, raw: unknown) => {
    assertMainWindow(e)
    const r = raw as { rating?: unknown; kind?: unknown } | null
    const rating = r?.rating === 'up' || r?.rating === 'down' ? r.rating : null
    if (!rating) return
    auditLog('answer.feedback', { rating, kind: typeof r?.kind === 'string' ? r.kind : undefined })
  })

  // Parse a recap's markdown into a structured object (decisions + action-items-with-owners) the renderer
  // can copy as JSON for Jira/Asana/Notion. Pure transform of text the renderer already holds — no disk I/O.
  ipcMain.handle(IPC.exportRecapJson, (e, markdown: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return parseRecapMarkdown(typeof markdown === 'string' ? markdown : '')
  })

  ipcMain.handle(IPC.graphifyStatus, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { enabled: false, installed: false, backend: null, building: false, hasGraph: false }
    return graphifyStatus()
  })

  ipcMain.handle(IPC.graphifyRebuild, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return buildGraph(false) // explicit user rebuild = full
  })

  ipcMain.handle(IPC.graphifyRelated, (e, file: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Not signed in.', topics: [], notes: [] }
    return relatedNotes(String(file || ''))
  })

  ipcMain.handle(IPC.graphifyOpenGraph, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const html = graphHtml()
    if (!html) return ''
    await shell.openPath(html)
    return html
  })

  ipcMain.handle(IPC.pickFolder, async (e) => {
    assertMainWindow(e)
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose where AskToto saves meeting transcripts'
    })
    if (!r.canceled && r.filePaths[0]) setSettings({ meetingsFolder: r.filePaths[0] })
    return publicSettings()
  })

  ipcMain.handle(IPC.openPath, (e) => {
    assertMainWindow(e)
    return requireAuth() ? shell.openPath(resolveMeetingsFolder(getSettings())) : ''
  })
  ipcMain.handle(IPC.recallList, (e) => {
    assertMainWindow(e)
    return requireAuth() ? listMeetings() : []
  })
  ipcMain.handle(IPC.recallSearch, (e, q: string) => {
    assertMainWindow(e)
    return requireAuth() ? searchMeetings(String(q ?? '')) : []
  })
  ipcMain.handle(IPC.recallOpen, (e, file: string) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const folder = resolveMeetingsFolder(getSettings())
    const path = join(folder, basename(String(file ?? ''))) // basename blocks traversal
    // Encrypted transcripts are unreadable in an editor — open a decrypted temp copy instead.
    if (isEncryptedFile(path)) return shell.openPath(decryptToTemp(path))
    return shell.openPath(path)
  })

  ipcMain.handle(IPC.listeningState, (e, on: unknown) => {
    assertMainWindow(e)
    setTrayRecording(!!on)
  })

  ipcMain.handle(IPC.windowResize, (e, payload: { height: number }) => {
    assertMainWindow(e)
    resizeTo(payload?.height ?? BAR_HEIGHT)
  })
  ipcMain.handle(IPC.windowMode, (e) => {
    assertMainWindow(e)
    setWindowMode()
  })
  ipcMain.handle(IPC.windowMinimize, (e, narrow: unknown) => {
    assertMainWindow(e)
    setMinimizedWidth(!!narrow)
  })
  // Drag the overlay from anywhere on the bar (the renderer's JS drag drives this with screen-pixel deltas).
  ipcMain.handle(IPC.windowMoveBy, (e, d: unknown) => {
    assertMainWindow(e)
    const { dx, dy } = (d ?? {}) as { dx?: number; dy?: number }
    if (typeof dx === 'number' && typeof dy === 'number' && Number.isFinite(dx) && Number.isFinite(dy)) {
      moveBy(dx, dy)
    }
  })
  ipcMain.handle(IPC.windowHide, (e) => {
    assertMainWindow(e)
    win?.hide()
  })
  ipcMain.handle(IPC.windowToggle, (e) => {
    assertMainWindow(e)
    toggleVisible()
  })
  ipcMain.handle(IPC.windowQuit, (e) => {
    assertMainWindow(e)
    app.quit()
  })
}

// ─── asr-model:// custom protocol ────────────────────────────────────────────
// The packaged renderer loads over file://, which cannot fetch from the network.
// We register a privileged custom scheme so the Whisper worker and transformers.js
// can load bundled model weights (and the ONNX-runtime WASM blobs) via fetch()
// without any network call. registerSchemesAsPrivileged MUST run before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'asr-model',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })
  app.whenReady().then(async () => {
  initLogging() // route main-process logs to a rotated file before anything else can fail
  // Never let an unhandled error crash the overlay silently — log to file, audit, write a crash dump, and
  // (for a fatal exception) offer a one-time relaunch while defaulting to keep-alive.
  process.on('uncaughtException', (err) => onFatal('uncaughtException', err))
  process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason))
  if (process.env.ASKTOTO_SELFTEST) {
    try {
      await runSelfTest(process.env.ASKTOTO_SELFTEST)
    } catch (e) {
      console.error('selftest failed', e)
    }
    app.quit()
    return
  }
  if (!app.isPackaged) loadDotEnv() // dev convenience only; never read a stray .env in production
  ensureMeetingsFolder(getSettings()) // create the self-documenting OneDrive folder on first run
  if (process.platform === 'darwin') app.dock?.hide()
  // System-audio loopback: when the renderer calls getDisplayMedia for audio,
  // hand back the system audio loopback device (the "Them" channel) only.
  // Screenshot capture uses desktopCapturer directly, so no video track is ever returned here.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const frame = request.frame
      const mainFrame = win?.webContents.mainFrame
      const origin = request.securityOrigin
      const mainUrl = win?.webContents.getURL() ?? ''
      let expectedOrigin = ''
      try {
        expectedOrigin = new URL(mainUrl).origin
      } catch {
        expectedOrigin = mainUrl
      }
      const isMainFrame = !!frame && frame === mainFrame
      // In the PACKAGED app the renderer is loaded from file://, whose origin is the opaque string
      // "null" (from new URL(...).origin) while the request reports securityOrigin "file:///". Without
      // this case the check denied EVERY system-audio request in production. The real identity guard is
      // isMainFrame (frame === the main window's frame); the origin match is defense-in-depth.
      const isFileOrigin = origin.startsWith('file://')
      const originOk =
        !mainUrl || origin === expectedOrigin || origin === mainUrl || (expectedOrigin === 'null' && isFileOrigin)
      if (process.env.ASKTOTO_DEBUG) {
        console.log('[display-media]', {
          origin,
          expectedOrigin,
          frameUrl: frame?.url,
          mainUrl,
          mainFrame: isMainFrame,
          originOk,
          audioRequested: request.audioRequested,
          videoRequested: request.videoRequested,
          armed: audioArmed
        })
      }
      if (!audioArmed) {
        callback({}) // deny unless the user explicitly started Listen
        return
      }
      if (!isMainFrame || !originOk) {
        callback({}) // deny requests from unexpected origins or subframes
        return
      }
      if (!request.audioRequested) {
        callback({}) // must be an audio (loopback) request
        return
      }
      // macOS binds system-audio loopback to a ScreenCaptureKit screen stream, so the loopback only
      // starts when a screen video source is attached. We grant one here (gated above on armed +
      // main-frame + origin); the renderer drops the video track instantly, so no frame is rendered,
      // saved, or sent. This is the only way to capture the "them" side of a call on macOS.
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      const screenSrc = sources[0]
      callback(screenSrc ? { video: screenSrc, audio: 'loopback' } : {})
    },
    { useSystemPicker: false }
  )

  // Deny every web permission by default; only the main window may use audio media (the Listen mic).
  // Everything else (geolocation, notifications, camera, clipboard-read, USB, MIDI, etc.) is rejected.
  const allowPermission = (wc: Electron.WebContents | null, permission: string): boolean =>
    permission === 'media' && !!win && wc === win.webContents
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
    callback(allowPermission(wc, permission))
  )
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowPermission(wc, permission))

  // ─── asr-model:// protocol handler ───────────────────────────────────────
  // Maps asr-model://<host>/<pathname> → RES_BASE/<host>/<pathname> on disk.
  // This lets the Whisper worker (served over file://) use fetch() to load
  // bundled ONNX model weights and WASM blobs with zero network access.
  // Path-traversal guard: relative() must stay within RES_BASE (separator-safe on Windows).
  {
    const REPO_ROOT = join(__dirname, '..', '..')
    const RES_BASE = app.isPackaged
      ? process.resourcesPath
      : join(REPO_ROOT, 'resources')

    // Expose whether the bundled ORT + a model file are present so the renderer
    // only switches to the offline asr-model:// scheme when the assets exist.
    const ASR_BUNDLED =
      existsSync(join(RES_BASE, 'ort', 'ort-wasm-simd-threaded.jsep.wasm')) &&
      existsSync(join(RES_BASE, 'models', 'Xenova', 'whisper-base', 'config.json'))
    ipcMain.handle(IPC.asrBundled, () => ASR_BUNDLED)

    protocol.handle('asr-model', async (req) => {
      try {
        const url = new URL(req.url)
        // url.host = e.g. "models" or "ort"; url.pathname = e.g. "/Xenova/whisper-base/config.json"
        const rel = decodeURIComponent(url.host + url.pathname)
        const abs = resolve(RES_BASE, rel)
        // Symlink escape guard: resolve symlinks to their real path before the traversal check.
        // realpathSync throws ENOENT for non-existent paths → return 404.
        let real: string
        try {
          real = realpathSync(abs)
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return new Response(null, { status: 404 })
          }
          throw e
        }
        // Path-traversal guard (separator-safe on Windows): reject any path that escapes RES_BASE.
        // Run the check against the real (symlink-resolved) path, not the raw abs path.
        const relCheck = relative(RES_BASE, real)
        if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
          return new Response(null, { status: 403 })
        }
        const resp = await net.fetch(pathToFileURL(real).toString())
        const TYPES: Record<string, string> = {
          '.mjs': 'text/javascript',
          '.js': 'text/javascript',
          '.wasm': 'application/wasm',
          '.json': 'application/json',
          '.onnx': 'application/octet-stream',
          '.txt': 'text/plain'
        }
        const ct = TYPES[extname(real).toLowerCase()]
        if (!ct) return resp
        const headers = new Headers(resp.headers)
        headers.set('Content-Type', ct)
        return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
      } catch {
        return new Response(null, { status: 500 })
      }
    })
  }

  // Boot each subsystem in its own try/catch so one failure can't abort the rest, and stand up the
  // tray + global shortcuts BEFORE the window. If createWindow() ever throws (transparent / always-on-top
  // windows can fail on some GPU/compositor configs), the user still keeps a Show/Quit path instead of a
  // hidden, unkillable process — the dock is already hidden and the taskbar is skipped.
  const runStep = (name: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      console.error(`[boot] ${name} failed:`, e)
    }
  }
  // Auto-connect the local Dust CLI session on every launch so Dust stays connected without a manual
  // re-import. The imported OAuth token is short-lived (~1h) and goes stale between runs, so we refresh it
  // (refreshDustCliSession runs `dust status` to mint a fresh one, then re-reads the keychain) and persist.
  // Only for users who've already connected Dust (workspace set) → non-Dust users pay nothing. macOS only.
  function autoConnectDust(): void {
    if (process.platform !== 'darwin') return
    if (!getSettings().dustWorkspaceId) return
    void (async () => {
      try {
        const fresh = await refreshDustCliSession()
        if (fresh.ok && fresh.token && fresh.workspaceId) {
          setApiKey('dust', fresh.token)
          setSettings({ dustWorkspaceId: fresh.workspaceId, dustBaseUrl: fresh.baseUrl || 'https://dust.tt' })
          auditLog('dust.token.refreshed', { source: 'autoconnect' })
        }
      } catch {
        /* best-effort — the Dust stream path also self-heals an expired token on first use */
      }
    })()
  }

  runStep('registerIpc', registerIpc)
  runStep('createTray', createTray)
  runStep('registerShortcuts', registerShortcuts)
  runStep('createWindow', createWindow)
  runStep('autoConnectDust', autoConnectDust)
  runStep('registerScreenListeners', registerScreenListeners)
  runStep('startMeetingPoller', startMeetingPoller)
  runStep('initAutoUpdate', initAutoUpdate)

  app.on('activate', () => {
    if (!win) createWindow()
    else win.show()
  })
  }).catch((e) => console.error('AskToto startup failed:', e))
}

app.on('window-all-closed', () => {
  // Overlay app: stay alive in tray; quit only via tray/menu.
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (meetingTimer) clearInterval(meetingTimer)
})
