import type { QuitTrace } from './quit-trace'

type BeforeQuitEvent = { defaultPrevented: boolean; preventDefault(): void }
type QuitLifecycleApp = {
  on(event: 'window-all-closed' | 'quit', listener: () => void): unknown
  on(event: 'before-quit', listener: (event: BeforeQuitEvent) => void): unknown
  on(event: 'will-quit', listener: () => void): unknown
  quit(): void
  isReady(): boolean
  getPath(name: 'userData'): string
}
type QuitWindow = { isDestroyed(): boolean; webContents: { send(channel: string, ...args: unknown[]): void } }
type SpeechPackQuit = {
  beforeQuit(event: BeforeQuitEvent, quit: () => void, meetingFlushPending: boolean): void
} | null

export function installAppQuitLifecycle(
  app: QuitLifecycleApp,
  deps: {
    speechPackDesktop: () => SpeechPackQuit
    quitTrace: QuitTrace
    isQuitFlushDone: () => boolean
    markQuitFlushDone: () => void
    meetingFlushPending: () => boolean
    window: () => QuitWindow | null
    hotkeyChannel: string
    speechDesktop: () => { dispose(): Promise<void> } | null
    invalidateCloudSttOwner(): void
    setBootPowerSaveBlock(active: boolean): void
    endBootWatch(userData: string): void
    globalShortcut: { unregisterAll(): void }
    notifTimer: () => ReturnType<typeof setInterval> | null
    backgroundTimers: ReturnType<typeof setInterval>[]
    observability: () => { shutdownClean(uptimeSeconds: number): void } | null
    uptime(): number
    wrapLifecycleListener(name: string, listener: () => void): () => void
    warn(message: string, error: unknown): void
  }
): void {
  app.on('window-all-closed', () => {
    deps.quitTrace.mark('WINDOW_ALL_CLOSED')
    // Overlay app: stay alive in tray; quit only via tray/menu.
  })

  app.on('before-quit', (event) => {
    deps.quitTrace.requestQuit()
    deps.quitTrace.mark('BEFORE_QUIT_ENTER')
    deps.speechPackDesktop()?.beforeQuit(event, () => app.quit(), deps.meetingFlushPending())
  })

  app.on('before-quit', (event) => {
    if (deps.isQuitFlushDone() || !deps.meetingFlushPending()) return
    const window = deps.window()
    if (!window || window.isDestroyed()) return
    event.preventDefault()
    deps.markQuitFlushDone()
    try {
      window.webContents.send(deps.hotkeyChannel, 'reset')
    } catch {
      /* window may already be gone */
    }
    setTimeout(() => app.quit(), 2000)
  })

  let speechShutdownDone = false
  app.on('before-quit', (event) => {
    const speechDesktop = deps.speechDesktop()
    if (event.defaultPrevented || speechShutdownDone || !speechDesktop) return
    event.preventDefault()
    speechShutdownDone = true
    const disposal = speechDesktop.dispose()
    void disposal.then(
      () => {
        deps.quitTrace.mark('SPEECH_DISPOSE_SETTLED')
        deps.quitTrace.mark('SPEECH_QUIT_RESUME')
        deps.quitTrace.call('SPEECH_RESUME', () => app.quit())
      },
      (error: unknown) => {
        deps.quitTrace.mark('SPEECH_DISPOSE_REJECTED')
        deps.quitTrace.mark('SPEECH_QUIT_RESUME')
        deps.quitTrace.call('SPEECH_RESUME', () => app.quit())
        throw error
      }
    )
  })

  app.on('before-quit', (event) => {
    deps.quitTrace.mark(event.defaultPrevented ? 'BEFORE_QUIT_PREVENTED' : 'BEFORE_QUIT_ALLOWED')
  })
  app.on('quit', () => deps.quitTrace.mark('APP_QUIT'))

  app.on(
    'will-quit',
    deps.wrapLifecycleListener('app_quit', () => {
      deps.quitTrace.mark('WILL_QUIT_CLEANUP_ENTER')
      deps.invalidateCloudSttOwner()
      try {
        deps.setBootPowerSaveBlock(false)
        deps.endBootWatch(app.getPath('userData'))
      } catch (error) {
        deps.warn('[will-quit] endBootWatch failed', error)
      }
      if (app.isReady()) {
        try {
          deps.globalShortcut.unregisterAll()
        } catch (error) {
          deps.warn('[will-quit] globalShortcut.unregisterAll failed', error)
        }
      }
      const notifTimer = deps.notifTimer()
      if (notifTimer) clearInterval(notifTimer)
      for (const timer of deps.backgroundTimers) {
        try {
          clearInterval(timer)
        } catch {
          /* already cleared */
        }
      }
      deps.backgroundTimers.length = 0
      try {
        deps.observability()?.shutdownClean(deps.uptime())
      } catch (error) {
        deps.warn('[will-quit] observability.shutdownClean failed', error)
      }
      deps.quitTrace.mark('WILL_QUIT_CLEANUP_EXIT')
    })
  )
}
