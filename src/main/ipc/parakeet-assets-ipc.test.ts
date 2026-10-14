import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { registerParakeetAssetsIpc } from './parakeet-assets-ipc'

type Listener = (event: Electron.IpcMainInvokeEvent) => unknown

function eventFrom(sender: unknown): Electron.IpcMainInvokeEvent {
  return { sender } as unknown as Electron.IpcMainInvokeEvent
}

function makeIpc() {
  const handlers = new Map<string, Listener>()
  const handle = vi.fn((channel: string, listener: Listener) => handlers.set(channel, listener))
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
  return {
    ipcMain: { handle, removeHandler } as unknown as Pick<Electron.IpcMain, 'handle' | 'removeHandler'>,
    handlers,
    handle,
    removeHandler
  }
}

function makeOptions() {
  const ipc = makeIpc()
  const options = {
    ipcMain: ipc.ipcMain,
    assertMainWindow: vi.fn(),
    requireAuth: vi.fn(() => true),
    modelReady: vi.fn(async () => true),
    addonError: vi.fn(async () => null as string | null),
    ensureModel: vi.fn(async (_onProgress: (percentage: number) => void) => undefined),
    publishProgress: vi.fn((_progress: { pct: number }) => undefined)
  }
  return { ...ipc, options }
}

describe('registerParakeetAssetsIpc', () => {
  it('validates status requests and reads current readiness and addon error each time', async () => {
    const { handlers, options } = makeOptions()
    const trusted = eventFrom({})
    const order: string[] = []
    let ready = false
    let addonError: string | null = 'native addon unavailable'
    options.assertMainWindow.mockImplementation(() => order.push('sender'))
    options.modelReady.mockImplementation(async () => {
      order.push('ready')
      return ready
    })
    options.addonError.mockImplementation(async () => {
      order.push('addonError')
      return addonError
    })

    const registered = registerParakeetAssetsIpc(options)
    expect(options.modelReady).not.toHaveBeenCalled()
    expect(options.addonError).not.toHaveBeenCalled()
    await expect(handlers.get(IPC.parakeetStatus)?.(trusted)).resolves.toEqual({
      ready: false,
      addonError: 'native addon unavailable'
    })
    ready = true
    addonError = null
    order.length = 0
    await expect(handlers.get(IPC.parakeetStatus)?.(trusted)).resolves.toEqual({ ready: true, addonError: null })
    expect(order).toEqual(['sender', 'ready', 'addonError'])
    expect(options.modelReady).toHaveBeenCalledTimes(2)
    expect(options.addonError).toHaveBeenCalledTimes(2)
    expect(options.requireAuth).not.toHaveBeenCalled()
    registered.cleanup()
  })

  it('checks the sender before auth, blocks unauthenticated ensure, and forwards progress when allowed', async () => {
    const { handlers, options } = makeOptions()
    const trusted = eventFrom({})
    const order: string[] = []
    options.assertMainWindow.mockImplementation(() => order.push('sender'))
    options.requireAuth.mockImplementation(() => {
      order.push('auth')
      return false
    })
    const registered = registerParakeetAssetsIpc(options)

    await expect(handlers.get(IPC.parakeetEnsure)?.(trusted)).resolves.toEqual({ ok: false })
    expect(order).toEqual(['sender', 'auth'])
    expect(options.ensureModel).not.toHaveBeenCalled()
    expect(options.modelReady).not.toHaveBeenCalled()

    options.requireAuth.mockReturnValue(true)
    options.ensureModel.mockImplementation(async (onProgress) => {
      onProgress(42)
    })
    await expect(handlers.get(IPC.parakeetEnsure)?.(trusted)).resolves.toEqual({ ok: true })
    expect(options.ensureModel).toHaveBeenCalledOnce()
    expect(options.publishProgress).toHaveBeenCalledWith({ pct: 42 })
    expect(options.modelReady).toHaveBeenCalledOnce()
    registered.cleanup()
  })

  it('preserves the existing ensure error response', async () => {
    const { handlers, options } = makeOptions()
    options.ensureModel.mockRejectedValue(new Error('model files are incomplete'))
    const registered = registerParakeetAssetsIpc(options)

    await expect(handlers.get(IPC.parakeetEnsure)?.(eventFrom({}))).resolves.toEqual({
      ok: false,
      error: 'model files are incomplete'
    })
    expect(options.modelReady).not.toHaveBeenCalled()
    registered.cleanup()
  })

  it('removes both handlers on cleanup', () => {
    const { handlers, options, removeHandler } = makeOptions()
    const registered = registerParakeetAssetsIpc(options)
    expect(handlers.has(IPC.parakeetStatus)).toBe(true)
    expect(handlers.has(IPC.parakeetEnsure)).toBe(true)

    registered.cleanup()
    expect(removeHandler.mock.calls).toEqual([[IPC.parakeetStatus], [IPC.parakeetEnsure]])
    expect(handlers.size).toBe(0)
  })
})
