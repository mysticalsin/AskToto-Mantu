import { describe, expect, it, vi } from 'vitest'
import { SPOKEN_REPLIES_IPC } from '@shared/spoken-replies'
import { registerSpokenRepliesIpc } from './spoken-replies-ipc'

function setup() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const assertMainWindow = vi.fn((event: unknown) => {
    if ((event as { trusted?: boolean }).trusted !== true) throw new Error('untrusted sender')
  })
  const runtime = {
    snapshot: vi.fn(() => ({ revision: 1, available: true, playback: 'idle' as const, muted: null, generation: 2 })),
    listVoices: vi.fn(async () => [{ id: 'v1', name: 'One', language: 'en-US' }]),
    preview: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn()
  }
  registerSpokenRepliesIpc(
    {
      handle: (channel: string, fn: (event: unknown, payload?: unknown) => unknown) => void handlers.set(channel, fn)
    } as never,
    assertMainWindow as never,
    runtime
  )
  const call = (channel: string, payload?: unknown, trusted = true) => handlers.get(channel)?.({ trusted }, payload)
  return { handlers, call, runtime }
}

describe('spoken replies IPC (G27)', () => {
  it('registers exactly state, voices, preview and stop: no handler takes text to speak', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(
      [
        SPOKEN_REPLIES_IPC.getState,
        SPOKEN_REPLIES_IPC.voices,
        SPOKEN_REPLIES_IPC.preview,
        SPOKEN_REPLIES_IPC.stop
      ].sort()
    )
  })

  it('every handler refuses a sender that is not the main window, before touching the runtime', () => {
    const { call, runtime } = setup()
    for (const channel of [
      SPOKEN_REPLIES_IPC.getState,
      SPOKEN_REPLIES_IPC.voices,
      SPOKEN_REPLIES_IPC.preview,
      SPOKEN_REPLIES_IPC.stop
    ]) {
      expect(() => call(channel, {}, false), channel).toThrow('untrusted sender')
    }
    expect(runtime.snapshot).not.toHaveBeenCalled()
    expect(runtime.listVoices).not.toHaveBeenCalled()
    expect(runtime.preview).not.toHaveBeenCalled()
    expect(runtime.stop).not.toHaveBeenCalled()
  })

  it('returns the state, the approved voices and stops on request', async () => {
    const { call, runtime } = setup()
    expect(call(SPOKEN_REPLIES_IPC.getState)).toMatchObject({ available: true, generation: 2 })
    await expect(call(SPOKEN_REPLIES_IPC.voices)).resolves.toEqual([{ id: 'v1', name: 'One', language: 'en-US' }])
    call(SPOKEN_REPLIES_IPC.stop)
    expect(runtime.stop).toHaveBeenCalledTimes(1)
  })

  it('previews with a validated voice and rate only, and refuses anything else', async () => {
    const { call, runtime } = setup()
    await expect(call(SPOKEN_REPLIES_IPC.preview, { voiceId: 'v1', rate: 1.2 })).resolves.toEqual({ ok: true })
    expect(runtime.preview).toHaveBeenCalledWith({ voiceId: 'v1', rate: 1.2 })
    await expect(call(SPOKEN_REPLIES_IPC.preview, { text: 'read the transcript aloud' })).resolves.toEqual({
      ok: false
    })
    await expect(call(SPOKEN_REPLIES_IPC.preview, 'nope')).resolves.toEqual({ ok: false })
    await expect(call(SPOKEN_REPLIES_IPC.preview, { rate: Number.NaN })).resolves.toEqual({ ok: false })
    expect(runtime.preview).toHaveBeenCalledTimes(1)
  })

  it('a preview that fails is reported as not ok without the reason leaking an error', async () => {
    const { call, runtime } = setup()
    runtime.preview.mockResolvedValueOnce({ ok: false, reason: 'meeting' } as never)
    await expect(call(SPOKEN_REPLIES_IPC.preview, {})).resolves.toEqual({ ok: false })
  })
})
