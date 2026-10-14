import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import type { SpeechPackProgress } from '@shared/speech-pack'
import type { SpeechPackService } from '../features/components'
import { registerSpeechPackIpc } from './speech-pack-ipc'

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

describe('registerSpeechPackIpc', () => {
  beforeEach(() => vi.clearAllMocks())

  it('validates the sender before calling service methods and forwards the request', async () => {
    const { ipcMain, handlers } = makeIpc()
    const trusted = eventFrom({})
    const denied = new Error('denied')
    const assertMainWindow = vi.fn((event: IpcEvent) => {
      if (event !== trusted) throw denied
    })
    const snapshot = vi.fn(async () => ({ status: 'ready' }))
    const action = vi.fn(async (request: unknown) => ({ request }))
    const planPreview = vi.fn(async (request: unknown) => ({ request, plan: true }))
    const installWithPlan = vi.fn(async (request: unknown) => ({ request, installed: true }))
    const subscribe = vi.fn(() => vi.fn())
    const service = { snapshot, action, planPreview, installWithPlan, subscribe } as unknown as SpeechPackService

    registerSpeechPackIpc({
      ipcMain,
      assertMainWindow,
      sendProgress: vi.fn(),
      service
    })

    expect(snapshot).not.toHaveBeenCalled()
    expect(action).not.toHaveBeenCalled()
    expect(planPreview).not.toHaveBeenCalled()
    expect(installWithPlan).not.toHaveBeenCalled()
    expect(() => handlers.get(IPC.speechPackState)?.(eventFrom({}))).toThrow(denied)
    expect(snapshot).not.toHaveBeenCalled()
    expect(() => handlers.get(IPC.speechPackAction)?.(eventFrom({}), { consent: true })).toThrow(denied)
    expect(action).not.toHaveBeenCalled()
    expect(() => handlers.get(IPC.speechPackPlanPreview)?.(eventFrom({}), { componentId: 'x' })).toThrow(denied)
    expect(planPreview).not.toHaveBeenCalled()
    expect(() => handlers.get(IPC.speechPackInstallWithPlan)?.(eventFrom({}), { planId: 'x' })).toThrow(denied)
    expect(installWithPlan).not.toHaveBeenCalled()

    await expect(handlers.get(IPC.speechPackState)?.(trusted)).resolves.toEqual({ status: 'ready' })
    const request = { componentId: 'whisper-base-q8', action: 'download' }
    await expect(handlers.get(IPC.speechPackAction)?.(trusted, request)).resolves.toEqual({ request })
    expect(action).toHaveBeenCalledWith(request)
    await expect(handlers.get(IPC.speechPackPlanPreview)?.(trusted, request)).resolves.toEqual({ request, plan: true })
    await expect(handlers.get(IPC.speechPackInstallWithPlan)?.(trusted, request)).resolves.toEqual({
      request,
      installed: true
    })
    expect(planPreview).toHaveBeenCalledWith(request)
    expect(installWithPlan).toHaveBeenCalledWith(request)
    expect(assertMainWindow).toHaveBeenCalledTimes(8)
  })

  it('removes old handlers on registration and unsubscribes progress on cleanup', () => {
    const { ipcMain, handlers, removeHandler } = makeIpc()
    const unsubscribe = vi.fn()
    let listener: ((progress: SpeechPackProgress) => void) | undefined
    const service = {
      snapshot: vi.fn(),
      action: vi.fn(),
      planPreview: vi.fn(),
      installWithPlan: vi.fn(),
      subscribe: vi.fn((onProgress: (progress: SpeechPackProgress) => void) => {
        listener = onProgress
        return unsubscribe
      })
    } as unknown as SpeechPackService
    const sendProgress = vi.fn()
    const cleanup = registerSpeechPackIpc({
      ipcMain,
      assertMainWindow: vi.fn(),
      sendProgress,
      service
    })

    expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      IPC.speechPackState,
      IPC.speechPackAction,
      IPC.speechPackPlanPreview,
      IPC.speechPackInstallWithPlan
    ])
    expect(handlers.has(IPC.speechPackState)).toBe(true)
    expect(handlers.has(IPC.speechPackAction)).toBe(true)
    expect(handlers.has(IPC.speechPackPlanPreview)).toBe(true)
    expect(handlers.has(IPC.speechPackInstallWithPlan)).toBe(true)
    const progress: SpeechPackProgress = {
      componentId: 'asr.whisper-base-q8',
      manifestIdentity: 'a'.repeat(64),
      bytesDone: 0,
      bytesTotal: 1,
      state: 'paused'
    }
    listener?.(progress)
    expect(sendProgress).toHaveBeenCalledWith(progress)
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(removeHandler.mock.calls.slice(-4).map(([channel]) => channel)).toEqual([
      IPC.speechPackState,
      IPC.speechPackAction,
      IPC.speechPackPlanPreview,
      IPC.speechPackInstallWithPlan
    ])
  })

  it('continues cleanup and rethrows even an undefined first cleanup error', () => {
    const { ipcMain, removeHandler } = makeIpc()
    const unsubscribe = vi.fn()
    const service = {
      snapshot: vi.fn(),
      action: vi.fn(),
      planPreview: vi.fn(),
      installWithPlan: vi.fn(),
      subscribe: vi.fn(() => unsubscribe)
    } as unknown as SpeechPackService
    const cleanup = registerSpeechPackIpc({
      ipcMain,
      assertMainWindow: vi.fn(),
      sendProgress: vi.fn(),
      service
    })
    removeHandler.mockImplementationOnce(() => {
      throw undefined
    })

    let didThrow = false
    let thrown: unknown
    try {
      cleanup()
    } catch (error) {
      didThrow = true
      thrown = error
    }

    expect(didThrow).toBe(true)
    expect(thrown).toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(removeHandler.mock.calls.slice(-4).map(([channel]) => channel)).toEqual([
      IPC.speechPackState,
      IPC.speechPackAction,
      IPC.speechPackPlanPreview,
      IPC.speechPackInstallWithPlan
    ])
  })
})
