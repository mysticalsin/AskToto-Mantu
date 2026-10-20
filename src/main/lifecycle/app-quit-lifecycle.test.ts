import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installAppQuitLifecycle } from './app-quit-lifecycle'
import { createQuitTrace } from './quit-trace'

class TestApp extends EventEmitter {
  quits = 0
  lastBeforeQuitEvent: { defaultPrevented: boolean; preventDefault(): void } | null = null

  quit(): void {
    this.quits += 1
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    this.lastBeforeQuitEvent = event
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
  afterEach(() => vi.useRealTimers())

  it('stops the boot power-save blocker before clearing the watch with current userData', () => {
    const app = new TestApp()
    const lifecycleOrder: string[] = []
    const wrappedNames: string[] = []
    const invokedNames: string[] = []
    installAppQuitLifecycle(app, {
      speechPackDesktop: () => ({
        beforeQuit: () => lifecycleOrder.push('pack:before-quit')
      }),
      beginInputShutdown: () => lifecycleOrder.push('inputs:begin'),
      quitTrace: createQuitTrace(false, () => undefined),
      isQuitFlushDone: () => true,
      markQuitFlushDone: () => undefined,
      meetingFlushPending: () => false,
      window: () => null,
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => lifecycleOrder.push('cloud:invalidate'),
      shutdownInputSessions: () => lifecycleOrder.push('inputs:shutdown'),
      setBootPowerSaveBlock: (active) => lifecycleOrder.push(`power:${String(active)}`),
      endBootWatch: (userData) => lifecycleOrder.push(`watch:${userData}`),
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
    expect(lifecycleOrder).toEqual([
      'inputs:begin',
      'pack:before-quit',
      'cloud:invalidate',
      'inputs:shutdown',
      'power:false',
      'watch:/private-test-profile'
    ])
  })

  it('keeps a prevented pack quit alive, resumes once, then runs will-quit cleanup', async () => {
    const app = new TestApp()
    const lines: string[] = []
    const lifecycleOrder: string[] = []
    const quitTrace = createQuitTrace(true, (line) => lines.push(line))
    let packReady = false
    let shutdownCalls = 0
    let beginCalls = 0
    const backgroundTimers: ReturnType<typeof setInterval>[] = []
    installAppQuitLifecycle(app, {
      speechPackDesktop: () => ({
        beforeQuit(event, quit) {
          lifecycleOrder.push('pack:before-quit')
          if (packReady) return
          event.preventDefault()
          queueMicrotask(() => {
            packReady = true
            quitTrace.mark('PACK_QUIT_RESUME')
            quitTrace.call('PACK_RESUME', quit)
          })
        }
      }),
      beginInputShutdown: () => {
        beginCalls += 1
        lifecycleOrder.push('inputs:begin')
      },
      quitTrace,
      isQuitFlushDone: () => true,
      markQuitFlushDone: () => undefined,
      meetingFlushPending: () => false,
      window: () => null,
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => lifecycleOrder.push('cloud:invalidate'),
      shutdownInputSessions: () => {
        shutdownCalls += 1
        lifecycleOrder.push('inputs:shutdown')
      },
      setBootPowerSaveBlock: () => lifecycleOrder.push('power:cleanup'),
      endBootWatch: () => lifecycleOrder.push('watch:cleanup'),
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
    expect(beginCalls).toBe(1)
    expect(shutdownCalls).toBe(0)
    expect(lifecycleOrder.slice(0, 2)).toEqual(['inputs:begin', 'pack:before-quit'])
    await Promise.resolve()
    expect(app.quits).toBe(2)
    expect(beginCalls).toBe(1)
    expect(shutdownCalls).toBe(1)
    expect(lifecycleOrder).toEqual([
      'inputs:begin',
      'pack:before-quit',
      'pack:before-quit',
      'cloud:invalidate',
      'inputs:shutdown',
      'power:cleanup',
      'watch:cleanup'
    ])
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

  it('keeps input authority through the two-second meeting flush, then shuts it down at will-quit', async () => {
    vi.useFakeTimers()
    const app = new TestApp()
    let shutdownCalls = 0
    let beginCalls = 0
    let flushRequests = 0
    let flushDone = false
    let flushMarkCalls = 0
    const flushMessages: { channel: string; args: unknown[] }[] = []
    const flushEvents: string[] = []
    installAppQuitLifecycle(app, {
      speechPackDesktop: () => null,
      beginInputShutdown: () => {
        beginCalls += 1
      },
      quitTrace: createQuitTrace(false, () => undefined),
      isQuitFlushDone: () => {
        flushEvents.push(`done:${String(flushDone)}`)
        return flushDone
      },
      markQuitFlushDone: () => {
        expect(app.lastBeforeQuitEvent?.defaultPrevented).toBe(true)
        flushMarkCalls += 1
        flushDone = true
        flushEvents.push('mark')
      },
      meetingFlushPending: () => {
        flushEvents.push('pending')
        return true
      },
      window: () => ({
        isDestroyed: () => false,
        webContents: {
          send: (channel, ...args) => {
            flushRequests += 1
            flushMessages.push({ channel, args })
            expect(flushDone).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
            flushEvents.push('reset')
          }
        }
      }),
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => undefined,
      shutdownInputSessions: () => {
        shutdownCalls += 1
      },
      setBootPowerSaveBlock: () => undefined,
      endBootWatch: () => undefined,
      globalShortcut: { unregisterAll: () => undefined },
      notifTimer: () => null,
      backgroundTimers: [],
      observability: () => null,
      uptime: () => 1,
      wrapLifecycleListener: (_name, listener) => listener,
      warn: () => undefined
    })

    app.quit()
    expect(app.quits).toBe(1)
    expect(beginCalls).toBe(1)
    expect(flushRequests).toBe(1)
    expect(flushMarkCalls).toBe(1)
    expect(flushMessages).toEqual([{ channel: 'hotkey', args: ['reset'] }])
    expect(flushEvents).toEqual(['done:false', 'pending', 'mark', 'reset'])
    expect(shutdownCalls).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(app.quits).toBe(1)
    expect(shutdownCalls).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(app.quits).toBe(2)
    expect(beginCalls).toBe(1)
    expect(shutdownCalls).toBe(1)
    expect(flushRequests).toBe(1)
    expect(flushMarkCalls).toBe(1)
    expect(flushMessages).toEqual([{ channel: 'hotkey', args: ['reset'] }])
    expect(flushEvents).toEqual(['done:false', 'pending', 'mark', 'reset', 'done:true'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    {
      state: 'missing',
      window: () => null
    },
    {
      state: 'destroyed',
      window: () => ({ isDestroyed: () => true, webContents: { send: vi.fn() } })
    }
  ])('runs final cleanup without a flush timer when the window is $state', ({ window: getWindow }) => {
    vi.useFakeTimers()
    const app = new TestApp()
    const lifecycleOrder: string[] = []
    const send = vi.fn()
    let beginCalls = 0
    let shutdownCalls = 0
    let flushDoneCalls = 0

    const window = getWindow()
    if (window) window.webContents.send = send

    installAppQuitLifecycle(app, {
      speechPackDesktop: () => null,
      beginInputShutdown: () => {
        beginCalls += 1
        lifecycleOrder.push('inputs:begin')
      },
      quitTrace: createQuitTrace(false, () => undefined),
      isQuitFlushDone: () => false,
      markQuitFlushDone: () => {
        flushDoneCalls += 1
      },
      meetingFlushPending: () => true,
      window: () => window,
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => lifecycleOrder.push('cloud:invalidate'),
      shutdownInputSessions: () => {
        shutdownCalls += 1
        lifecycleOrder.push('inputs:shutdown')
      },
      setBootPowerSaveBlock: () => lifecycleOrder.push('power:cleanup'),
      endBootWatch: () => lifecycleOrder.push('watch:cleanup'),
      globalShortcut: { unregisterAll: () => undefined },
      notifTimer: () => null,
      backgroundTimers: [],
      observability: () => null,
      uptime: () => 1,
      wrapLifecycleListener: (_name, listener) => listener,
      warn: () => undefined
    })

    app.quit()

    expect(app.quits).toBe(1)
    expect(beginCalls).toBe(1)
    expect(flushDoneCalls).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(shutdownCalls).toBe(1)
    expect(lifecycleOrder).toEqual([
      'inputs:begin',
      'cloud:invalidate',
      'inputs:shutdown',
      'power:cleanup',
      'watch:cleanup'
    ])
  })
})
