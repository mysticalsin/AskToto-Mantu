import { describe, expect, it, vi } from 'vitest'
import { CLOUD_CAPTURE_WORKLET_SRC } from './cloud-capture-worklet-src'

function instantiate(sampleRate: number): {
  proc: {
    process: (inputs: Float32Array[][]) => boolean
    port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> }
  }
} {
  let ctor: (new () => unknown) | null = null
  class FakeAudioWorkletProcessor {
    port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', CLOUD_CAPTURE_WORKLET_SRC)(
    FakeAudioWorkletProcessor,
    (_name: string, klass: new () => unknown) => {
      ctor = klass
    },
    sampleRate
  )
  if (!ctor) throw new Error('cloud capture worklet did not register')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { proc: new ctor() as any }
}

describe('cloud capture worklet', () => {
  it('emits contiguous non-overlapping 100 ms frames and seals the exact final offset', () => {
    const { proc } = instantiate(16_000)
    proc.process([[new Float32Array(2_048).fill(0.25)]])
    proc.process([[new Float32Array(1_952).fill(-0.25)]])

    expect(proc.port.postMessage).toHaveBeenCalledTimes(2)
    expect(proc.port.postMessage.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({ type: 'pcm-frame', sequence: 1, sampleOffset: 0, audio: expect.any(Float32Array) }),
      expect.objectContaining({ type: 'pcm-frame', sequence: 2, sampleOffset: 1_600, audio: expect.any(Float32Array) })
    ])
    expect((proc.port.postMessage.mock.calls[0][0] as { audio: Float32Array }).audio).toHaveLength(1_600)
    expect((proc.port.postMessage.mock.calls[1][0] as { audio: Float32Array }).audio).toHaveLength(1_600)

    proc.process([[new Float32Array(321).fill(0.5)]])
    proc.port.onmessage?.({ data: { type: 'seal-and-flush', requestId: 'flush-1' } })

    expect(proc.port.postMessage).toHaveBeenCalledTimes(4)
    expect(proc.port.postMessage.mock.calls[2][0]).toMatchObject({
      type: 'pcm-frame',
      sequence: 3,
      sampleOffset: 3_200,
      audio: expect.any(Float32Array)
    })
    expect((proc.port.postMessage.mock.calls[2][0] as { audio: Float32Array }).audio).toHaveLength(321)
    expect(proc.port.postMessage.mock.calls[3][0]).toEqual({
      type: 'flush-ack',
      requestId: 'flush-1',
      finalSequence: 3,
      finalSampleOffset: 3_521
    })

    proc.process([[new Float32Array(4).fill(1)]])
    expect(proc.port.postMessage).toHaveBeenCalledTimes(4)
  })

  it('resamples actual input rate while preserving cumulative output offsets', () => {
    const { proc } = instantiate(48_000)
    proc.process([[new Float32Array(4_800).fill(0.1)]])
    proc.port.onmessage?.({ data: { type: 'seal-and-flush', requestId: 'flush-2' } })

    expect(proc.port.postMessage.mock.calls.map(([message]) => (message as { type: string }).type)).toEqual([
      'pcm-frame',
      'pcm-frame',
      'pcm-frame',
      'flush-ack'
    ])
    expect(proc.port.postMessage.mock.calls[2][0]).toMatchObject({
      sequence: 3,
      sampleOffset: 3_200,
      audio: expect.any(Float32Array)
    })
    expect((proc.port.postMessage.mock.calls[2][0] as { audio: Float32Array }).audio).toHaveLength(800)
    expect(proc.port.postMessage.mock.calls[3][0]).toMatchObject({ finalSequence: 3, finalSampleOffset: 4_000 })
  })
})
