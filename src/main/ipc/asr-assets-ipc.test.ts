import { describe, expect, it, vi } from 'vitest'
import { IPC, type AsrAssetsStatus, type ImportAssetsProgress } from '@shared/ipc'
import { registerAsrAssetsIpc } from './asr-assets-ipc'

type IpcEvent = Electron.IpcMainInvokeEvent
type Listener = (event: IpcEvent, request?: unknown) => unknown

function eventFrom(sender: unknown): IpcEvent {
  return { sender } as unknown as IpcEvent
}

function makeIpc() {
  const handlers = new Map<string, Listener>()
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
  const handle = vi.fn((channel: string, listener: Listener) => handlers.set(channel, listener))
  return {
    ipcMain: { handle, removeHandler } as unknown as Pick<Electron.IpcMain, 'handle' | 'removeHandler'>,
    handlers,
    handle,
    removeHandler
  }
}

function makeOptions() {
  const ipc = makeIpc()
  const currentProgress: ImportAssetsProgress = { status: 'downloading', progress: 0, label: 'Preparing' }
  const status: AsrAssetsStatus = { ready: false, status: 'idle', progress: 0, label: '' }
  const options = {
    ipcMain: ipc.ipcMain,
    isRecentlyRetiredOverlaySender: vi.fn((_event: IpcEvent) => false),
    assertMainWindow: vi.fn(),
    readBundledStatus: vi.fn(async () => true),
    getStatus: vi.fn(async () => status),
    ensureAllowed: vi.fn(() => true),
    ensureAssets: vi.fn(async (_onProgress: (percentage: number) => void) => undefined),
    getProgress: vi.fn(() => currentProgress),
    publishProgress: vi.fn((_progress: ImportAssetsProgress) => undefined),
    warn: vi.fn()
  }
  return { ...ipc, options }
}

describe('registerAsrAssetsIpc', () => {
  it('does no probing or transfer work during registration and returns the real prime promise', async () => {
    const { options } = makeOptions()
    let release!: () => void
    options.readBundledStatus.mockImplementation(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true)))
    )

    const registered = registerAsrAssetsIpc(options)
    expect(options.readBundledStatus).not.toHaveBeenCalled()
    expect(options.getStatus).not.toHaveBeenCalled()
    expect(options.ensureAssets).not.toHaveBeenCalled()

    let settled = false
    const priming = registered.primeBundledStatus().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await priming
    expect(options.readBundledStatus).toHaveBeenCalledOnce()
    registered.cleanup()
  })

  it('returns the retired renderer default before the live-window assertion, only for bundled status', async () => {
    const { handlers, options } = makeOptions()
    const retired = eventFrom({})
    options.isRecentlyRetiredOverlaySender.mockImplementation((event) => event === retired)
    options.assertMainWindow.mockImplementation(() => {
      throw new Error('active sender rejected')
    })
    const registered = registerAsrAssetsIpc(options)

    await expect(handlers.get(IPC.asrBundled)?.(retired)).resolves.toBe(true)
    expect(options.assertMainWindow).not.toHaveBeenCalled()
    expect(options.readBundledStatus).not.toHaveBeenCalled()

    await expect(handlers.get(IPC.asrAssetsStatus)?.(retired)).rejects.toThrow('active sender rejected')
    await expect(handlers.get(IPC.asrAssetsEnsure)?.(retired)).rejects.toThrow('active sender rejected')
    expect(options.getStatus).not.toHaveBeenCalled()
    expect(options.ensureAssets).not.toHaveBeenCalled()
    expect(options.isRecentlyRetiredOverlaySender).toHaveBeenCalledOnce()
    registered.cleanup()
  })

  it('asserts active status requests before probing and probes bundled readiness on every request', async () => {
    const { handlers, options } = makeOptions()
    const trusted = eventFrom({})
    let ready = false
    options.readBundledStatus.mockImplementation(async () => {
      expect(options.assertMainWindow).toHaveBeenCalled()
      return ready
    })
    const registered = registerAsrAssetsIpc(options)

    await expect(handlers.get(IPC.asrBundled)?.(trusted)).resolves.toBe(false)
    ready = true
    await expect(handlers.get(IPC.asrBundled)?.(trusted)).resolves.toBe(true)
    await expect(handlers.get(IPC.asrAssetsStatus)?.(trusted)).resolves.toMatchObject({ ready: false })
    expect(options.readBundledStatus).toHaveBeenCalledTimes(2)
    expect(options.assertMainWindow).toHaveBeenCalledTimes(3)
    registered.cleanup()
  })

  it('blocks ensure under policy without transfer, and reports progress plus final status when allowed', async () => {
    const { handlers, options, removeHandler } = makeOptions()
    const trusted = eventFrom({})
    const registered = registerAsrAssetsIpc(options)

    options.ensureAllowed.mockReturnValue(false)
    await handlers.get(IPC.asrAssetsEnsure)?.(trusted)
    expect(options.ensureAssets).not.toHaveBeenCalled()
    expect(options.getStatus).toHaveBeenCalledOnce()

    options.ensureAllowed.mockReturnValue(true)
    options.ensureAssets.mockImplementation(async (onProgress) => {
      onProgress(35)
    })
    await handlers.get(IPC.asrAssetsEnsure)?.(trusted)
    expect(options.ensureAssets).toHaveBeenCalledOnce()
    expect(options.publishProgress).toHaveBeenCalledWith({ ...options.getProgress(), progress: 0.35 })
    expect(options.getStatus).toHaveBeenCalledTimes(2)

    registered.cleanup()
    expect(removeHandler.mock.calls.slice(-3).map(([channel]) => channel)).toEqual([
      IPC.asrBundled,
      IPC.asrAssetsStatus,
      IPC.asrAssetsEnsure
    ])
  })

  it('keeps an ensure failure inside the status response and resets progress', async () => {
    const { handlers, options } = makeOptions()
    const trusted = eventFrom({})
    const failure = new Error('offline')
    options.ensureAssets.mockRejectedValue(failure)
    const registered = registerAsrAssetsIpc(options)

    await expect(handlers.get(IPC.asrAssetsEnsure)?.(trusted)).resolves.toMatchObject({ ready: false })
    expect(options.warn).toHaveBeenCalledWith('[asr-assets] ensure failed:', 'offline')
    expect(options.publishProgress).toHaveBeenCalledWith(options.getProgress())
    expect(options.getStatus).toHaveBeenCalledOnce()
    registered.cleanup()
  })
})
