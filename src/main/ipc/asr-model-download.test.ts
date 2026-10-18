import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { registerHighTierAsrModelFetch } from './asr-model-download'

const io = vi.hoisted(() => ({
  getPath: vi.fn(() => {
    throw new Error('Refused ASR request reached model-path I/O')
  }),
  fetch: vi.fn(() => {
    throw new Error('Refused ASR request reached network I/O')
  })
}))
vi.mock('electron', () => ({ app: { getPath: io.getPath }, net: { fetch: io.fetch } }))
vi.mock('../logger', () => ({ mainLog: { warn: vi.fn() } }))
afterEach(() => vi.clearAllMocks())

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
    expect(io.getPath).not.toHaveBeenCalled()
    expect(io.fetch).not.toHaveBeenCalled()
  })

  it.each([
    'sender',
    'authentication',
    'runtime',
    'authority'
  ] as const)('stops at the real %s boundary without reaching later admission or transfer', async (boundary) => {
    let handler: ((event: Electron.IpcMainInvokeEvent) => Promise<unknown>) | undefined
    const event = {} as Electron.IpcMainInvokeEvent
    const order: string[] = []
    const assertMainWindow = vi.fn(() => {
      order.push('sender')
      if (boundary === 'sender') throw new Error('Rejected sender')
    })
    const authenticated = vi.fn(() => {
      order.push('authentication')
      return boundary !== 'authentication'
    })
    const runtimeAvailable = vi.fn(async () => {
      order.push('runtime')
      return boundary !== 'runtime'
    })
    const authorityReadable = vi.fn(async () => {
      order.push('authority')
      return false
    })
    const onTransfer = vi.fn()
    registerHighTierAsrModelFetch({
      ipcMain: {
        handle: (channel, callback) => {
          expect(channel).toBe(IPC.asrModelFetch)
          handler = callback
        }
      },
      assertMainWindow,
      authenticated,
      runtimeAvailable,
      authorityReadable,
      onTransfer
    })
    // Merely registering an optional transfer must not read authority or start work.
    expect(order).toEqual([])
    expect(handler).toBeDefined()
    if (!handler) throw new Error('Actual ASR fetch handler was not registered')
    if (boundary === 'sender') await expect(handler(event)).rejects.toThrow('Rejected sender')
    else await expect(handler(event)).resolves.toEqual({ ok: false })
    const steps = ['sender', 'authentication', 'runtime', 'authority']
    expect(order).toEqual(steps.slice(0, steps.indexOf(boundary) + 1))
    expect(assertMainWindow).toHaveBeenCalledExactlyOnceWith(event)
    expect(onTransfer).not.toHaveBeenCalled()
    expect(io.getPath).not.toHaveBeenCalled()
    expect(io.fetch).not.toHaveBeenCalled()
  })
})
