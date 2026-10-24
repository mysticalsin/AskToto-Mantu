import { describe, expect, it, vi } from 'vitest'
import { DICTATION_STATUS_IPC } from '@shared/dictation-status'
import { VOICE_ACTIONS_IPC } from '@shared/voice/voice-turn'
import { registerVoiceActionsIpc } from './voice-actions-ipc'

function setup() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const assertMainWindow = vi.fn((event: unknown) => {
    if ((event as { trusted?: boolean }).trusted !== true) throw new Error('untrusted sender')
  })
  const runtime = {
    snapshot: vi.fn(() => ({
      revision: 3,
      state: 'idle' as const,
      turnId: null,
      reason: null,
      message: null,
      enabled: true,
      shortcut: 'running' as const
    })),
    report: vi.fn(() => ({ ok: true })),
    setChordRecorderActive: vi.fn(() => ({ ok: true })),
    dictationStatus: vi.fn(() => ({ revision: 4, state: 'idle' as const, message: null, enabled: true }))
  }
  registerVoiceActionsIpc(
    {
      handle: (channel: string, fn: (event: unknown, payload?: unknown) => unknown) => void handlers.set(channel, fn)
    } as never,
    assertMainWindow as never,
    runtime
  )
  const call = (channel: string, payload?: unknown, trusted = true) => handlers.get(channel)?.({ trusted }, payload)
  return { handlers, call, runtime }
}

describe('voice actions IPC', () => {
  it('registers exactly getState, report and the chord recorder flag (none of which can start a turn)', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(
      [
        VOICE_ACTIONS_IPC.getState,
        VOICE_ACTIONS_IPC.report,
        VOICE_ACTIONS_IPC.recorder,
        DICTATION_STATUS_IPC.getState
      ].sort()
    )
  })

  it('both handlers refuse a sender that is not the main window, before touching the runtime', () => {
    const { call, runtime } = setup()
    expect(() => call(VOICE_ACTIONS_IPC.getState, undefined, false)).toThrow('untrusted sender')
    expect(() => call(VOICE_ACTIONS_IPC.report, { turnId: 'x', phase: 'capturing' }, false)).toThrow('untrusted sender')
    expect(() => call(VOICE_ACTIONS_IPC.recorder, { active: true }, false)).toThrow('untrusted sender')
    expect(runtime.snapshot).not.toHaveBeenCalled()
    expect(runtime.report).not.toHaveBeenCalled()
    expect(runtime.setChordRecorderActive).not.toHaveBeenCalled()
  })

  it('getState returns the snapshot and report forwards the raw payload for the runtime to validate', () => {
    const { call, runtime } = setup()
    expect(call(VOICE_ACTIONS_IPC.getState)).toMatchObject({ revision: 3, state: 'idle' })
    expect(call(VOICE_ACTIONS_IPC.report, { turnId: 't1', phase: 'capturing' })).toEqual({ ok: true })
    expect(runtime.report).toHaveBeenCalledWith({ turnId: 't1', phase: 'capturing' })
  })

  it('the dictation status is read behind the main-window sender check', () => {
    const { call, runtime } = setup()
    expect(() => call(DICTATION_STATUS_IPC.getState, undefined, false)).toThrow('untrusted sender')
    expect(runtime.dictationStatus).not.toHaveBeenCalled()
    expect(call(DICTATION_STATUS_IPC.getState)).toEqual({ revision: 4, state: 'idle', message: null, enabled: true })
  })

  it('the recorder flag forwards the raw payload for the runtime to validate', () => {
    const { call, runtime } = setup()
    expect(call(VOICE_ACTIONS_IPC.recorder, { active: true })).toEqual({ ok: true })
    expect(runtime.setChordRecorderActive).toHaveBeenCalledWith({ active: true })
  })
})
