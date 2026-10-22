import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { registerQuitIpc } from './quit-ipc'

function register(senderIsMain: boolean) {
  const handlers = new Map<string, (event: unknown) => unknown>()
  const listeners = new Map<string, (event: unknown) => unknown>()
  const assertMainWindow = vi.fn((_event: IpcMainInvokeEvent) => undefined)
  const deps = {
    ipcMain: {
      handle: (channel: string, handler: (event: unknown) => unknown) => handlers.set(channel, handler),
      on: (channel: string, listener: (event: unknown) => unknown) => listeners.set(channel, listener)
    } as unknown as Pick<IpcMain, 'handle' | 'on'>,
    assertMainWindow,
    isMainWindowSender: vi.fn((_event: IpcMainEvent) => senderIsMain),
    app: { quit: vi.fn(), relaunch: vi.fn() },
    quitTrace: { mark: vi.fn(), requestQuit: vi.fn(), call: vi.fn((_site: string, quit: () => void) => quit()) },
    markQuitFlushDone: vi.fn(),
    acknowledgeQuitFlush: vi.fn()
  }
  registerQuitIpc(deps)
  return { handlers, listeners, deps }
}

describe('quit IPC', () => {
  it('acknowledges the quit flush from the main window only', () => {
    const main = register(true)
    main.listeners.get(IPC.quitFlushDone)!({})
    expect(main.deps.acknowledgeQuitFlush).toHaveBeenCalledTimes(1)

    const other = register(false)
    other.listeners.get(IPC.quitFlushDone)!({})
    expect(other.deps.acknowledgeQuitFlush).not.toHaveBeenCalled()
  })

  it('keeps the explicit quit and relaunch handlers sender-checked, with relaunch leaving the flush undone', () => {
    const { handlers, deps } = register(true)
    handlers.get(IPC.windowQuit)!({})
    handlers.get(IPC.windowRelaunch)!({})
    expect(deps.assertMainWindow).toHaveBeenCalledTimes(2)
    // Quit marks the flush done (the renderer already saved), so before-quit adds no second wait.
    expect(deps.markQuitFlushDone).toHaveBeenCalledTimes(1)
    expect(deps.app.quit).toHaveBeenCalledTimes(2) // quit(), then relaunch()'s own quit
    expect(deps.app.relaunch).toHaveBeenCalledTimes(1)
  })

  it('does not quit or relaunch when the sender check throws', () => {
    const { handlers, deps } = register(true)
    deps.assertMainWindow.mockImplementation(() => {
      throw new Error('IPC denied')
    })
    expect(() => handlers.get(IPC.windowQuit)!({})).toThrow('IPC denied')
    expect(() => handlers.get(IPC.windowRelaunch)!({})).toThrow('IPC denied')
    expect(deps.app.quit).not.toHaveBeenCalled()
    expect(deps.app.relaunch).not.toHaveBeenCalled()
    expect(deps.markQuitFlushDone).not.toHaveBeenCalled()
  })
})
