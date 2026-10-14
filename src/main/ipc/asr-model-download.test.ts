import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { registerHighTierAsrModelFetch } from './asr-model-download'

describe('ASR model download IPC adapter', () => {
  it('checks the sender and keeps the transfer behind authentication', async () => {
    const handlers = new Map<string, (event: Electron.IpcMainInvokeEvent) => Promise<unknown>>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: Electron.IpcMainInvokeEvent) => Promise<unknown>) => {
        handlers.set(channel, handler)
      })
    }
    const assertMainWindow = vi.fn()
    const onTransfer = vi.fn()
    registerHighTierAsrModelFetch({
      ipcMain,
      assertMainWindow,
      authenticated: () => false,
      runtimeAvailable: async () => true,
      authorityReadable: () => true,
      onTransfer
    })
    expect(ipcMain.handle).toHaveBeenCalledExactlyOnceWith(IPC.asrModelFetch, expect.any(Function))
    const handler = handlers.get(IPC.asrModelFetch)
    if (!handler) throw new Error('ASR model fetch handler was not registered')
    await expect(handler({} as Electron.IpcMainInvokeEvent)).resolves.toEqual({ ok: false })
    expect(assertMainWindow).toHaveBeenCalledOnce()
    expect(onTransfer).not.toHaveBeenCalled()
  })
})
