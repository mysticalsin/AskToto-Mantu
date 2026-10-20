import { describe, expect, it, vi } from 'vitest'
import { CLOUD_SPEECH_IPC, CloudSpeechEventSchema } from '../../shared/cloud-speech'
import { createCaptureLifecycle } from './cloud-speech-capture-lifecycle'
import type { CaptureLifecycleContext } from './cloud-speech-ipc-context'
import type { Authority, Owner } from './cloud-speech-ipc-support'

const CAPTURE = '22222222-2222-4222-8222-222222222222'

const segment = {
  type: 'segment',
  captureId: CAPTURE,
  captureGeneration: 1,
  sequence: 1,
  segment: {
    stream: { generation: 1, track: 'microphone', epoch: 1 },
    engine: 'deepgram-nova3',
    index: 1,
    revision: 1,
    final: true,
    text: 'hello',
    startMs: 0,
    endMs: 400
  }
}

function setup(options: { phase?: Owner['phase']; sendThrows?: boolean; observerThrows?: boolean } = {}) {
  const send = vi.fn(() => {
    if (options.sendThrows) throw new Error('destroyed')
  })
  const owner = {
    phase: options.phase ?? 'active',
    binding: { sender: { send } },
    pendingEvents: [],
    pendingEventBytes: 0
  } as unknown as Owner
  const onDelivered = vi.fn(() => {
    if (options.observerThrows) throw new Error('observer failure')
  })
  const context: CaptureLifecycleContext = {
    state: { current: owner },
    now: () => 1,
    monotonicNow: () => 1,
    schedule: (() => () => undefined) as unknown as CaptureLifecycleContext['schedule'],
    currentAuthority: () => ({}) as Authority,
    retire: vi.fn(async () => 'confirmed' as const),
    onDelivered
  }
  return { lifecycle: createCaptureLifecycle(context), owner, send, onDelivered, retire: context.retire }
}

describe('cloud speech delivered-segment observer', () => {
  it('observes a segment only after it was sent to the owning renderer', () => {
    const { lifecycle, owner, send, onDelivered } = setup()
    expect(lifecycle.sendEvent(owner, segment)).toBe(true)
    expect(send).toHaveBeenCalledWith(CLOUD_SPEECH_IPC.event, expect.objectContaining({ type: 'segment' }))
    expect(onDelivered).toHaveBeenCalledTimes(1)
    expect(onDelivered).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'segment', sequence: 1 }))
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(onDelivered.mock.invocationCallOrder[0])
  })

  it('does not observe buffered, failed or invalid deliveries', () => {
    const starting = setup({ phase: 'starting' })
    expect(starting.lifecycle.sendEvent(starting.owner, segment)).toBe(true)
    expect(starting.send).not.toHaveBeenCalled()
    expect(starting.onDelivered).not.toHaveBeenCalled()

    const failing = setup({ sendThrows: true })
    expect(failing.lifecycle.sendEvent(failing.owner, segment)).toBe(false)
    expect(failing.onDelivered).not.toHaveBeenCalled()

    const invalid = setup()
    expect(invalid.lifecycle.sendEvent(invalid.owner, { ...segment, captureId: 'not-a-uuid' })).toBe(false)
    expect(invalid.onDelivered).not.toHaveBeenCalled()
  })

  it('a throwing observer never changes delivery or retires the owner', () => {
    const { lifecycle, owner, send, retire } = setup({ observerThrows: true })
    expect(lifecycle.sendEvent(owner, segment)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(retire).not.toHaveBeenCalled()
  })

  it('observes a delivered terminal event too', () => {
    const terminal = CloudSpeechEventSchema.parse({
      type: 'terminal',
      captureId: CAPTURE,
      captureGeneration: 1,
      stream: { generation: 1, track: 'microphone', epoch: 1 },
      lastSequence: 1,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    })
    const { lifecycle, owner, send, onDelivered } = setup()
    expect(lifecycle.sendEvent(owner, terminal)).toBe(true)
    expect(send).toHaveBeenCalledWith(CLOUD_SPEECH_IPC.event, expect.objectContaining({ type: 'terminal' }))
    expect(onDelivered).toHaveBeenCalledTimes(1)
    expect(onDelivered).toHaveBeenCalledWith(owner, expect.objectContaining({ type: 'terminal' }))
  })
})
