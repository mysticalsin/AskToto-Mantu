import { describe, expect, it, vi } from 'vitest'
import { COMPONENT_OFFLOAD_IPC } from '@shared/component-offload'
import { registerComponentOffloadIpc } from './component-offload-ipc'

type IpcEvent = Electron.IpcMainInvokeEvent
type Listener = (event: IpcEvent, request?: unknown) => unknown

function makeIpc() {
  const handlers = new Map<string, Listener>()
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
  const handle = vi.fn((channel: string, listener: Listener) => handlers.set(channel, listener))
  return {
    ipcMain: { handle, removeHandler } as unknown as Pick<Electron.IpcMain, 'handle' | 'removeHandler'>,
    handlers,
    removeHandler
  }
}

const eventFrom = (sender: unknown): IpcEvent => ({ sender }) as unknown as IpcEvent

function makeService() {
  return {
    preview: vi.fn(async (request: unknown) => ({ ok: false as const, reason: 'invalid-request' as const, request })),
    confirm: vi.fn(async (request: unknown) => ({ ok: false as const, reason: 'plan-expired' as const, request })),
    receipts: vi.fn(async () => [])
  }
}

describe('registerComponentOffloadIpc (G87)', () => {
  it('rejects a non-main-window sender before the service is called', async () => {
    const { ipcMain, handlers } = makeIpc()
    const trusted = eventFrom({})
    const denied = new Error('denied')
    const assertMainWindow = vi.fn((event: IpcEvent) => {
      if (event !== trusted) throw denied
    })
    const service = makeService()
    registerComponentOffloadIpc({ ipcMain, assertMainWindow, service })

    for (const channel of Object.values(COMPONENT_OFFLOAD_IPC)) {
      expect(() => handlers.get(channel)?.(eventFrom({}), { componentId: 'whisper' })).toThrow(denied)
    }
    expect(service.preview).not.toHaveBeenCalled()
    expect(service.confirm).not.toHaveBeenCalled()
    expect(service.receipts).not.toHaveBeenCalled()

    await handlers.get(COMPONENT_OFFLOAD_IPC.preview)?.(trusted, { componentId: 'whisper' })
    await handlers.get(COMPONENT_OFFLOAD_IPC.confirm)?.(trusted, { planId: 'x' })
    await handlers.get(COMPONENT_OFFLOAD_IPC.receipts)?.(trusted)
    expect(service.preview).toHaveBeenCalledWith({ componentId: 'whisper' })
    expect(service.confirm).toHaveBeenCalledWith({ planId: 'x' })
    expect(service.receipts).toHaveBeenCalledOnce()
  })

  it('forwards malformed requests to the service, which rejects them', async () => {
    const { ipcMain, handlers } = makeIpc()
    const { createComponentOffloadService } = await import('../features/components/offload/service')
    const service = createComponentOffloadService({
      statuses: async () => [],
      target: () => null,
      captureActive: () => false,
      freeBytes: async () => null,
      receipts: { list: async () => [], append: async () => undefined }
    })
    registerComponentOffloadIpc({ ipcMain, assertMainWindow: vi.fn(), service })
    const trusted = eventFrom({})
    await expect(handlers.get(COMPONENT_OFFLOAD_IPC.preview)?.(trusted, { componentId: '../..' })).resolves.toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    await expect(handlers.get(COMPONENT_OFFLOAD_IPC.preview)?.(trusted, undefined)).resolves.toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    await expect(handlers.get(COMPONENT_OFFLOAD_IPC.confirm)?.(trusted, { planId: 5 })).resolves.toEqual({
      ok: false,
      reason: 'invalid-request'
    })
  })

  it('removes stale handlers on registration and cleanup removes all of them once', () => {
    const { ipcMain, handlers, removeHandler } = makeIpc()
    const cleanup = registerComponentOffloadIpc({ ipcMain, assertMainWindow: vi.fn(), service: makeService() })
    const channels = Object.values(COMPONENT_OFFLOAD_IPC)
    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual(channels)
    expect([...handlers.keys()].sort()).toEqual([...channels].sort())
    cleanup()
    cleanup()
    expect(handlers.size).toBe(0)
    expect(removeHandler).toHaveBeenCalledTimes(channels.length * 2)
  })
})
