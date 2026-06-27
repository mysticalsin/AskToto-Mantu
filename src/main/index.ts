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
  nativeImage
} from 'electron'
import { join, basename } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import {
  IPC,
  AskStartSchema,
  SetApiKeyPayloadSchema,
  ClearApiKeyPayloadSchema,
  TestApiKeyPayloadSchema,
  DEFAULT_SHORTCUTS,
  type HotkeyAction,
  type PublicSettings
} from '@shared/ipc'
import {
  getSettings,
  setSettings,
  getLockedKeys,
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
import { authStatus, signIn as authSignIn, signOut as authSignOut, requireAuth } from './auth'
import {
  saveMeeting,
  saveNote,
  resolveMeetingsFolder,
  ensureMeetingsFolder,
  isEncryptedFile,
  decryptToTemp
} from './transcripts'
import { detectMeeting } from './meeting-detect'
import { getPlatformPermissions } from './platform-perms'
import { listMeetings, searchMeetings } from './recall'
import { initAutoUpdate } from './updater'
import { runSelfTest } from './selftest'
import { importDustCliSession } from './dustcli'
import { graphifyStatus, buildGraph, relatedNotes, graphHtml, scheduleRebuild } from './graphify'
import { SaveMeetingSchema, SaveNoteSchema } from '@shared/ipc'
import { PROVIDERS, resolveModelTier, type ProviderId } from '@shared/providers'
import { routeTier } from '@shared/routing'

const BAR_WIDTH = 700
const BAR_HEIGHT = 64
// Cluely-style settings window: a wider, fixed two-pane surface (sidebar + content).
const SETTINGS_WIDTH = 920
const SETTINGS_HEIGHT = 640

/** Content protection hides the window from screen capture. Disable via env for dev/screenshots. */
function contentProtectionOn(): boolean {
  if (process.env.ASKTOTO_DISABLE_CP) return false
  return getSettings().contentProtection
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let audioArmed = false // loopback capture only granted during an explicit user-initiated Listen
let settingsMode = false // when true the window is the fixed Cluely settings surface, not the bar
let lastBarHeight = BAR_HEIGHT // remember the bar's content height to restore on settings exit
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
  return {
    ...s,
    hasApiKey: hasApiKey(s.provider),
    hasKeys: hasKeysMap(),
    hasEncryption: encryptionAvailable(),
    resolvedMeetingsFolder: resolveMeetingsFolder(s),
    managedKeys: getLockedKeys(),
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
    if (process.env.ASKTOTO_SHOT) params.set('shotbg', 'dark') // make the overlay visible in the capture
    const qs = params.toString()
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (qs ? `?${qs}` : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function resizeTo(height: number): void {
  if (!win) return
  // In settings mode the window is a fixed-size two-pane surface; ignore content-driven height.
  if (settingsMode) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const h = Math.max(BAR_HEIGHT, Math.min(Math.round(height), workArea.height - 48))
  lastBarHeight = h
  const b = win.getBounds()
  // Keep the panel fully on-screen; if it would grow below the work area, slide it up.
  const maxY = workArea.y + workArea.height - h - 8
  const y = Math.min(b.y, maxY)
  win.setBounds({ x: b.x, y, width: BAR_WIDTH, height: h }, false)
}

/**
 * Switch the overlay between the compact 'bar' and the wide, fixed 'settings' surface.
 * Settings keeps the same top edge (so it grows downward from the bar) and centers horizontally,
 * clamped to the work area. Exiting restores the bar's width and last content height.
 */
function setWindowMode(mode: 'bar' | 'settings'): void {
  if (!win) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const b = win.getBounds()
  if (mode === 'settings') {
    settingsMode = true
    const w = Math.min(SETTINGS_WIDTH, workArea.width - 32)
    const h = Math.min(SETTINGS_HEIGHT, workArea.height - 48)
    let x = Math.round(b.x + (b.width - w) / 2) // expand around the bar's center
    x = Math.max(workArea.x + 16, Math.min(x, workArea.x + workArea.width - w - 16))
    const y = Math.max(workArea.y + 16, Math.min(b.y, workArea.y + workArea.height - h - 16))
    win.setBounds({ x, y, width: w, height: h }, false)
  } else {
    settingsMode = false
    let x = Math.round(b.x + (b.width - BAR_WIDTH) / 2)
    x = Math.max(workArea.x + 16, Math.min(x, workArea.x + workArea.width - BAR_WIDTH - 16))
    win.setBounds({ x, y: b.y, width: BAR_WIDTH, height: lastBarHeight }, false)
  }
}

function sendHotkey(action: HotkeyAction): void {
  if (!win) return
  if (!win.isVisible()) win.show()
  win.webContents.send(IPC.hotkey, action)
}

function moveBy(dx: number, dy: number): void {
  if (!win) return
  const b = win.getBounds()
  win.setBounds({ ...b, x: b.x + dx, y: b.y + dy })
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
  'scroll-down': () => moveBy(0, 60),
  // legacy move aliases kept for any custom scroll-left/right mappings
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
      if (!ok) console.warn(`[shortcuts] failed to register ${action}: ${accel}`)
    } catch (e) {
      console.warn(`[shortcuts] invalid accelerator for ${action}: ${accel}`, e)
    }
  }
  // ⌘Q is intentionally global because the dock is hidden and the overlay has no normal quit path.
  globalShortcut.register('CommandOrControl+Q', () => app.quit())
}

let meetingTimer: ReturnType<typeof setInterval> | null = null
let meetingActive = false
let meetingDetecting = false
function startMeetingPoller(): void {
  if (meetingTimer) return
  meetingTimer = setInterval(async () => {
    if (meetingDetecting) return // skip if the previous detect is still running (no overlap)
    if (!getSettings().onboardingDone || !getSettings().autoStartOnMeeting) {
      meetingActive = false
      return
    }
    meetingDetecting = true
    try {
      const hit = await detectMeeting(getSettings().customMeetingApps)
      if (hit && !meetingActive) {
        meetingActive = true
        if (win && !win.isVisible()) win.show() // surface the prompt/consent banner; don't fire on a hidden window
        win?.webContents.send(IPC.meetingDetected, { app: hit.split('|')[0], active: true })
      } else if (!hit && meetingActive) {
        meetingActive = false
        win?.webContents.send(IPC.meetingDetected, { active: false }) // meeting ended → renderer wraps up
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
    const next = setSettings(patch ?? {})
    win?.setContentProtection(contentProtectionOn())
    try {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    } catch {
      /* not supported on this platform */
    }
    // Shortcuts may have changed — re-register from the new settings.
    registerShortcuts()
    return publicSettings()
  })

  ipcMain.handle(IPC.setApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = SetApiKeyPayloadSchema.parse(payload)
    setApiKey(parsed.provider, parsed.key)
    return { hasKeys: hasKeysMap() }
  })

  ipcMain.handle(IPC.clearApiKey, (e, payload: unknown) => {
    assertMainWindow(e)
    const parsed = ClearApiKeyPayloadSchema.parse(payload)
    clearApiKey(parsed.provider)
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
  ipcMain.handle(IPC.dustImportCli, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const s = await importDustCliSession()
    if (!s.ok || !s.token || !s.workspaceId) return { ok: false, error: s.error }
    setApiKey('dust', s.token)
    setSettings({ dustWorkspaceId: s.workspaceId, dustBaseUrl: s.baseUrl || 'https://dust.tt' })
    return { ok: true, workspaceId: s.workspaceId, baseUrl: s.baseUrl }
  })

  ipcMain.handle(IPC.authStatus, (e) => {
    assertMainWindow(e)
    return authStatus()
  })
  ipcMain.handle(IPC.authSignIn, (e) => {
    assertMainWindow(e)
    return authSignIn()
  })
  ipcMain.handle(IPC.authSignOut, (e) => {
    assertMainWindow(e)
    return authSignOut()
  })

  ipcMain.handle(IPC.captureScreen, async (event) => {
    assertMainWindow(event)
    if (!requireAuth()) throw new Error('Not signed in.')
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const sf = disp.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(disp.size.width * sf),
        height: Math.round(disp.size.height * sf)
      }
    })
    const src =
      sources.find((s) => String(s.display_id) === String(disp.id)) ?? sources[0]
    if (!src) throw new Error('No screen source available (grant Screen Recording permission)')
    let img = src.thumbnail
    const sz = img.getSize()
    const maxEdge = Math.max(sz.width, sz.height)
    if (maxEdge > 1568) {
      const scale = 1568 / maxEdge // cap for Claude vision; cuts payload + latency
      img = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale) })
    }
    // JPEG compress screenshots to cut LLM payload size / latency while keeping text readable.
    const jpeg = img.toJPEG(88)
    const size = img.getSize()
    return { image: jpeg.toString('base64'), width: size.width, height: size.height }
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
    const provider = s.provider
    const def = PROVIDERS[provider]
    const key = getApiKey(provider)
    if (!key) {
      win?.webContents.send(IPC.streamError, {
        id: req.id,
        message: `No API key for ${def.label}. Open Settings (gear) and add it.`
      })
      return
    }
    // Route to the base (fast/cheap, e.g. Haiku) or think (stronger, e.g. Sonnet) tier per the user's
    // thinking-mode policy and the question's difficulty. For Dust this picks base vs thinking agent.
    const tier = routeTier(req, s.thinkingMode)
    const model = resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier)
    if (!model) {
      win?.webContents.send(IPC.streamError, {
        id: req.id,
        message:
          provider === 'dust'
            ? `No ${tier === 'think' ? 'thinking' : 'base'} Dust agent set. Open Settings → Connect Dust and pick your agents.`
            : `No model set for ${def.label}. Pick a model in Settings.`
      })
      return
    }
    if (req.mode === 'vision' && !def.vision) {
      win?.webContents.send(IPC.streamError, {
        id: req.id,
        message: `${def.label} can't read screenshots. Switch to Claude or GPT in Settings, or ask without a screen capture.`
      })
      return
    }
    if (provider === 'dust' && !s.dustWorkspaceId) {
      win?.webContents.send(IPC.streamError, {
        id: req.id,
        message: 'Add your Dust workspace ID in Settings → Your AI → Dust setup.'
      })
      return
    }
    const baseURL =
      provider === 'custom' ? s.customBaseUrl : provider === 'dust' ? s.dustBaseUrl : def.baseUrl
    const handle = createStream({
      providerId: provider,
      kind: def.kind,
      apiKey: key,
      baseURL,
      workspaceId: s.dustWorkspaceId,
      model,
      temperature: s.temperature,
      system: buildSystem(req, s.mode, s.profile, s.modePrompts, s.contextDocs[s.mode] || [], s.outputLanguage),
      req,
      handlers: {
        onDelta: (text) => win?.webContents.send(IPC.streamDelta, { id: req.id, text }),
        onDone: (u) => {
          streams.delete(req.id)
          win?.webContents.send(IPC.streamDone, { id: req.id, ...u })
        },
        onError: (message) => {
          streams.delete(req.id)
          win?.webContents.send(IPC.streamError, { id: req.id, message })
        }
      }
    })
    streams.set(req.id, handle)
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
  ipcMain.handle(IPC.windowMode, (e, mode: unknown) => {
    assertMainWindow(e)
    setWindowMode(mode === 'settings' ? 'settings' : 'bar')
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
  // Never let an unhandled error crash the overlay silently — log and keep the tray app alive.
  // (No crashReporter upload by design: AskToto ships zero telemetry.)
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err))
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason))
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
    (request, callback) => {
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
      const originOk = !mainUrl || origin === expectedOrigin || origin === mainUrl
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
      if (!audioArmed) {
        callback({}) // deny unless the user explicitly started Listen
        return
      }
      if (!isMainFrame || !originOk) {
        callback({}) // deny requests from unexpected origins or subframes
        return
      }
      if (!request.audioRequested || request.videoRequested) {
        callback({}) // we only grant audio loopback here; never grant video
        return
      }
      callback({ audio: 'loopback' })
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

  registerIpc()
  createWindow()
  registerShortcuts()
  createTray()
  startMeetingPoller()
  initAutoUpdate()

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
