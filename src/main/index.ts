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
  net,
  Notification,
  clipboard,
  powerSaveBlocker
} from 'electron'
import { join, basename, resolve, relative, isAbsolute, extname } from 'node:path'
import { readFileSync, existsSync, writeFileSync, realpathSync, readdirSync, unlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  IPC,
  AskStartSchema,
  SetApiKeyPayloadSchema,
  ClearApiKeyPayloadSchema,
  TestApiKeyPayloadSchema,
  McpCrmTestConnectionPayloadSchema,
  McpCrmSaveConnectionPayloadSchema,
  McpCrmPushPayloadSchema,
  NotebookLmAskPayloadSchema,
  SetDealOutcomePayloadSchema,
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
import { resetDustConversation } from './llm/dust'
import { enqueueIngest, startBackfill, brainBackfillProgress, resumeBackfillIfPending, settleCommitment } from './brain/ingest'
import { openIntelligenceWindow, isIntelligenceSender } from './intelligence'
import {
  readIndex as readBrainIndex,
  readGraph as readBrainGraph,
  readPerson as readBrainPerson,
  readAccount as readBrainAccount,
  readDeal as readBrainDeal,
  listEntities as listBrainEntities,
  listMeetingExtractions as listBrainMeetingExtractions,
  readMeetingExtraction as readBrainMeetingExtraction,
  purgeBrain,
  setDealOutcome,
  slugify as brainSlugify
} from './brain/store'
import { buildBrainContext } from './brain/context'
import { buildSystem } from './personas'
import { initLogging, mainLog, auditLog } from './logger'
import { authStatus, signIn as authSignIn, signOut as authSignOut, requireAuth } from './auth'
import { calendarToday } from './calendar'
import { parakeetModelReady, ensureParakeetModel, parakeetTranscribe } from './parakeet'
import {
  saveMeeting,
  saveNote,
  appendDebrief,
  saveDraftTranscript,
  clearDraftTranscript,
  recoverOrphanDrafts,
  parseRecapMarkdown,
  recapMarkdownToHtml,
  resolveMeetingsFolder,
  ensureMeetingsFolder,
  isEncryptedFile,
  decryptToTemp,
  sweepStaleTempFiles
} from './transcripts'
import { getPlatformPermissions } from './platform-perms'
import {
  listMeetings,
  searchMeetings,
  recallRead,
  deleteMeeting,
  deleteAllMeetings,
  sweepExpiredMeetings
} from './recall'
import { initAutoUpdate } from './updater'
import updaterPkg from 'electron-updater'
import { runSelfTest } from './selftest'
import { readEvalMetrics, aggregateMetrics } from './metrics'
import { refreshDustCliSession, setupDustCli } from './dustcli'
import { detectCli, testCli, setupCli, installCli, loginCli, prewarmCli } from './cli'
import { connectBidstack, pushToBidstack } from './mcp/bidstackClient'
import { detectNotebookLmCli, installNotebookLmCli, connectNotebookLm, askNotebookLm } from './mcp/notebooklm'
import {
  setBidstackApiKey,
  getBidstackApiKey,
  clearBidstackApiKey,
  hasBidstackApiKey
} from './mcp/bidstackSecrets'
import {
  graphifyStatus,
  buildGraph,
  relatedNotes,
  graphHtml,
  scheduleRebuild,
  purgeGraphArtifacts
} from './graphify'
import { runFirstRunBootstrap } from './bootstrap'
import { SaveMeetingSchema, SaveNoteSchema } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, applyInteractiveGuardrail, type ProviderId } from '@shared/providers'
import { routeTier } from '@shared/routing'
import { redactSecrets } from '@shared/redact'

// Belt-and-braces with the per-meeting powerSaveBlocker below: keep Chromium itself from ever
// deprioritizing the (hidden) renderer that hosts the transcription worker. Must run before app ready.
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// QA hook (same family as ASKTOTO_DEMO / ASKTOTO_SHOT): point the app at an isolated profile so
// physical QA never reads — or refuses to write over — the packaged app's keychain-wrapped real
// userData. Must run before anything touches app.getPath('userData').
if (process.env.ASKTOTO_USERDATA) app.setPath('userData', process.env.ASKTOTO_USERDATA)

// Unpackaged (npm run dev / QA) runs must never share the packaged app's userData: its settings.json
// is safeStorage-encrypted under the packaged binary's keychain identity, so a dev process can't
// decrypt it — reads fall back to defaults (onboarding reappears) and the write guard refuses to
// clobber it, wedging onboarding at the last slide. A '-dev' suffixed profile sidesteps all of it.
if (!app.isPackaged && !process.env.ASKTOTO_USERDATA) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

const BAR_WIDTH = 880
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

/** The three read-only brain channels are ALSO callable from the Mantu Intelligence window's top frame
 *  (its preload exposes nothing else — see src/preload/intelligence.ts). Everything privileged stays
 *  main-window-only via assertMainWindow. */
function assertBrainReader(event: Electron.IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (isIntelligenceSender(event.sender)) {
    if (!frame || frame.parent !== null) throw new Error('IPC denied: not main frame')
    return
  }
  assertMainWindow(event)
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
  // Debug aid (opt-in via ASKTOTO_DEBUG_RENDERER): mirror renderer warnings/errors into the main-process
  // log so a crash-to-error-boundary can be diagnosed without opening the renderer devtools.
  if (process.env.ASKTOTO_DEBUG_RENDERER) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.log(`[renderer] ${message}  (${sourceId}:${line})`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[renderer-gone] reason=${details.reason} exitCode=${details.exitCode}`)
    })
  }
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
    const redactedDetail = redactSecrets(detail)
    writeFileSync(
      join(app.getPath('userData'), `crash-${Date.now()}.log`),
      `${new Date().toISOString()} ${kind}\n${redactedDetail}\n`,
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
let shotCache: { image: string; width: number; height: number; dispId: number; ts: number } | null = null

async function captureScreenshot(): Promise<{ image: string; width: number; height: number; dispId: number }> {
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
  return { image: jpeg.toString('base64'), width: size.width, height: size.height, dispId: disp.id }
}

/** Thrown by getScreenshot() when Private View is on — lets callers show a specific message instead of a
 *  generic capture failure. */
class PrivateViewBlockedError extends Error {
  constructor() {
    super('Private View is on — screen capture is blocked. Turn it off to let AskToto see your screen.')
    this.name = 'PrivateViewBlockedError'
  }
}

async function getScreenshot(phase?: string): Promise<{ image: string; width: number; height: number; capturedAt: number }> {
  // Private View promises AskToto won't look at (or send) the screen while it's on — that has to mean
  // this app's own capture pipeline refuses to run, not just that OTHER apps can't screen-share our window
  // (that's the separate, still-active setContentProtection() call on the BrowserWindow itself).
  if (contentProtectionOn()) throw new PrivateViewBlockedError()
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (shotCache && Date.now() - shotCache.ts < CAPTURE_TTL_MS && shotCache.dispId === disp.id) {
    const { image, width, height, ts } = shotCache
    return { image, width, height, capturedAt: ts }
  }
  const shot = await captureScreenshot()
  const capturedAt = Date.now()
  shotCache = { ...shot, ts: capturedAt }
  auditLog('capture.screen', { width: shot.width, height: shot.height, bytes: shot.image.length, ...(phase ? { phase } : {}) })
  const { image, width, height } = shot
  return { image, width, height, capturedAt }
}

/** Fill the cache + warm the OS capture pipeline ahead of a real ask. Fire-and-forget; auth-gated. */
function prewarmCapture(): void {
  if (!requireAuth()) return
  getScreenshot('prewarm').catch(() => {
    /* best-effort warm */
  })
}

/** Clamp a single axis (pos/size) into a work-area span, without inverting when the window is bigger
 *  than the display. Math.min(Math.max(pos, areaPos), areaPos + areaSpan - size) assumes
 *  areaPos + areaSpan - size >= areaPos; when size > areaSpan that upper bound falls below areaPos and
 *  min/max invert, pushing the window partially off-screen instead of pinning it. Pin to areaPos instead. */
function clampAxis(pos: number, size: number, areaPos: number, areaSpan: number): number {
  if (size >= areaSpan) return areaPos
  return Math.min(Math.max(pos, areaPos), areaPos + areaSpan - size)
}

// How much of the window must stay visibly reachable on some display while it's being dragged — enough
// to grab it back, not the whole thing. Below this it's treated as flung off-screen and pulled back in.
const DRAG_VISIBLE_MARGIN = 40

/** Loosened clampAxis: pins `pos` so between `margin` and `size` px (whichever is smaller) of the
 *  window stays inside [areaPos, areaPos + areaSpan), instead of pinning the WHOLE window inside it.
 *  Only used as the moveBy() fallback below — letting most of the window hang off a display's edge is
 *  what lets a drag glide across a gap to a neighboring monitor instead of stopping dead at the first
 *  display's boundary. */
function clampAxisMargin(pos: number, size: number, areaPos: number, areaSpan: number, margin: number): number {
  const m = Math.min(margin, size, areaSpan)
  return Math.min(Math.max(pos, areaPos - size + m), areaPos + areaSpan - m)
}

/** True if, positioned at (x, y), at least DRAG_VISIBLE_MARGIN px of the window overlaps the work area
 *  of at least one CONNECTED display — checked against the union of every display (getAllDisplays()),
 *  not just whichever one the window started the drag on. */
function isReachable(x: number, y: number, width: number, height: number): boolean {
  const marginW = Math.min(DRAG_VISIBLE_MARGIN, width)
  const marginH = Math.min(DRAG_VISIBLE_MARGIN, height)
  return screen.getAllDisplays().some(({ workArea: wa }) => {
    const overlapW = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
    const overlapH = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
    return overlapW >= marginW && overlapH >= marginH
  })
}

function moveBy(dx: number, dy: number): void {
  if (!win) return
  const b = win.getBounds()
  const x = b.x + dx
  const y = b.y + dy
  // Free movement anywhere that keeps the window reachable on SOME display — covers dragging clean
  // across to a neighboring monitor (or over the gap between two of them), not just within the one the
  // window started on. Clamping against only the "current" display here (the old behavior) is what used
  // to stick a drag pinned to that display's edge, since the matched display never changed until the
  // window had already fully crossed onto it — which the clamp itself was preventing.
  if (isReachable(x, y, b.width, b.height)) {
    win.setBounds({ ...b, x, y })
    return
  }
  // Unreachable (flung past every display): pull back onto the display nearest the ATTEMPTED position,
  // not the window's old bounds, so a fast drag lands on whichever monitor it was actually headed toward.
  const { workArea } = screen.getDisplayMatching({ x, y, width: b.width, height: b.height })
  const cx = clampAxisMargin(x, b.width, workArea.x, workArea.width, DRAG_VISIBLE_MARGIN)
  const cy = clampAxisMargin(y, b.height, workArea.y, workArea.height, DRAG_VISIBLE_MARGIN)
  win.setBounds({ ...b, x: cx, y: cy })
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
    const x = clampAxis(b.x, b.width, wa.x, wa.width)
    const y = clampAxis(b.y, b.height, wa.y, wa.height)
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
  whatnext: () => sendHotkey('whatnext'),
  explain: () => sendHotkey('explain'),
  summarize: () => sendHotkey('summarize'),
  'spotlight-ref': () => sendHotkey('spotlight-ref'),
  'scroll-up': () => moveBy(0, -60),
  'scroll-down': () => moveBy(0, 60),
  'scroll-left': () => moveBy(-60, 0),
  'scroll-right': () => moveBy(60, 0)
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

let notifTimer: ReturnType<typeof setInterval> | null = null
let notifPrevPollMs = 0 // wall time of the previous notifier poll — used for edge-trigger logic
const notifiedKeys = new Set<string>() // keys of events already notified this session

// Cache today's agenda (~30s) so startMeetingNotifier can cross-reference upcoming events against real
// calendar data without hammering Graph on every 30s poll.
let calendarCache: { events: CalendarEvent[]; ts: number } | null = null
const CALENDAR_CACHE_TTL_MS = 30_000

/**
 * Native notification scheduler: fires a system notification ~1 minute before each calendar event.
 * Polls every 30 s using the existing calendarCache (no extra Graph call when cache is warm).
 * Gated on the meetingNotifications setting; silently no-ops when notifications aren't supported.
 */
function startMeetingNotifier(): void {
  if (notifTimer) return
  notifTimer = setInterval(async () => {
    try {
      if (!getSettings().meetingNotifications) return
      if (!Notification.isSupported()) return

      // Resolve today's events from the warm cache or a fresh Outlook fetch.
      let events: CalendarEvent[] = []
      if (calendarCache && Date.now() - calendarCache.ts <= CALENDAR_CACHE_TTL_MS) {
        events = calendarCache.events
      } else if (requireAuth()) {
        let tz = 'UTC'
        try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { /* keep UTC */ }
        const res = await calendarToday(tz)
        if (res.ok && res.events) {
          calendarCache = { events: res.events, ts: Date.now() }
          events = res.events
        }
      }

      const now = Date.now()
      // Snapshot and advance the previous-poll timestamp for the edge-trigger calculation below.
      const prevPollMs = notifPrevPollMs
      notifPrevPollMs = now
      for (const ev of events) {
        if (!ev.start) continue
        const startMs = Date.parse(ev.start)
        if (isNaN(startMs)) continue
        // Edge-trigger: fire on the first poll where the 60 s mark has been crossed, regardless of
        // poll-interval jitter. The old "60–90 s window" would silently miss a notification when a
        // poll slipped past the 30 s interval (e.g. T=91 s then T=59 s skips the window entirely).
        const msUntil = startMs - now
        if (msUntil < -30_000) continue // event started > 30 s ago — too late to notify
        if (msUntil > 60_000) continue  // event is still > 60 s away — not yet due
        // prevPollMs=0 means this is the first poll ever; treat prevMsUntil as ∞ so we fire immediately
        // if an event is already within 60 s.
        const prevMsUntil = prevPollMs > 0 ? startMs - prevPollMs : Number.POSITIVE_INFINITY
        if (prevMsUntil <= 60_000) continue // threshold was already crossed at the previous poll
        const key = `${ev.subject}@${ev.start}`
        if (notifiedKeys.has(key)) continue
        notifiedKeys.add(key)
        try {
          new Notification({
            title: 'Meeting starting soon',
            body: `${ev.subject} starts in 1 minute`
          }).show()
        } catch {
          /* notifications may be blocked by the OS */
        }
      }
    } catch (e) {
      // calendarToday / Outlook fetch failure is transient (network, token expiry). Log a warning
      // rather than letting the rejection escape as an unhandledRejection → bogus crash audit.
      mainLog.warn('[meeting-notifier] tick failed:', e instanceof Error ? e.message : String(e))
    }
  }, 30_000)
  if (typeof notifTimer.unref === 'function') notifTimer.unref()
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
    const user = getSettings().shortcuts ?? {}
    const winKeys = process.platform === 'win32'
    const fmtAccel = (a: string): string =>
      !a ? '' : winKeys
        ? a.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl').replace(/Command|Meta|Super/g, 'Win').replace(/Return/g, 'Enter')
        : a.replace(/CommandOrControl|CmdOrCtrl|Command|Meta/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/Control/g, 'Ctrl').replace(/Return/g, '↵').replace(/\+/g, '')
    const label = (base: string, action: HotkeyAction): string => {
      const k = fmtAccel(resolveShortcut(action, user))
      return k ? `${base}  (${k})` : base
    }
    const menu = Menu.buildFromTemplate([
      { label: label('Show / Hide', 'hide'), click: toggleVisible },
      { label: 'Settings…', click: () => {
        if (win && !win.isVisible()) win.show()
        sendHotkey('settings')
      } },
      { label: label('Listen / Stop listening', 'toggle-listen'), click: () => sendHotkey('toggle-listen') },
      { label: "Today's agenda", click: () => {
        if (win && !win.isVisible()) win.show()
        sendHotkey('agenda')
      } },
      { label: label('New', 'reset'), click: () => sendHotkey('reset') },
      { type: 'separator' },
      { label: 'Quit AskToto', click: () => app.quit() }
    ])
    tray.setToolTip('AskToto')
    tray.setContextMenu(menu)
  } catch {
    /* tray optional */
  }
}

// macOS App Nap (and equivalent OS-level suspension elsewhere) can throttle a minimized/occluded window's
// process the same way it throttles any backgrounded app — independent of Electron's own
// `backgroundThrottling` flag, which only covers Blink's internal timer/rAF throttling. If the renderer's
// transcription worker gets deprioritized mid-meeting, the audio queue backs up and oldest windows are
// silently dropped (see MAX_QUEUE in listen.ts), which reads as "the transcript stopped." Holding a
// power-save blocker for the duration of a meeting keeps the process at normal priority regardless of
// window visibility. Module-level id: only one meeting can be active at a time.
let recordingPowerSaveBlockerId: number | null = null
function setRecordingPowerSaveBlock(on: boolean): void {
  if (on) {
    if (recordingPowerSaveBlockerId === null || !powerSaveBlocker.isStarted(recordingPowerSaveBlockerId)) {
      recordingPowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } else if (recordingPowerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(recordingPowerSaveBlockerId)) powerSaveBlocker.stop(recordingPowerSaveBlockerId)
    recordingPowerSaveBlockerId = null
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
  // --- Settings & permissions ---
  ipcMain.handle(IPC.settingsGet, (e) => {
    assertMainWindow(e)
    return publicSettings()
  })
  ipcMain.handle(IPC.permissionsGet, (e) => {
    assertMainWindow(e)
    return getPlatformPermissions()
  })
  // Deep-link to the relevant macOS Privacy pane once a permission has been denied — getUserMedia never
  // re-prompts after a Deny, so without this a denied user has no in-app path back to granting it. The
  // x-apple.systempreferences scheme only exists on macOS; a no-op elsewhere.
  ipcMain.handle(IPC.permissionsOpenSettings, (e, kind: unknown) => {
    assertMainWindow(e)
    if (process.platform !== 'darwin') return
    const pane = kind === 'screenRecording' ? 'Privacy_ScreenCapture' : 'Privacy_Microphone'
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
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

  // --- Provider API keys ---
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

  // --- Dust integration ---
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
    setSettings({ dustWorkspaceId: s.workspaceId, dustBaseUrl: s.baseUrl || 'https://dust.tt', dustTokenMintedAt: Date.now() })
    return { ok: true, workspaceId: s.workspaceId, baseUrl: s.baseUrl }
  })

  // No CLI session yet → kick off the install + interactive login for the user (opens a Terminal window).
  ipcMain.handle(IPC.dustSetupCli, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return setupDustCli()
  })

  // --- CLI providers (Claude Code / Codex / Gemini) ---
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

  // --- BidStack MCP / CRM push ---
  // BidStack 360° CRM — MCP push (Settings → CLI Integration card + Review's "Push to CRM").
  // Test connection: connects + authenticates + lists tools, persists NOTHING (mirrors BidStack's own
  // "Test endpoint" button). Lets the user verify before committing an endpoint/key to disk.
  ipcMain.handle(IPC.mcpCrmTestConnection, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpCrmTestConnectionPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    return connectBidstack(parsed.data.endpointUrl, parsed.data.apiKey)
  })

  // Save connection: re-verifies (never trust a stale/unverified endpoint+key) then persists the
  // endpoint to settings, the key to the BidStack secrets file, and the discovered tools for the picker.
  ipcMain.handle(IPC.mcpCrmSaveConnection, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpCrmSaveConnectionPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const r = await connectBidstack(parsed.data.endpointUrl, parsed.data.apiKey)
    if (!r.ok) return r
    setBidstackApiKey(parsed.data.apiKey)
    setSettings({
      bidstackEndpointUrl: parsed.data.endpointUrl.trim(),
      bidstackConnected: true,
      bidstackTools: r.tools ?? []
    })
    auditLog('bidstack.connected', { tools: (r.tools ?? []).length })
    return r
  })

  ipcMain.handle(IPC.mcpCrmDisconnect, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    clearBidstackApiKey()
    setSettings({ bidstackConnected: false, bidstackTools: [] })
    auditLog('bidstack.disconnected', {})
    return { ok: true }
  })

  // Push: uses the already-saved endpoint + key. Never accepts an endpoint/key from the renderer here —
  // only a previously tested-and-saved connection can push, so a compromised renderer can't redirect the
  // push to an attacker-controlled MCP endpoint by passing arbitrary payload fields.
  ipcMain.handle(IPC.mcpCrmPush, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = McpCrmPushPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const s = getSettings()
    if (!s.bidstackConnected || !s.bidstackEndpointUrl || !hasBidstackApiKey()) {
      return { ok: false, error: 'Polo Pre-Sales is not connected. Set it up in Settings → Mantu Intelligence first.' }
    }
    const apiKey = getBidstackApiKey()
    const r = await pushToBidstack(s.bidstackEndpointUrl, apiKey, parsed.data.toolName, parsed.data.args)
    auditLog('bidstack.push', { tool: parsed.data.toolName, ok: r.ok })
    return r
  })

  // --- NotebookLM research (MCP, stdio; Settings → Mantu Intelligence) ---
  ipcMain.handle(IPC.notebookLmDetect, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return detectNotebookLmCli()
  })
  ipcMain.handle(IPC.notebookLmInstall, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const r = await installNotebookLmCli((line) => win?.webContents.send(IPC.notebookLmInstallProgress, { line }))
    auditLog('notebooklm.install', { ok: r.ok })
    return r
  })
  // One-click Google sign-in: open a Terminal running `nlm login`, which opens the user's browser and
  // stores the session in the CLI's own state. Mirrors loginCli's script-open pattern so nobody has to
  // type a command themselves — dummy-proof, same as every other connect flow.
  ipcMain.handle(IPC.notebookLmLogin, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const isWin = process.platform === 'win32'
    if (!isWin && process.platform !== 'darwin') {
      return { ok: false, error: 'Automatic sign-in is not available on this OS yet. Run `nlm login` in a terminal, then click Connect.' }
    }
    try {
      const scriptLines = isWin
        ? [
            '@echo off',
            'cls',
            'echo AskToto - NotebookLM sign-in',
            'echo ==========================',
            'echo.',
            'echo A browser window will open. Sign in with your Google account.',
            'echo ----------------------------------------',
            'call nlm login',
            'echo.',
            'echo Done. Go back to AskToto and click Connect.',
            'pause'
          ]
        : [
            '#!/bin/bash',
            'clear',
            'echo "AskToto — NotebookLM sign-in"',
            'echo "============================"',
            'echo',
            'echo "A browser window will open. Sign in with your Google account."',
            'echo "────────────────────────────────────────────────"',
            'nlm login',
            'echo; echo "✓ Done. Go back to AskToto and click \\"Connect\\"."',
            'echo "You can close this window."'
          ]
      const scriptPath = join(app.getPath('temp'), `asktoto-notebooklm-login-${randomBytes(8).toString('hex')}.${isWin ? 'cmd' : 'command'}`)
      writeFileSync(scriptPath, scriptLines.join('\n') + '\n', { mode: 0o755, flag: 'wx' })
      const errMsg = await shell.openPath(scriptPath)
      auditLog('notebooklm.login', { opened: !errMsg })
      return errMsg ? { ok: false, error: errMsg } : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.notebookLmConnect, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const r = await connectNotebookLm()
    if (r.ok) setSettings({ notebookLmConnected: true, notebookLmTools: r.tools ?? [] })
    auditLog('notebooklm.connected', { ok: r.ok, tools: (r.tools ?? []).length })
    return r
  })
  ipcMain.handle(IPC.notebookLmAsk, async (e, payload: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = NotebookLmAskPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    if (!getSettings().notebookLmConnected) {
      return { ok: false, error: 'NotebookLM is not connected. Set it up in Settings → Mantu Intelligence first.' }
    }
    const r = await askNotebookLm(parsed.data)
    auditLog('notebooklm.ask', { ok: r.ok, scoped: !!parsed.data.notebookId })
    return r
  })

  // --- Auth ---
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
  // --- Calendar ---
  ipcMain.handle(IPC.calendarToday, async (e, tz: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return calendarToday(typeof tz === 'string' ? tz : 'UTC')
  })

  // --- Recall (meeting history): read/delete ---
  // Recall read: load a saved meeting back for "Resume session" (decode + parse the markdown).
  ipcMain.handle(IPC.recallRead, async (e, file: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    return recallRead(String(file ?? ''))
  })

  // Recall delete: GDPR right-to-erasure for a saved meeting — removes the file + its index row.
  // Confirmed with a native, unmissable modal BEFORE deleting (sync — blocks until the user answers) so a
  // single click is unambiguous: no "did that register?" two-click pattern that's easy to misread as broken.
  ipcMain.handle(IPC.recallDelete, async (e, file: unknown, title: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const safeName = basename(String(file ?? ''))
    const label = typeof title === 'string' && title.trim() ? title.trim() : 'this meeting'
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete meeting',
      message: `Delete "${label}"?`,
      detail: 'This removes the saved transcript and notes from disk. This cannot be undone.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteMeeting(safeName)
    if (result.ok) auditLog('transcript.deleted', { file: safeName })
    return result
  })

  // 90-Second Debrief (innovation #6): the user's off-record gut-read, appended to the saved meeting.
  // Same file → inherits encryption/retention/deletion, and the brain re-ingest below folds the unsaid
  // observations into signals on the next extraction pass.
  ipcMain.handle(IPC.debriefSave, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = raw as { file?: unknown; text?: unknown }
    const safeName = basename(String(p?.file ?? ''))
    const text = String(p?.text ?? '').slice(0, 8000)
    if (!safeName.endsWith('.md') || !text.trim()) return { ok: false, error: 'Nothing to save.' }
    const s = getSettings()
    const result = await appendDebrief(s, safeName, text)
    if (result.ok) {
      auditLog('transcript.debrief', { file: safeName })
      enqueueIngest(join(resolveMeetingsFolder(s), safeName)) // fold the unsaid layer into the brain
    }
    return result
  })

  // Commitment settlement — the human closes the loop the LLM never may (kept/broken are only ever
  // set here or by future CRM sync). Main-window only: it's a brain WRITE, unlike the read channels.
  ipcMain.handle(IPC.brainCommitmentSettle, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const p = raw as { deal?: unknown; text?: unknown; status?: unknown }
    const status = String(p?.status ?? '')
    if (!['open', 'kept', 'broken'].includes(status)) return { ok: false, error: 'Bad status.' }
    const deal = String(p?.deal ?? '')
    const text = String(p?.text ?? '')
    if (!deal || !text) return { ok: false, error: 'Missing commitment.' }
    const r = await settleCommitment(getSettings(), brainSlugify(deal), text, status as 'open' | 'kept' | 'broken')
    if (r.ok) auditLog('brain.commitment.settled', { status })
    return r
  })

  // Delete EVERYTHING: every saved meeting + the index + the knowledge graph. For a GDPR/CCPA erasure
  // request or a full account wipe — not the same as recallDelete's one-at-a-time flow. Extra-emphatic
  // confirm (shows the real count, defaults to Cancel) since this is the single most destructive action
  // in the app and cannot be undone.
  ipcMain.handle(IPC.recallDeleteAll, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const meetings = await listMeetings()
    if (meetings.length === 0) return { ok: true, deleted: 0 }
    const dialogOpts = {
      type: 'warning' as const,
      title: 'Delete all AskToto data',
      message: `Delete all ${meetings.length} saved meeting${meetings.length === 1 ? '' : 's'}?`,
      detail:
        'This permanently removes every saved transcript, note, and the knowledge graph from this device. This cannot be undone.',
      buttons: ['Delete everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = win ? await dialog.showMessageBox(win, dialogOpts) : await dialog.showMessageBox(dialogOpts)
    if (response !== 0) return { ok: false, error: 'cancelled' }
    const result = await deleteAllMeetings()
    purgeGraphArtifacts() // legacy userData/graph artifacts
    const brainPurge = purgeBrain(getSettings()) // the `.brain/` knowledge store — entities, quotes, graph
    auditLog('transcript.deleted', {
      bulk: true,
      deleted: result.deleted,
      failed: result.failed.length,
      brainPurged: brainPurge.ok
    })
    return result
  })

  // --- Parakeet ASR engine ---
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

  // --- Screen capture ---
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

  // --- Ask / LLM streaming ---
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
    // Local-first redaction (brief section I): strip high-confidence secrets from the captured transcript
    // before it leaves the device for a cloud model. Only the auto-captured transcript — never the user's
    // own typed prompt, and never the locally-saved meeting file (which keeps the verbatim original).
    if (s.redactSensitive && req.transcript) req.transcript = redactSecrets(req.transcript)
    // Receipt Mode: ground a typed answer in the user's own past meetings. Match the brain against the
    // question (which already carries the live transcript tail via the renderer's withContext) and inject
    // the relevant, meeting-cited slice per-turn. Answer mode only — never the latency-critical spoken
    // suggest line or the screen-only vision turn. Best-effort: a brain read must never block an answer.
    if (req.mode === 'answer') {
      try {
        const hit = buildBrainContext(s, `${req.prompt}\n${req.transcript ?? ''}`)
        req.brainContext = hit.block || undefined
      } catch (err) {
        console.warn('[brain] context assembly failed', err)
      }
    }
    const allowed = getAllowedProviders() // org allowlist (null = unrestricted)

    // Find the next eligible keyed provider not yet tried — for failover when the primary can't answer.
    const failover = (tried: ProviderId[]): boolean => {
      const tier = routeTier(req, s.thinkingMode)
      // Candidate order honors the CLI-vs-API priority: when 'cli', CLI-kind providers sort first so a
      // failover reaches for another local CLI before a metered API. V8's Array.sort is stable, so equal-
      // rank providers keep their PROVIDERS declaration order; 'api' (default) leaves the order unchanged.
      const order = (Object.keys(PROVIDERS) as ProviderId[]).slice().sort((a, b) =>
        s.providerPriority === 'cli'
          ? (PROVIDERS[a].kind === 'cli' ? 0 : 1) - (PROVIDERS[b].kind === 'cli' ? 0 : 1)
          : 0
      )
      const next = order.find(
        (p) =>
          !tried.includes(p) &&
          (!allowed || allowed.includes(p)) &&
          (PROVIDERS[p].kind === 'cli' ? !!s.cliConnected[p] : getApiKey(p).length > 0) &&
          (req.mode !== 'vision' || PROVIDERS[p].vision) &&
          // CLI providers (e.g. codex-cli) may have no configured model at all — attempt() below
          // already exempts kind==='cli' from the "no model" ineligibility check (the CLI just uses
          // its own default), so a failover candidate must be exempted the same way or a fully
          // default-configured CLI provider can never be selected.
          (PROVIDERS[p].kind === 'cli' ||
            !!resolveModelTier(p, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep))
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
      let model =
        req.agentOverride && provider === 'dust'
          ? req.agentOverride
          : resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep)
      // Guardrail (per Tony): CLI is Sonnet-only, Anthropic base/think are pinned to Haiku/Sonnet — both
      // regardless of what routeTier or a user's providerModels override picked. Opus stays reachable only
      // through the Graph pipeline (brain/ingest.ts, graphify.ts), which never calls this function.
      model = applyInteractiveGuardrail(provider, tier, model)
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
              ? 'Add your Dust workspace ID in Settings → AI → Dust setup.'
              : ''
      if (ineligible) {
        // Vision turn, but the active provider can't read images (e.g. Dust agents). Transparently fail
        // over to a configured vision-capable provider (Claude/GPT) so a user who captured their screen
        // still gets an answer — `failover` only picks a provider that has both a key and a model. Surface
        // the error only when NO vision-capable provider is set up.
        const visionGap = req.mode === 'vision' && !def.vision
        if (visionGap && failover(attempted.concat(provider))) return
        if (attempted.length === 0) win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
        else if (!failover(attempted.concat(provider))) win?.webContents.send(IPC.streamError, { id: req.id, message: ineligible })
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
                setSettings({ dustWorkspaceId: fresh.workspaceId, dustBaseUrl: baseUrl, dustTokenMintedAt: Date.now() })
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
            // Latency + token telemetry (metadata only) — feeds the p50/p95 latency + cost evals (H/D/F).
            auditLog('provider.request', {
              provider,
              model,
              mode: req.mode,
              tier,
              phase: 'done',
              ttftMs,
              totalMs: Date.now() - startedAt,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens
            })
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

    // Honor the CLI-vs-API priority for the FIRST provider tried: 'cli' prefers a connected CLI integration
    // (Claude, then Codex) so the user's local subscription is used before any metered API. Otherwise — and
    // whenever no CLI is connected — the user's explicitly-chosen `provider` stays primary (unchanged).
    // req.providerOverride wins over all of that: it means "this specific request must go to provider X"
    // (e.g. cascading a recap/follow-up/Spotlight-Ref request into Dust) regardless of what's globally active.
    const cliPrimary =
      s.providerPriority === 'cli'
        ? (['claude-cli', 'codex-cli'] as ProviderId[]).find((p) => s.cliConnected[p])
        : undefined
    attempt(req.providerOverride ?? cliPrimary ?? s.provider, [])
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

  // --- Audio capture arming ---
  ipcMain.handle(IPC.armAudio, (e, on: boolean) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    audioArmed = !!on
  })

  // --- Transcript, notes & feedback persistence ---
  ipcMain.handle(IPC.saveTranscript, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const m = SaveMeetingSchema.parse(raw)
    const r = { path: await saveMeeting(getSettings(), m) }
    clearDraftTranscript(getSettings(), m.startedAt) // the real save landed — this autosave is now stale
    auditLog('transcript.saved', {
      mode: m.mode,
      lines: m.lines.length,
      durMin: Math.round((Date.now() - m.startedAt) / 60_000),
      encrypted: !!getSettings().encryptTranscripts
    })
    scheduleRebuild() // refresh the knowledge graph with the new note (debounced; no-op if disabled)
    enqueueIngest(r.path) // Mantu Intelligence brain — background extraction; never blocks the save
    return r
  })

  // --- Mantu Intelligence brain (see src/main/brain/) ---
  ipcMain.handle(IPC.brainOpenDashboard, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return openIntelligenceWindow()
  })
  ipcMain.handle(IPC.brainStatus, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) return null
    const s = getSettings()
    const idx = readBrainIndex(s)
    const graph = readBrainGraph(s)
    return {
      meetings: Object.values(idx.ingested).filter((v) => v.ok).length,
      people: listBrainEntities(s, 'person').length,
      accounts: listBrainEntities(s, 'account').length,
      deals: listBrainEntities(s, 'deal').length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      warnings: idx.warnings.length,
      backfill: brainBackfillProgress()
    }
  })
  ipcMain.handle(IPC.brainBackfill, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const r = startBackfill()
    auditLog('brain.backfill.start', { queued: r.queued })
    return r
  })
  // Full rebuild: wipe the DERIVED store (entities/graph/extractions — never the source transcripts)
  // and re-extract everything with the current schema/prompt. This is the upgrade path for legacy
  // extractions (e.g. untagged feedback that rendered as a flat confidence wall in the dashboard).
  ipcMain.handle(IPC.brainRebuildAll, (e) => {
    // Privileged write (purges the derived brain store) — main-window only, like brainCommitmentSettle,
    // never the Mantu Intelligence window's assertBrainReader (that's for the three read-only channels).
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    purgeBrain(getSettings())
    const r = startBackfill()
    auditLog('brain.backfill.start', { queued: r.queued, rebuild: true })
    return r
  })
  // Full assembled dataset for the Mantu Intelligence dashboard (decrypted in main when needed).
  ipcMain.handle(IPC.brainRead, (e) => {
    assertBrainReader(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const s = getSettings()
    return {
      index: readBrainIndex(s),
      graph: readBrainGraph(s),
      people: listBrainEntities(s, 'person').map((slug) => readBrainPerson(s, slug)).filter(Boolean),
      accounts: listBrainEntities(s, 'account').map((slug) => readBrainAccount(s, slug)).filter(Boolean),
      deals: listBrainEntities(s, 'deal').map((slug) => readBrainDeal(s, slug)).filter(Boolean),
      meetings: listBrainMeetingExtractions(s).map((slug) => readBrainMeetingExtraction(s, slug)).filter(Boolean)
    }
  })
  // Deal outcome — the human closes the loop the LLM never may (see DealEntitySchema.outcome). Main-window
  // only: it's a brain WRITE, like brainCommitmentSettle. Same slug convention too: the renderer sends the
  // deal's display name in `dealSlug`, slugified here before it reaches the store.
  ipcMain.handle(IPC.brainSetDealOutcome, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const parsed = SetDealOutcomePayloadSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message || 'Invalid input.' }
    const updated = await setDealOutcome(getSettings(), brainSlugify(parsed.data.dealSlug), parsed.data.outcome)
    if (!updated) return { ok: false, error: 'Deal not found.' }
    auditLog('brain.deal.outcome', { outcome: parsed.data.outcome })
    return { ok: true }
  })

  // Periodic best-effort snapshot of an IN-PROGRESS meeting (renderer calls this every ~60s while
  // Listen is active — see App.tsx). Never throws into the caller; a failed autosave must not interrupt
  // the meeting. See saveDraftTranscript's own doc comment for why this exists (crash/force-quit recovery).
  ipcMain.handle(IPC.saveDraftTranscript, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    const parsed = SaveMeetingSchema.safeParse(raw)
    if (!parsed.success) return
    await saveDraftTranscript(getSettings(), parsed.data)
  })

  ipcMain.handle(IPC.saveNote, async (e, raw) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const n = SaveNoteSchema.parse(raw)
    const r = { path: await saveNote(getSettings(), n) }
    auditLog('note.saved', { mode: n.mode })
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

  // --- Metrics, export & PDF ---
  // On-device eval metrics from the local audit log (latency p50/p95, acceptance, failures). Read-only,
  // metadata-only — nothing leaves the device. Surfaced in Settings → About → Diagnostics.
  ipcMain.handle(IPC.metricsRead, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return aggregateMetrics([])
    return readEvalMetrics()
  })

  // Parse a recap's markdown into a structured object (decisions + action-items-with-owners) the renderer
  // can copy as JSON for Jira/Asana/Notion. Pure transform of text the renderer already holds — no disk I/O.
  ipcMain.handle(IPC.exportRecapJson, (e, markdown: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return parseRecapMarkdown(typeof markdown === 'string' ? markdown : '')
  })

  // Local, Dust-independent PDF export of a recap — works with zero external prerequisites (no Dust
  // tool config, no Graph scope). Renders a small self-contained HTML doc in a hidden throwaway window
  // and prints it via Electron's own printToPDF; no PDF npm dependency needed for this one job.
  ipcMain.handle(IPC.recapPdf, async (e, input: { markdown?: string; title?: string }) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const md = typeof input?.markdown === 'string' ? input.markdown : ''
    if (!md.trim()) throw new Error('No recap to export.')
    const safeName = (input?.title || 'Meeting recap').replace(/[\\/:*?"<>|]/g, '-')
    // AskToto is an LSUIElement (accessory) app — no Dock icon, not a normal foreground app. A dialog
    // opened with no parent BrowserWindow has nothing to attach its sheet to and no window to activate,
    // so it can silently fail to ever surface on screen: the promise just hangs forever with no error and
    // no visible dialog. Anchoring it to `win` (already on screen) is what every other dialog in this
    // file does — this one was the one exception.
    const dialogOwner = win ?? undefined
    const r = dialogOwner
      ? await dialog.showSaveDialog(dialogOwner, { defaultPath: `${safeName}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      : await dialog.showSaveDialog({ defaultPath: `${safeName}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePath) return { ok: false as const }
    const html = recapMarkdownToHtml(md, input?.title)
    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
    })
    try {
      await pdfWin.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))
      const buffer = await pdfWin.webContents.printToPDF({ printBackground: true })
      writeFileSync(r.filePath, buffer)
    } finally {
      pdfWin.destroy()
    }
    return { ok: true as const, path: r.filePath }
  })

  // --- Graphify knowledge graph ---
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

  // --- Filesystem pickers ---
  ipcMain.handle(IPC.pickFolder, async (e) => {
    assertMainWindow(e)
    // Same LSUIElement-accessory-app reasoning as recapPdf above: anchor to `win` so the dialog actually
    // surfaces instead of silently hanging with nothing to attach to.
    const openDialogOpts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose where AskToto saves meeting transcripts'
    }
    const r = win ? await dialog.showOpenDialog(win, openDialogOpts) : await dialog.showOpenDialog(openDialogOpts)
    if (!r.canceled && r.filePaths[0]) setSettings({ meetingsFolder: r.filePaths[0] })
    return publicSettings()
  })

  ipcMain.handle(IPC.openPath, (e) => {
    assertMainWindow(e)
    return requireAuth() ? shell.openPath(resolveMeetingsFolder(getSettings())) : ''
  })
  // --- Recall (meeting history): list/search/open ---
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
    const safeName = basename(String(file ?? '')) // basename blocks traversal
    // Only ever open AskToto's own .md meeting transcripts. The meetings folder is user-chosen
    // (could be Desktop/Downloads), and shell.openPath launches the OS handler for whatever it finds,
    // which would execute a .command/.app/.exe. Mirror deleteMeeting()/debriefSave()'s .md guard.
    if (!safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') return ''
    const path = join(folder, safeName)
    const encrypted = isEncryptedFile(path)
    auditLog('recall.open', { encrypted })
    // Encrypted transcripts are unreadable in an editor — open a decrypted temp copy instead.
    if (encrypted) return shell.openPath(decryptToTemp(path))
    return shell.openPath(path)
  })

  // --- Listening state (tray icon + Dust conversation reset + power-save block) ---
  ipcMain.handle(IPC.listeningState, (e, on: unknown) => {
    assertMainWindow(e)
    setTrayRecording(!!on)
    setRecordingPowerSaveBlock(!!on)
    // A new meeting starting is the one clean boundary for Dust conversation continuity — everything
    // from here until the NEXT meeting starts shares one conversation (see resetDustConversation).
    if (on) resetDustConversation()
  })

  // --- Window management ---
  ipcMain.handle(IPC.windowResize, (e, payload: { height: number; width?: number }) => {
    assertMainWindow(e)
    // A view can opt into reporting its own visible width (the collapsed control mini-pill, and a toast
    // that widens the pill to fit itself while minimized) instead of relying on the fixed
    // BAR_WIDTH/PILL_WIDTH guess. Without this the pill's real content (~170px) sat centered inside the
    // fixed 220px window, leaving an invisible ~25px-per-side strip that still blocked clicks to whatever
    // was behind it. Floor/ceiling guard against a measurement glitch reporting something absurd — the
    // ceiling is BAR_WIDTH itself since nothing legitimately needs to be wider than the full bar (a lower
    // ceiling here once clipped a wider toast's own content that had genuinely asked for more room).
    if (typeof payload?.width === 'number' && Number.isFinite(payload.width)) {
      // +10 (not the height report's +2) gives the pill's own box-shadow/glow room to render without
      // being hard-clipped at the window edge — see the .aw-pill / .aw-mark-glow comments in styles.css.
      currentWidth = Math.max(120, Math.min(Math.ceil(payload.width) + 10, BAR_WIDTH))
    }
    // Same finite-number guard as width: a NaN/Infinity height from a renderer layout glitch would
    // otherwise reach resizeTo's Math.round/min/max unclamped, poisoning them to NaN and making
    // win.setBounds throw or leave the window in a broken size. Fall back to BAR_HEIGHT instead.
    const height =
      typeof payload?.height === 'number' && Number.isFinite(payload.height) ? payload.height : BAR_HEIGHT
    resizeTo(height)
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
  // --- Auto-update ---
  ipcMain.handle(IPC.updateInstall, (e) => {
    assertMainWindow(e)
    updaterPkg.autoUpdater.quitAndInstall()
  })
  // --- Mail draft ---
  // mailto: fallback for the follow-up draft (Phase 1) — opens the user's own default mail client with
  // a prefilled draft; sending stays entirely manual. No attachments possible via mailto (real Outlook
  // drafts with attachments are a later phase, gated on Microsoft Graph scope consent). Some mail
  // clients/OSes cap mailto: URL length, so long bodies are truncated with the full text left on the
  // clipboard instead of silently cutting content the user can't recover.
  ipcMain.handle(IPC.openMailDraft, (e, input: { subject?: string; body?: string }) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    const subject = typeof input?.subject === 'string' ? input.subject : ''
    const rawBody = typeof input?.body === 'string' ? input.body : ''
    const MAX_BODY = 1500
    const truncated = rawBody.length > MAX_BODY
    const body = truncated ? rawBody.slice(0, MAX_BODY) + '\n\n[Truncated — full text copied to your clipboard.]' : rawBody
    if (truncated) clipboard.writeText(rawBody)
    void shell.openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
    return { truncated }
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
  // Unpackaged (dev/QA) runs show Electron's default icon in the Dock — brand them with the Mantu M so
  // a dev window is never mistaken for "the Electron thing". Packaged builds get build/icon.png baked
  // in by electron-builder (mac .icns / win .ico) and don't need this.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock?.setIcon(join(__dirname, '../../build/icon.png')) } catch { /* cosmetic only */ }
  }
  // Prune stale crash logs to the most recent 5 (best-effort; filenames sort lexicographically by ts).
  try {
    const ud = app.getPath('userData')
    const crashLogs = readdirSync(ud)
      .filter((f) => /^crash-\d+\.log$/.test(f))
      .sort()
    for (const f of crashLogs.slice(0, Math.max(0, crashLogs.length - 5))) {
      try { unlinkSync(join(ud, f)) } catch { /* ignore */ }
    }
  } catch { /* best-effort — never block startup */ }
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
  sweepStaleTempFiles() // remove any decrypted-transcript temp copies orphaned by a previous hard-kill
  // Promote any orphaned crash-recovery drafts into real meetings BEFORE the retention sweep, so a
  // recovered meeting is visible in History and immediately subject to the same retention policy.
  recoverOrphanDrafts(getSettings()).then((r) => {
    if (r.recovered > 0) auditLog('transcript.recovered', { recovered: r.recovered })
  }).catch(() => { /* best-effort — never block startup */ })
  // Auto-delete meetings past the configured retention window (off by default — see transcriptRetentionDays).
  // Runs at launch AND every 6 hours after: this overlay realistically stays up for weeks, so a launch-only
  // sweep silently stopped enforcing retention the day after boot (storage-limitation promise broken).
  const runRetentionSweep = (): void => {
    sweepExpiredMeetings(getSettings().transcriptRetentionDays).then((r) => {
      if (r.deleted > 0) auditLog('transcript.deleted', { bulk: true, expired: true, deleted: r.deleted })
    }).catch(() => { /* best-effort — never block startup or the interval */ })
  }
  runRetentionSweep()
  setInterval(runRetentionSweep, 6 * 60 * 60 * 1000)
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
      let sources = await desktopCapturer.getSources({ types: ['screen'] })
      if (!sources.length) {
        // getSources can return empty transiently right after a fresh Screen-Recording grant.
        // Retry once (matching captureScreenshot) before giving up.
        await new Promise((r) => setTimeout(r, 250))
        sources = await desktopCapturer.getSources({ types: ['screen'] })
      }
      const screenSrc = sources[0]
      callback(screenSrc ? { video: screenSrc, audio: 'loopback' } : {})
    },
    { useSystemPicker: false }
  )

  // Deny every web permission by default; only the main window may use audio media (the Listen mic) or
  // write to the system clipboard (Copy Summary / Export JSON / copy-code buttons all need this — it's a
  // one-way, user-initiated write of text the app itself built, not a snooping vector). clipboard-READ
  // (reading arbitrary external clipboard content) stays denied along with geolocation, notifications,
  // camera, USB, MIDI, etc.
  const allowPermission = (wc: Electron.WebContents | null, permission: string): boolean =>
    (permission === 'media' || permission === 'clipboard-sanitized-write') && !!win && wc === win.webContents
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
    ipcMain.handle(IPC.asrBundled, (e) => {
      assertMainWindow(e)
      return ASR_BUNDLED
    })

    protocol.handle('asr-model', async (req) => {
      try {
        const url = new URL(req.url)
        // Restrict to the two roots this protocol is meant to serve. Without this, app.asar and other
        // resourcesPath siblings resolve inside RES_BASE too and would be served as raw source bytes.
        if (url.host !== 'models' && url.host !== 'ort') return new Response(null, { status: 403 })
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
  // Eagerly refresh the Dust CLI session at launch (Tony: "always stay connected") rather than waiting
  // for a request to 401 first. Reading the Dust CLI's keychain item from AskToto — a different binary
  // than the `dust`/keytar process that created it — does trigger a one-time macOS "allow access" prompt;
  // on a real (signed or at least stable) install macOS remembers "Always Allow" for that app identity, so
  // this costs one prompt ever, not one per restart. Only bothers if Dust was connected before; best-effort
  // and fully silent on failure — the existing lazy on-401 refresh (refreshDustAuth above) still covers it
  // if this doesn't run or doesn't succeed.
  // Skip the eager refresh while the imported token is still fresh (<45 min of its ~1h life): the
  // keychain read behind refreshDustCliSession can cost a macOS keychain password prompt on builds
  // whose code identity churns (unsigned dev builds), and a fresh token has nothing to gain from it.
  // The lazy on-401 refresh (refreshDustAuth above) still self-heals expiry invisibly either way.
  const DUST_TOKEN_FRESH_MS = 45 * 60 * 1000
  if (
    process.platform === 'darwin' &&
    hasApiKey('dust') &&
    Date.now() - getSettings().dustTokenMintedAt > DUST_TOKEN_FRESH_MS
  ) {
    void refreshDustCliSession()
      .then((fresh) => {
        if (!fresh.ok || !fresh.token || !fresh.workspaceId) return
        setApiKey('dust', fresh.token)
        setSettings({
          dustWorkspaceId: fresh.workspaceId,
          dustBaseUrl: fresh.baseUrl || 'https://dust.tt',
          dustTokenMintedAt: Date.now()
        })
        auditLog('dust.token.refreshed', { at: 'startup' })
      })
      .catch(() => {
        /* best-effort — the lazy on-401 refresh in dust.ts still covers this */
      })
  }

  // createTray/registerShortcuts stay ahead of createWindow (see the boot-order comment above) — but
  // registerIpc has no such dependency: every ipcMain.handle closure inside it reads `win`/`tray` lazily
  // at INVOCATION time (assertMainWindow etc.), never at registration time, and the renderer can't issue
  // its first IPC call before its own <script> has executed anyway. Moving it after createWindow lets the
  // OS start loading/compositing the renderer a little earlier instead of waiting behind ~60 synchronous
  // ipcMain.handle registrations first.
  runStep('createTray', createTray)
  runStep('registerShortcuts', registerShortcuts)
  runStep('createWindow', createWindow)
  // Synchronous OneDrive filesystem work (mkdir + two writeFileSync calls on first run) — nothing
  // before the window depends on the folder existing yet (saveMeeting/saveNote create it themselves on
  // first use), so it no longer sits ahead of createWindow on the boot path.
  runStep('ensureMeetingsFolder', () => ensureMeetingsFolder(getSettings()))
  runStep('registerIpc', registerIpc)
  runStep('registerScreenListeners', registerScreenListeners)
  runStep('startMeetingNotifier', startMeetingNotifier)
  runStep('initAutoUpdate', () => initAutoUpdate(win))
  // Resume an interrupted brain backfill (flag persists in .brain/index.json until the queue drains).
  // Delayed so the boot path and first paint never compete with background LLM extractions.
  setTimeout(() => resumeBackfillIfPending(), 15_000)

  // First-run bootstrap: silently install the knowledge-graph engine (and preflight npm) in the
  // background so that feature "just works" without ever asking the user to run a terminal command.
  // Fire-and-forget, never rejects, self-limits to a few launches. Delayed so it never competes with
  // boot or first paint. mainLog (electron-log) satisfies the BootstrapLogger info/warn/error shape.
  setTimeout(() => {
    void runFirstRunBootstrap({ userDataDir: app.getPath('userData'), log: mainLog })
  }, 20_000)

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
  if (notifTimer) clearInterval(notifTimer)
})
