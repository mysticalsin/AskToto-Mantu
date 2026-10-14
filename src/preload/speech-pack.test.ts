import { describe, expect, it, vi } from 'vitest'
import { createSpeechPackBridge } from './speech-pack'
import { IPC } from '../shared/ipc'

const request = {
  componentId: 'asr.whisper-base-q8' as const,
  action: 'download' as const,
  manifestIdentity: 'a'.repeat(64)
}

describe('speech-pack preload boundary', () => {
  it('sanitizes rejected native transport errors for both request methods', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('/private/model https://example.invalid/?token=private'))
    const bridge = createSpeechPackBridge({ invoke, subscribe: vi.fn() })
    await expect(bridge.speechPackState()).rejects.toThrow(/^Invalid speech pack response$/)
    await expect(bridge.speechPackAction(request)).rejects.toThrow(/^Invalid speech pack response$/)
  })
  it('rejects invalid requests before invoking main', async () => {
    const invoke = vi.fn()
    const bridge = createSpeechPackBridge({ invoke, subscribe: vi.fn() })
    expect(await bridge.speechPackAction({ ...request, url: 'https://example.com' } as typeof request)).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('uses the fixed action channel and validates its result', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    const bridge = createSpeechPackBridge({ invoke, subscribe: vi.fn() })
    expect(await bridge.speechPackAction(request)).toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith(IPC.speechPackAction, request)
    invoke.mockResolvedValue({ ok: true, path: '/private/model' })
    await expect(bridge.speechPackAction(request)).rejects.toThrow('Invalid speech pack response')
  })

  it('rejects invalid status with a fixed message and no private response contents', async () => {
    const invoke = vi.fn().mockResolvedValue({ nativeError: '/private/model' })
    const bridge = createSpeechPackBridge({ invoke, subscribe: vi.fn() })
    await expect(bridge.speechPackState()).rejects.toThrow('Invalid speech pack response')
    expect(invoke).toHaveBeenCalledWith(IPC.speechPackState)
  })

  it('filters malformed progress and preserves unsubscribe ownership', () => {
    let receive: (value: unknown) => void = () => {}
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_channel: string, callback: (value: unknown) => void) => {
      receive = callback
      return unsubscribe
    })
    const bridge = createSpeechPackBridge({ invoke: vi.fn(), subscribe })
    const listener = vi.fn()
    const stop = bridge.onSpeechPackProgress(listener)
    receive({ ...request, state: 'downloading', bytesDone: 1, bytesTotal: 10 })
    expect(listener).not.toHaveBeenCalled()
    const progress = {
      componentId: request.componentId,
      manifestIdentity: request.manifestIdentity,
      state: 'downloading',
      bytesDone: 1,
      bytesTotal: 10
    }
    receive(progress)
    expect(listener).toHaveBeenCalledWith(progress)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribe.mock.calls[0][0]).toBe(IPC.speechPackProgress)
  })
})
