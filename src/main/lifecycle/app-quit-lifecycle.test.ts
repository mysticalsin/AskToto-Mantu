import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installAppQuitLifecycle } from './app-quit-lifecycle'
import { createQuitTrace } from './quit-trace'

class TestApp extends EventEmitter {
  quits = 0

  quit(): void {
    this.quits += 1
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    this.emit('before-quit', event)
    if (event.defaultPrevented) return
    this.emit('will-quit')
    this.emit('quit')
  }

  isReady(): boolean {
    return true
  }

  getPath(): string {
    return '/private-test-profile'
  }
}

describe('app quit lifecycle', () => {
  it('stops the boot power-save blocker before clearing the watch with current userData', () => {
    const app = new TestApp()
    const cleanupOrder: string[] = []
    const wrappedNames: string[] = []
    const invokedNames: string[] = []
    installAppQuitLifecycle(app, {
      speechPackDesktop: () => null,
      quitTrace: createQuitTrace(false, () => undefined),
      isQuitFlushDone: () => true,
      markQuitFlushDone: () => undefined,
      meetingFlushPending: () => false,
      window: () => null,
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => undefined,
      setBootPowerSaveBlock: (active) => cleanupOrder.push(`power:${String(active)}`),
      endBootWatch: (userData) => cleanupOrder.push(`watch:${userData}`),
      globalShortcut: { unregisterAll: () => undefined },
      notifTimer: () => null,
      backgroundTimers: [],
      observability: () => null,
      uptime: () => 1,
      wrapLifecycleListener: (name, listener) => {
        wrappedNames.push(name)
        return () => {
          invokedNames.push(name)
          listener()
        }
      },
      warn: () => undefined
    })

    app.quit()

    expect(wrappedNames).toEqual(['app_quit'])
    expect(invokedNames).toEqual(['app_quit'])
    expect(cleanupOrder).toEqual(['power:false', 'watch:/private-test-profile'])
  })

  it('keeps a prevented pack quit alive, resumes once, then runs will-quit cleanup', async () => {
    const app = new TestApp()
    const lines: string[] = []
    const quitTrace = createQuitTrace(true, (line) => lines.push(line))
    let packReady = false
    const backgroundTimers: ReturnType<typeof setInterval>[] = []
    installAppQuitLifecycle(app, {
      speechPackDesktop: () => ({
        beforeQuit(event, quit) {
          if (packReady) return
          event.preventDefault()
          queueMicrotask(() => {
            packReady = true
            quitTrace.mark('PACK_QUIT_RESUME')
            quitTrace.call('PACK_RESUME', quit)
          })
        }
      }),
      quitTrace,
      isQuitFlushDone: () => true,
      markQuitFlushDone: () => undefined,
      meetingFlushPending: () => false,
      window: () => null,
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => undefined,
      setBootPowerSaveBlock: () => undefined,
      endBootWatch: () => undefined,
      globalShortcut: { unregisterAll: () => undefined },
      notifTimer: () => null,
      backgroundTimers,
      observability: () => ({ shutdownClean: () => undefined }),
      uptime: () => 1,
      wrapLifecycleListener: (_name, listener) => listener,
      warn: () => undefined
    })

    app.quit()
    expect(app.quits).toBe(1)
    await Promise.resolve()
    expect(app.quits).toBe(2)
    expect(lines.map((line) => line.replace('[METIS_QUIT_TRACE] ', ''))).toEqual([
      'BEFORE_QUIT_ENTER',
      'BEFORE_QUIT_PREVENTED',
      'PACK_QUIT_RESUME',
      'QUIT_CALL_ENTER_PACK_RESUME',
      'BEFORE_QUIT_ENTER',
      'BEFORE_QUIT_ALLOWED',
      'WILL_QUIT_CLEANUP_ENTER',
      'WILL_QUIT_CLEANUP_EXIT',
      'APP_QUIT',
      'QUIT_CALL_RETURNED_PACK_RESUME'
    ])
  })
})
