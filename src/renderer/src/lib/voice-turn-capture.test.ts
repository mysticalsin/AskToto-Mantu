import { describe, expect, it, vi } from 'vitest'
import type { VoiceBegin, VoiceEnd, VoiceReport } from '@shared/voice/voice-turn'
import type { CommandMicSnapshot } from './use-command-mic'
import { installVoiceTurnCapture } from './voice-turn-capture'

function setup() {
  let beginCb: ((p: VoiceBegin) => void) | null = null
  let endCb: ((p: VoiceEnd) => void) | null = null
  const reports: VoiceReport[] = []
  const controllers: Array<ReturnType<typeof makeController>> = []
  function makeController(options: { maxDurationMs: number; onSnapshot: (s: CommandMicSnapshot) => void }) {
    const controller = {
      options,
      start: vi.fn(async (_o?: { source?: string }) => {}),
      finish: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(),
      emit: (s: CommandMicSnapshot) => options.onSnapshot(s)
    }
    controllers.push(controller)
    return controller
  }
  const uninstall = installVoiceTurnCapture({
    onBegin: (cb) => {
      beginCb = cb
      return () => void (beginCb = null)
    },
    onEnd: (cb) => {
      endCb = cb
      return () => void (endCb = null)
    },
    report: vi.fn(async (r: VoiceReport) => void reports.push(r)),
    createController: makeController
  })
  return {
    uninstall,
    reports,
    controllers,
    begin: (p: VoiceBegin = { turnId: 't1', maxMs: 15_000 }) => beginCb?.(p),
    end: (p: VoiceEnd) => endCb?.(p),
    subscribed: () => beginCb !== null && endCb !== null
  }
}

describe('voice turn capture in the renderer', () => {
  it('opens nothing until main pushes a begin', () => {
    const h = setup()
    expect(h.subscribed()).toBe(true)
    expect(h.controllers).toHaveLength(0)
  })

  it('a begin starts one push-to-talk capture capped at the turn length, and reports capturing once listening', () => {
    const h = setup()
    h.begin()
    expect(h.controllers).toHaveLength(1)
    expect(h.controllers[0]?.options.maxDurationMs).toBe(15_000)
    expect(h.controllers[0]?.start).toHaveBeenCalledExactlyOnceWith({ source: 'push-to-talk' })
    expect(h.reports).toEqual([])
    h.controllers[0]?.emit({ status: 'starting' })
    h.controllers[0]?.emit({ status: 'listening' })
    expect(h.reports).toEqual([{ turnId: 't1', phase: 'capturing' }])
  })

  it('a release while listening finishes the capture', () => {
    const h = setup()
    h.begin()
    h.controllers[0]?.emit({ status: 'listening' })
    h.end({ turnId: 't1', cancelled: false })
    expect(h.controllers[0]?.finish).toHaveBeenCalledOnce()
  })

  it('a release that arrives while the microphone is still opening finishes as soon as it is listening', () => {
    const h = setup()
    h.begin()
    h.controllers[0]?.emit({ status: 'starting' })
    h.end({ turnId: 't1', cancelled: false })
    expect(h.controllers[0]?.finish).not.toHaveBeenCalled()
    h.controllers[0]?.emit({ status: 'listening' })
    expect(h.controllers[0]?.finish).toHaveBeenCalledOnce()
  })

  it('a cancel discards the capture and never finishes it', () => {
    const h = setup()
    h.begin()
    h.controllers[0]?.emit({ status: 'listening' })
    h.end({ turnId: 't1', cancelled: true })
    expect(h.controllers[0]?.cancel).toHaveBeenCalledOnce()
    expect(h.controllers[0]?.finish).not.toHaveBeenCalled()
    expect(h.controllers[0]?.dispose).toHaveBeenCalled()
  })

  it('an end for another turn is ignored', () => {
    const h = setup()
    h.begin()
    h.end({ turnId: 'other', cancelled: true })
    h.end({ turnId: 'other', cancelled: false })
    expect(h.controllers[0]?.cancel).not.toHaveBeenCalled()
    expect(h.controllers[0]?.finish).not.toHaveBeenCalled()
  })

  it.each([
    ['microphone_unavailable', 'microphone_unavailable'],
    ['activation_required', 'activation_required'],
    ['unsupported_engine', 'speech_unavailable'],
    ['policy_blocked', 'policy_blocked']
  ] as const)('a capture error before release (%s) is reported to main as %s', (reason, expected) => {
    const h = setup()
    h.begin()
    h.controllers[0]?.emit({ status: 'error', reason })
    expect(h.reports).toEqual([{ turnId: 't1', phase: 'failed', reason: expected }])
    expect(h.controllers[0]?.dispose).toHaveBeenCalled()
  })

  it('an error after the capture was sealed is not reported: main already knows from its own recognition', () => {
    const h = setup()
    h.begin()
    h.controllers[0]?.emit({ status: 'listening' })
    h.end({ turnId: 't1', cancelled: false })
    h.controllers[0]?.emit({ status: 'error', reason: 'no_speech' })
    expect(h.reports).toEqual([{ turnId: 't1', phase: 'capturing' }])
  })

  it('cancelled and timeout stops are not failures to report', () => {
    const h = setup()
    h.begin()
    h.controllers[0]?.emit({ status: 'error', reason: 'cancelled' })
    h.begin({ turnId: 't2', maxMs: 15_000 })
    h.controllers[1]?.emit({ status: 'error', reason: 'timeout' })
    expect(h.reports).toEqual([])
  })

  it('a new begin tears down the previous capture first, and a stale snapshot from it is ignored', () => {
    const h = setup()
    h.begin()
    h.begin({ turnId: 't2', maxMs: 15_000 })
    expect(h.controllers[0]?.cancel).toHaveBeenCalledOnce()
    expect(h.controllers[0]?.dispose).toHaveBeenCalled()
    h.controllers[0]?.emit({ status: 'listening' })
    expect(h.reports).toEqual([])
    h.controllers[1]?.emit({ status: 'listening' })
    expect(h.reports).toEqual([{ turnId: 't2', phase: 'capturing' }])
  })

  it('uninstalling unsubscribes and cancels a live capture', () => {
    const h = setup()
    h.begin()
    h.uninstall()
    expect(h.subscribed()).toBe(false)
    expect(h.controllers[0]?.cancel).toHaveBeenCalledOnce()
    expect(h.controllers[0]?.dispose).toHaveBeenCalled()
  })
})
