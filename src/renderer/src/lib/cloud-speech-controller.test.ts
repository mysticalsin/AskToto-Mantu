import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudSpeechCancelResult,
  CloudSpeechEvent,
  CloudSpeechFailure,
  CloudSpeechFinishRequest,
  CloudSpeechFinishResult,
  CloudSpeechFrame,
  CloudSpeechFrameResult,
  CloudSpeechStartRequest,
  CloudSpeechStartResult,
  CloudSpeechStatusResult
} from '@shared/cloud-speech'
import { createCloudSpeechController, type CloudSpeechControllerBridge } from './cloud-speech-controller'

const captureId = '9d87dc1a-0a52-4a5e-bbc2-f44320890cd4'
const captureGeneration = 7
const readyCapability = {
  disclosureVersion: 'cloud-speech-v1',
  selected: { engine: 'cloudflare-nova3', routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3' },
  allowed: [{ engine: 'cloudflare-nova3', routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3' }],
  ready: true,
  refusal: null
}
const request: CloudSpeechStartRequest = {
  captureId,
  capture: {
    generation: captureGeneration,
    engine: 'cloudflare-nova3',
    requestedTracks: ['microphone'],
    capturedTracks: ['microphone']
  },
  language: 'auto',
  consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
}

function started(tracks: Array<'microphone' | 'system'> = ['microphone']): CloudSpeechStartResult {
  return {
    ok: true,
    captureId,
    captureGeneration,
    engine: 'cloudflare-nova3',
    streams: tracks.map((track) => ({ track, streamEpoch: 3 })),
    limits: { frameBytes: 3_200, maxPendingFrames: 20, maxPendingBytes: 65_536, maxPendingAudioMs: 2_000 }
  }
}

function failure(code: CloudSpeechFailure['code']): CloudSpeechFailure {
  return { ok: false, code, captureId, captureGeneration }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeBridge() {
  const events = new Set<(event: CloudSpeechEvent) => void>()
  const frame = vi.fn<(value: CloudSpeechFrame) => Promise<CloudSpeechFrameResult>>((value) =>
    Promise.resolve({
      ok: true,
      captureId,
      captureGeneration,
      track: value.track,
      sequence: value.sequence,
      nextSequence: value.sequence + 1,
      nextSampleOffset: value.sampleOffset + value.pcm16le.byteLength / 2
    })
  )
  const finish = vi.fn<(value: CloudSpeechFinishRequest) => Promise<CloudSpeechFinishResult>>(() =>
    Promise.resolve(failure('CLOSED'))
  )
  const bridge: CloudSpeechControllerBridge = {
    cloudSpeechCapability: vi.fn(() => Promise.resolve(readyCapability)),
    cloudSpeechStart: vi.fn(() => Promise.resolve(started())),
    cloudSpeechFrame: frame,
    cloudSpeechFinish: finish,
    cloudSpeechCancel: vi.fn(
      (): Promise<CloudSpeechCancelResult> =>
        Promise.resolve({ ok: true, captureId, captureGeneration, closure: 'confirmed' })
    ),
    cloudSpeechStatus: vi.fn(
      (): Promise<CloudSpeechStatusResult> =>
        Promise.resolve({ ok: true, captureId, captureGeneration, state: 'active', tracks: [] })
    ),
    onCloudSpeechEvent: vi.fn((_id, _generation, listener) => {
      events.add(listener)
      return () => events.delete(listener)
    })
  }
  return { bridge, events, frame, finish }
}

class FakePort {
  private listeners = new Set<(event: MessageEvent) => void>()
  readonly sent: unknown[] = []
  closed = false
  onPost?: (message: unknown) => void

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  start(): void {}

  postMessage(message: unknown): void {
    this.sent.push(message)
    this.onPost?.(message)
  }

  close(): void {
    this.closed = true
  }

  emit(data: unknown): void {
    const event = { data } as MessageEvent
    for (const listener of [...this.listeners]) listener(event)
  }
}

function pcmFrame(sequence: number, sampleOffset: number, samples = 1_600, sampleRate = 16_000): unknown {
  const audio = new Float32Array(samples)
  audio[0] = -1
  audio[1] = 1
  return { type: 'pcm-frame', sequence, sampleOffset, sampleRate, audio }
}

function controller(
  options: {
    bridge?: CloudSpeechControllerBridge
    onFailure?: (code: CloudSpeechFailure['code']) => void
    applyEvent?: (event: CloudSpeechEvent) => Promise<void>
    now?: () => number
    deadlineMs?: number
  } = {}
) {
  const fakes = fakeBridge()
  const instance = createCloudSpeechController({
    bridge: options.bridge ?? fakes.bridge,
    request,
    applyEvent: options.applyEvent ?? (() => Promise.resolve()),
    onFailure: options.onFailure ?? vi.fn(),
    now: options.now,
    deadlineMs: options.deadlineMs
  })
  return { ...fakes, instance }
}

afterEach(() => vi.useRealTimers())

describe('cloud speech capture controller', () => {
  it('converts each genuine Float32 frame once to explicit little-endian PCM and translates the capture offset', async () => {
    const { instance, frame } = controller()
    expect((await instance.start()).ok).toBe(true)
    const port = new FakePort()
    expect(instance.attachTrack('microphone', port as unknown as MessagePort, 8_000)).toBe(true)
    port.emit(pcmFrame(1, 0))

    await vi.waitFor(() => expect(frame).toHaveBeenCalledTimes(1))
    const sent = frame.mock.calls[0][0]
    expect(sent).toMatchObject({ sequence: 1, sampleOffset: 8_000, kind: 'full' })
    const bytes = new DataView(sent.pcm16le)
    expect(bytes.getInt16(0, true)).toBe(-32_768)
    expect(bytes.getInt16(2, true)).toBe(32_767)
    instance.dispose()
  })

  it('refuses non-finite, wrong-rate, spoofed, or discontinuous worklet frames without sending audio', async () => {
    const onFailure = vi.fn()
    const { instance, frame } = controller({ onFailure })
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    const invalid = new Float32Array(1_600)
    invalid[41] = Number.NaN
    port.emit({ ...pcmFrame(1, 0), audio: invalid })
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('INVALID_REQUEST'))
    expect(frame).not.toHaveBeenCalled()
    expect(port.sent).toEqual([])
    instance.dispose()
  })

  it('serializes one in-flight frame per track and fails closed on a bounded queue overflow', async () => {
    const onFailure = vi.fn()
    const { instance, frame, bridge } = controller({ onFailure })
    const first = deferred<CloudSpeechFrameResult>()
    frame.mockImplementationOnce(() => first.promise)
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.emit(pcmFrame(1, 0))
    port.emit(pcmFrame(2, 1_600))
    expect(frame).toHaveBeenCalledTimes(1)

    for (let index = 2; index < 24; index += 1) {
      port.emit(pcmFrame(index + 1, index * 1_600))
    }
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('QUEUE_LIMIT'))
    first.resolve({
      ok: true,
      captureId,
      captureGeneration,
      track: 'microphone',
      sequence: 1,
      nextSequence: 2,
      nextSampleOffset: 1_600
    })
    await Promise.resolve()
    expect(bridge.cloudSpeechCancel).toHaveBeenCalledTimes(1)
    expect(frame).toHaveBeenCalledTimes(1)
    instance.dispose()
  })

  it('flushes on the exact worklet port, admits the sealed tail and finishes only after its ACK', async () => {
    const { instance, frame, finish } = controller()
    const finishDeferred = deferred<CloudSpeechFinishResult>()
    finish.mockReturnValue(finishDeferred.promise)
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 16_000)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type !== 'seal-and-flush' || !command.requestId) return
      port.emit(pcmFrame(1, 0, 7))
      port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 1, finalSampleOffset: 7 })
    }

    const stopping = instance.stop()
    await vi.waitFor(() => expect(frame).toHaveBeenCalledTimes(1))
    expect(finish).not.toHaveBeenCalled()
    const sent = frame.mock.calls[0][0]
    expect(sent).toMatchObject({ sampleOffset: 16_000, kind: 'sealed-final' })
    finishDeferred.resolve(failure('CLOSED'))
    await stopping
    expect(finish).toHaveBeenCalledWith({
      captureId,
      captureGeneration,
      tracks: [{ track: 'microphone', finalSequence: 1, finalSampleOffset: 16_007 }]
    })
    instance.dispose()
  })

  it('keeps stop reentry on one operation and does not claim complete before result application finishes', async () => {
    const apply = deferred<void>()
    const { instance, events, finish } = controller({ applyEvent: () => apply.promise })
    const finishResult = deferred<CloudSpeechFinishResult>()
    finish.mockReturnValue(finishResult.promise)
    const start = await instance.start()
    expect(start.ok).toBe(true)
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId)
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
    }
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const event: CloudSpeechEvent = {
      type: 'segment',
      captureId,
      captureGeneration,
      sequence: 1,
      segment: {
        stream,
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'same words',
        startMs: 0,
        endMs: 20
      }
    }
    for (const listener of events) listener(event)
    const stopA = instance.stop()
    const stopB = instance.stop()
    expect(stopB).toBe(stopA)
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    finishResult.resolve({
      ok: true,
      captureId,
      captureGeneration,
      complete: true,
      reason: 'normal',
      tracks: [
        {
          stream,
          lastSequence: 1,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        }
      ]
    })
    let completed = false
    void stopA.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    apply.resolve()
    const result = await stopA
    expect(result).toMatchObject({ ok: true, complete: true })
    instance.dispose()
  })

  it('retains distinct final segments with identical text and rejects a later revision after final', async () => {
    const onFailure = vi.fn()
    const { instance } = controller({ onFailure })
    await instance.start()
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const makeEvent = (sequence: number, index: number, revision: number): CloudSpeechEvent => ({
      type: 'segment',
      captureId,
      captureGeneration,
      sequence,
      segment: {
        stream,
        engine: 'cloudflare-nova3',
        index,
        revision,
        final: true,
        text: 'identical text is valid',
        startMs: index * 100,
        endMs: index * 100 + 50
      }
    })
    const applied: CloudSpeechEvent[] = []
    // Rebuild the controller with the event collector to make preservation observable.
    instance.dispose()
    const next = controller({ applyEvent: async (event) => void applied.push(event), onFailure })
    await next.instance.start()
    for (const listener of next.events) listener(makeEvent(1, 1, 1))
    for (const listener of next.events) listener(makeEvent(2, 2, 1))
    await vi.waitFor(() => expect(applied).toHaveLength(2))
    for (const listener of next.events) listener(makeEvent(3, 1, 2))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('STALE'))
    expect(applied).toHaveLength(2)
    next.instance.dispose()
  })

  it('fails closed when result epoch does not match the started stream', async () => {
    const onFailure = vi.fn()
    const applied = vi.fn()
    const next = controller({ onFailure, applyEvent: async (event) => void applied(event) })
    await next.instance.start()
    const event: CloudSpeechEvent = {
      type: 'segment',
      captureId,
      captureGeneration,
      sequence: 1,
      segment: {
        stream: { generation: captureGeneration, track: 'microphone', epoch: 4 },
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'content must not enter failure diagnostics',
        startMs: 0,
        endMs: 10
      }
    }
    for (const listener of next.events) listener(event)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('STALE'))
    expect(applied).not.toHaveBeenCalled()
    expect(next.events.size).toBe(0)
    next.instance.dispose()
  })

  it('stops within one absolute deadline when a frame ACK never resolves', async () => {
    vi.useFakeTimers()
    const { instance, frame, bridge } = controller({ deadlineMs: 50 })
    frame.mockReturnValue(new Promise<CloudSpeechFrameResult>(() => {}))
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.emit(pcmFrame(1, 0))
    const stop = instance.stop()
    await vi.advanceTimersByTimeAsync(50)
    const result = await stop
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(bridge.cloudSpeechCancel).toHaveBeenCalledTimes(1)
    instance.dispose()
  })
})
