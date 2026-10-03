import type { App, BrowserWindow, GlobalShortcut, IpcMain } from 'electron'
import type { HotkeyAction } from '@shared/ipc'
import type { AppContext } from '../app/context'
import type { ObservabilityDetail } from '../infra/observability/projection'
import type { RunObservability } from '../infra/observability/run-observability'
import type { AuditSink } from '../logger'
import type { RenderProcessGoneReason } from './reload-budget'
import type { RevealReason } from './reveal'

export interface LifecycleLog {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface SecondInstanceLifecycleDeps {
  reveal: (reason: RevealReason, options?: { focus?: boolean }) => void
  handleSmokeReopenProbe: (commandLine: readonly string[]) => boolean
}

export function installSecondInstanceLifecycle(
  app: App,
  deps: SecondInstanceLifecycleDeps
): void {
  app.on('second-instance', (_event, commandLine) => {
    deps.reveal('second-instance', { focus: true })
    deps.handleSmokeReopenProbe(commandLine)
  })
}

export interface BootstrapLifecycleDeps {
  runReady: () => Promise<void>
  onReadyFailure: (error: unknown) => void
}

export function installReadyBootstrapLifecycle(
  app: App,
  _context: AppContext,
  deps: BootstrapLifecycleDeps
): void {
  app.whenReady().then(async () => {
    await deps.runReady()
  }).catch(deps.onReadyFailure)
}

export interface QuitFlowLifecycleDeps {
  ipc: { hotkey: string }
  getQuitFlushDone: () => boolean
  setQuitFlushDone: (done: boolean) => void
  getRecordingPowerSaveBlockerId: () => number | null
  invalidateCloudSttOwner: () => void
  setBootPowerSaveBlock: (on: boolean) => void
  endBootWatch: (userData: string) => void
  globalShortcut: Pick<GlobalShortcut, 'unregisterAll'>
  getNotifTimer: () => NodeJS.Timeout | null
  clearNotifTimer: (timer: NodeJS.Timeout) => void
  backgroundTimers: NodeJS.Timeout[]
  getObservability: () => RunObservability | null
  log: LifecycleLog
}

export function installQuitFlowLifecycle(
  app: App,
  context: AppContext,
  deps: QuitFlowLifecycleDeps
): void {
  app.on('window-all-closed', () => {
    // Overlay app: stay alive in tray; quit only via tray/menu.
  })

  // Tray "Quit AskToto" (and any other path that calls app.quit() directly, e.g. Cmd+Q on macOS) used to
  // tear the process down with zero drain: the in-progress meeting's transcript lives only in renderer
  // React state, written to disk solely by a 60s autosave interval, so a graceful-looking Quit could lose
  // up to 60s of a meeting or the entire thing for a sub-60s one. The in-app Settings "Quit" button is
  // already safe -- App.tsx's quitApp() awaits flushLiveMeeting() before calling window.toto.quit(), which
  // marks quitFlushDone above and lets this handler no-op. For every other quit path, give the renderer one
  // bounded chance to save: recordingPowerSaveBlockerId is non-null for exactly the duration of an active
  // meeting (see setRecordingPowerSaveBlock), so it's a reliable "is a meeting in progress" signal here in
  // main. Reuses the existing 'reset' hotkey, which already runs saveMeetingNow() for a live meeting
  // (App.tsx's reset()) -- no new IPC channel needed.
  app.on('before-quit', (e) => {
    const win = context.liveMainWindow()
    if (deps.getQuitFlushDone() || deps.getRecordingPowerSaveBlockerId() === null || !win) return
    e.preventDefault()
    deps.setQuitFlushDone(true)
    try {
      win.webContents.send(deps.ipc.hotkey, 'reset' satisfies HotkeyAction)
    } catch {
      /* window may already be gone */
    }
    setTimeout(() => app.quit(), 2000)
  })

  app.on('will-quit', () => {
    // The renderer may already be unavailable during shutdown; main owns the socket and must still stop it.
    deps.invalidateCloudSttOwner()
    // MQA-175: quitting before the boot watch closed on its own is a normal exit, not an early death --
    // clear it here so the next launch is not pushed into safe start by a user who simply quit fast.
    // Own try, like every other step below: a failure here must never skip the sidecar kill.
    try {
      deps.setBootPowerSaveBlock(false)
      deps.endBootWatch(app.getPath('userData'))
    } catch (e) {
      deps.log.warn('[will-quit] endBootWatch failed', e)
    }
    // will-quit can fire BEFORE the app ever finished becoming ready -- a quit requested during the async
    // startup sequence, an automation/Playwright app.close(), or an early abort. Calling globalShortcut in
    // that window throws "globalShortcut cannot be used before the app is ready" as an UNCAUGHT exception
    // (the observed crash), and there is nothing registered to unregister anyway -- so gate it on isReady().
    // Each cleanup step is independent (its own try), so one throw never skips the rest. Owned sidecars are
    // already stopped: installExitPaths registered the first will-quit listener (lifecycle/exit-paths.ts).
    if (app.isReady()) {
      try {
        deps.globalShortcut.unregisterAll()
      } catch (e) {
        deps.log.warn('[will-quit] globalShortcut.unregisterAll failed', e)
      }
    }
    const notifTimer = deps.getNotifTimer()
    if (notifTimer) deps.clearNotifTimer(notifTimer)
    // Cancel every tracked background poller FIRST, before the network stack is torn down -- a Dust-refresh
    // or reconcile interval firing a resolve mid-teardown is the shutdown-race SIGTRAP class.
    for (const t of deps.backgroundTimers) {
      try {
        clearInterval(t)
      } catch {
        /* already cleared */
      }
    }
    deps.backgroundTimers.length = 0
    // M2-0006: last, so it only fires once every other teardown step above has run. This is the one signal
    // that distinguishes THIS quit from a hard kill on the next boot's app.started.prevShutdown.
    try {
      deps.getObservability()?.shutdownClean(process.uptime())
    } catch (e) {
      deps.log.warn('[will-quit] observability.shutdownClean failed', e)
    }
  })
}

export interface RendererHealthLifecycleDeps {
  commandControl: { revokeForLifecycleEvent: (reason: string) => void }
  log: LifecycleLog & { info: (...args: unknown[]) => void }
  auditLog: AuditSink
  crashDetail: (kind: 'render-process-gone', detail: { reason: RenderProcessGoneReason; exitCode: number }) => ObservabilityDetail<'app.crash'>
  createResponsivenessTracker: () => {
    markUnresponsive: () => void
    markResponsive: () => number | null
    markGone: () => void
  }
  createReloadBudget: () => {
    onDidFinishLoad: () => void
    onRenderProcessGone: (reason: RenderProcessGoneReason) => 'reload' | 'halt' | 'ignore'
  }
  invalidateCloudSttOwner: (webContentsId?: number) => void
  resetDustConversation: () => void
  discardActiveLiveSpeakerSession: () => void
  setListeningActive: (on: boolean) => void
  resetLastPlainAskAt: () => void
  setAudioArmed: (on: boolean) => void
  setTrayRecording: (on: boolean) => void
  setRecordingPowerSaveBlock: (on: boolean) => void
  resetRecoveredOverlayGeometry: () => void
  onboardingExclusiveLive: () => boolean
  applyExclusiveOnboardingStage: (win: BrowserWindow) => boolean
  showForExclusiveOnboarding: (win: BrowserWindow) => void
  requireAuth: () => boolean
  resolveMeetingsFolder: () => string
  openMeetingsFolder: (path: string) => Promise<string>
  showRenderLoopHaltedDialog: (
    reason: RenderProcessGoneReason,
    exitCode: number,
    isTargetGone: () => boolean,
    showMessageBox: (options: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>,
    actions: {
      reload: () => void
      quit: () => void
      openMeetingsFolder?: () => Promise<void>
      copyDiagnostics: () => void
    }
  ) => Promise<void>
  showMessageBox: (win: BrowserWindow, options: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>
  reloadOverlay: (win: BrowserWindow) => void
  quit: () => void
  copyDiagnostics: (input: {
    version: string
    platform: string
    arch: string
    packaged: boolean
    reason: string
    exitCode: number
    at: string
  }) => void
  appInfo: () => { version: string; platform: string; arch: string; packaged: boolean }
}

export interface RendererCrashIpcLifecycleDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  rendererCrashChannel: string
  assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  redactRendererError: (raw: unknown) => { message: string; stack: string; componentStack: string; context?: unknown }
  persistRendererCrash: (message: string, detail: string, context?: unknown) => void
}

export function installRendererHealthLifecycle(
  context: AppContext,
  self: BrowserWindow,
  deps: RendererHealthLifecycleDeps
): void {
  const selfWebContentsId = self.webContents.id
  const responsiveness = deps.createResponsivenessTracker()
  self.on('unresponsive', () => {
    if (context.mainWindow() !== self) return
    responsiveness.markUnresponsive()
    deps.log.warn('[renderer-unresponsive] overlay renderer stopped responding')
    deps.auditLog('app.unresponsive', { kind: 'overlay' })
  })
  self.on('responsive', () => {
    if (context.mainWindow() !== self) return
    deps.log.info('[renderer-responsive] overlay renderer recovered')
    const stallMs = responsiveness.markResponsive()
    if (stallMs !== null) deps.auditLog('app.responsive', { kind: 'overlay', stallMs })
  })
  const reloadBudget = deps.createReloadBudget()
  self.webContents.on('did-finish-load', () => {
    if (context.mainWindow() !== self) return
    reloadBudget.onDidFinishLoad()
  })
  self.webContents.on('render-process-gone', (_e, details) => {
    if (context.mainWindow() !== self) return
    deps.commandControl.revokeForLifecycleEvent('renderer_replaced')
    deps.log.error(`[renderer-gone] reason=${details.reason} exitCode=${details.exitCode}`)
    deps.auditLog('app.crash', deps.crashDetail('render-process-gone', { reason: details.reason, exitCode: details.exitCode }))
    responsiveness.markGone()
    deps.invalidateCloudSttOwner(selfWebContentsId)
    deps.resetDustConversation()
    deps.discardActiveLiveSpeakerSession()
    deps.setListeningActive(false)
    deps.resetLastPlainAskAt()
    deps.setAudioArmed(false)
    deps.setTrayRecording(false)
    deps.setRecordingPowerSaveBlock(false)
    deps.resetRecoveredOverlayGeometry()
    if (deps.onboardingExclusiveLive() && !self.isDestroyed()) {
      const retainedOwnership = deps.applyExclusiveOnboardingStage(self)
      if (!retainedOwnership && context.mainWindow() !== self) return
      if (retainedOwnership) {
        try {
          deps.showForExclusiveOnboarding(self)
        } catch {
          /* headless */
        }
      }
    }
    if (context.mainWindow() !== self || self.isDestroyed()) return
    const reloadDecision = reloadBudget.onRenderProcessGone(details.reason)
    if (reloadDecision === 'ignore') return
    if (reloadDecision === 'halt') {
      deps.auditLog('app.render_loop_halted', { reason: details.reason, exitCode: details.exitCode })
      void deps.showRenderLoopHaltedDialog(
        details.reason,
        details.exitCode,
        () => context.mainWindow() !== self || self.isDestroyed(),
        (opts) => deps.showMessageBox(self, opts),
        {
          reload: () => deps.reloadOverlay(self),
          quit: () => deps.quit(),
          openMeetingsFolder: deps.requireAuth()
            ? async () => {
                const openError = await deps.openMeetingsFolder(deps.resolveMeetingsFolder())
                if (openError) deps.log.warn('[render-loop-halted] open meetings folder failed:', openError)
              }
            : undefined,
          copyDiagnostics: () => {
            const info = deps.appInfo()
            deps.copyDiagnostics({
              version: info.version,
              platform: info.platform,
              arch: info.arch,
              packaged: info.packaged,
              reason: details.reason,
              exitCode: details.exitCode,
              at: new Date().toISOString()
            })
          }
        }
      ).catch((err) => deps.log.warn('[render-loop-halted] dialog failed:', err))
      return
    }
    deps.reloadOverlay(self)
  })
  // deps.ipcMain.handle is installed by installRendererCrashIpcLifecycle; renderer health owns only window events.
}

export function installRendererCrashIpcLifecycle(deps: RendererCrashIpcLifecycleDeps): void {
  deps.ipcMain.handle(deps.rendererCrashChannel, (e, raw: unknown) => {
    deps.assertMainWindow(e)
    if (!deps.requireAuth()) return
    const r = deps.redactRendererError(raw)
    deps.persistRendererCrash(r.message, `${r.message}\nstack: ${r.stack}\ncomponentStack: ${r.componentStack}`, r.context)
  })
}

export interface ProcessFatalLifecycleDeps {
  isOrphanScreenSourcesRejection: (err: unknown, platform: NodeJS.Platform) => boolean
  persistCrash: (kind: 'uncaughtException' | 'unhandledRejection', detail: string, shortMessage: string) => void
  showFatalDialog: () => Promise<void>
  log: LifecycleLog
}

export function createProcessFatalLifecycle(deps: ProcessFatalLifecycleDeps): {
  onFatal: (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => void
} {
  let fatalHandled = false
  return {
    onFatal(kind, err) {
      if (kind === 'unhandledRejection' && deps.isOrphanScreenSourcesRejection(err, process.platform)) {
        return void deps.log.warn('[capture] desktopCapturer rejected a screen-source request (Screen Recording not in effect)')
      }
      const detail = err instanceof Error ? err.stack || err.message : String(err)
      deps.persistCrash(kind, detail, err instanceof Error ? err.message : String(err))
      if (kind !== 'uncaughtException' || fatalHandled) return
      fatalHandled = true
      void deps.showFatalDialog()
    }
  }
}
