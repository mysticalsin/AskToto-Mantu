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

function pcmFrame(
  sequence: number,
  sampleOffset: number,
  samples = 1_600,
  sampleRate = 16_000
): { type: 'pcm-frame'; sequence: number; sampleOffset: number; sampleRate: number; audio: Float32Array } {
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

  it('refuses non-finite worklet samples without sending audio', async () => {
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

  it.each([
    ['wrong sample rate', () => pcmFrame(1, 0, 1_600, 44_100)],
    ['partial frame before sealing', () => pcmFrame(1, 0, 12)],
    ['sequence gap', () => pcmFrame(2, 0)],
    ['sample offset gap', () => pcmFrame(1, 1)]
  ])('fails closed on a %s before any audio is sent', async (_label, makeMessage) => {
    const onFailure = vi.fn()
    const { instance, frame } = controller({ onFailure })
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.emit(makeMessage())

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('INVALID_REQUEST'))
    expect(frame).not.toHaveBeenCalled()
    instance.dispose()
  })

  it('rejects a byte-length lookalike instead of trusting renderer-controlled audio metadata', async () => {
    const onFailure = vi.fn()
    const { instance, frame } = controller({ onFailure })
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.emit({
      type: 'pcm-frame',
      sequence: 1,
      sampleOffset: 0,
      sampleRate: 16_000,
      audio: { length: 1_600, byteLength: 6_400 }
    })

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('INVALID_REQUEST'))
    expect(frame).not.toHaveBeenCalled()
    instance.dispose()
  })

  it('serializes one in-flight frame per track and fails closed on a bounded queue overflow', async () => {
    let port: FakePort | undefined
    const onFailure = vi.fn(() => port?.emit(pcmFrame(25, 38_400)))
    const { instance, frame, bridge } = controller({ onFailure })
    const first = deferred<CloudSpeechFrameResult>()
    frame.mockImplementationOnce(() => first.promise)
    await instance.start()
    const testPort = new FakePort()
    port = testPort
    instance.attachTrack('microphone', testPort as unknown as MessagePort, 0)
    testPort.emit(pcmFrame(1, 0))
    testPort.emit(pcmFrame(2, 1_600))
    expect(frame).toHaveBeenCalledTimes(1)

    for (let index = 2; index < 24; index += 1) {
      testPort.emit(pcmFrame(index + 1, index * 1_600))
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

  it('admits exactly the configured two-second queue and checks age again after an awaited ACK', async () => {
    const onFailure = vi.fn()
    const { instance, frame } = controller({ onFailure })
    const first = deferred<CloudSpeechFrameResult>()
    frame.mockImplementationOnce(() => first.promise)
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      port.emit(pcmFrame(sequence, (sequence - 1) * 1_600))
    }
    expect(frame).toHaveBeenCalledTimes(1)
    expect(onFailure).not.toHaveBeenCalled()

    first.resolve({
      ok: true,
      captureId,
      captureGeneration,
      track: 'microphone',
      sequence: 1,
      nextSequence: 2,
      nextSampleOffset: 1_600
    })
    await vi.waitFor(() => expect(frame).toHaveBeenCalledTimes(20))
    expect(onFailure).not.toHaveBeenCalled()
    instance.dispose()

    let clock = 0
    const stale = controller({ now: () => clock, onFailure })
    const delayedAck = deferred<CloudSpeechFrameResult>()
    stale.frame.mockImplementationOnce(() => delayedAck.promise)
    await stale.instance.start()
    const stalePort = new FakePort()
    stale.instance.attachTrack('microphone', stalePort as unknown as MessagePort, 0)
    stalePort.emit(pcmFrame(1, 0))
    stalePort.emit(pcmFrame(2, 1_600))
    clock = 2_001
    delayedAck.resolve({
      ok: true,
      captureId,
      captureGeneration,
      track: 'microphone',
      sequence: 1,
      nextSequence: 2,
      nextSampleOffset: 1_600
    })
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('QUEUE_STALE'))
    expect(stale.frame).toHaveBeenCalledTimes(1)
    stale.instance.dispose()
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

  it('preserves an exact full-frame boundary and sends no empty tail', async () => {
    const { instance, frame, finish } = controller()
    finish.mockResolvedValue(failure('CLOSED'))
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 32_000)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId)
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 1, finalSampleOffset: 1_600 })
    }
    port.emit(pcmFrame(1, 0))
    const stopping = instance.stop()
    await vi.waitFor(() => expect(frame).toHaveBeenCalledTimes(1))
    expect(frame.mock.calls[0][0]).toMatchObject({ kind: 'full', pcm16le: new ArrayBuffer(3_200) })
    await stopping
    expect(finish).toHaveBeenCalledWith({
      captureId,
      captureGeneration,
      tracks: [{ track: 'microphone', finalSequence: 1, finalSampleOffset: 33_600 }]
    })
    instance.dispose()
  })

  it('accepts the largest legal sealed remainder as one final PCM frame', async () => {
    const { instance, frame, finish } = controller()
    finish.mockResolvedValue(failure('CLOSED'))
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId) {
        port.emit(pcmFrame(1, 0, 1_599))
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 1, finalSampleOffset: 1_599 })
      }
    }

    const stopping = instance.stop()
    await vi.waitFor(() => expect(frame).toHaveBeenCalledTimes(1))
    expect(frame.mock.calls[0][0].kind).toBe('sealed-final')
    expect(frame.mock.calls[0][0].pcm16le.byteLength).toBe(3_198)
    await stopping
    expect(finish).toHaveBeenCalledWith({
      captureId,
      captureGeneration,
      tracks: [{ track: 'microphone', finalSequence: 1, finalSampleOffset: 1_599 }]
    })
    instance.dispose()
  })

  it('rejects any PCM after the single sealed-final remainder, before flush acknowledgement', async () => {
    const onFailure = vi.fn()
    const { instance, frame } = controller({ onFailure })
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type !== 'seal-and-flush' || !command.requestId) return
      port.emit(pcmFrame(1, 0, 7))
      port.emit(pcmFrame(2, 7, 9))
      port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 1, finalSampleOffset: 7 })
    }

    const result = await instance.stop()
    expect(result).toMatchObject({ ok: false, code: 'ORDER' })
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(frame).toHaveBeenCalledTimes(1)
    instance.dispose()
  })

  it('keeps a nonzero track origin out of an empty track finish checkpoint', async () => {
    const { instance, finish } = controller()
    finish.mockResolvedValue(failure('CLOSED'))
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 48_000)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId)
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
    }

    await instance.stop()
    expect(finish).toHaveBeenCalledWith({
      captureId,
      captureGeneration,
      tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }]
    })
    instance.dispose()
  })

  it('never retries a frame after an ambiguous bridge failure', async () => {
    const onFailure = vi.fn()
    const { instance, frame, bridge } = controller({ onFailure })
    frame.mockRejectedValueOnce(new Error('private transport detail'))
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.emit(pcmFrame(1, 0))
    port.emit(pcmFrame(2, 1_600))

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('TRANSPORT'))
    await Promise.resolve()
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(frame).toHaveBeenCalledTimes(1)
    expect(bridge.cloudSpeechCancel).toHaveBeenCalledTimes(1)
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

  it('accepts the next public stream epoch only after the prior epoch terminal and keeps epoch-scoped revisions', async () => {
    const onFailure = vi.fn()
    const applied: CloudSpeechEvent[] = []
    const next = controller({ applyEvent: async (event) => void applied.push(event), onFailure })
    await next.instance.start()
    const oldStream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const newStream = { ...oldStream, epoch: 4 }
    for (const listener of next.events) {
      listener({
        type: 'terminal',
        captureId,
        captureGeneration,
        stream: oldStream,
        lastSequence: 0,
        closeConfirmed: true,
        tail: 'complete',
        reason: 'normal'
      })
      listener({
        type: 'segment',
        captureId,
        captureGeneration,
        sequence: 1,
        segment: {
          stream: newStream,
          engine: 'cloudflare-nova3',
          index: 1,
          revision: 1,
          final: true,
          text: 'same words after renewal are a new stream result',
          startMs: 100,
          endMs: 150
        }
      })
    }
    await vi.waitFor(() => expect(applied).toHaveLength(2))
    expect(onFailure).not.toHaveBeenCalled()

    for (const listener of next.events) {
      listener({
        type: 'segment',
        captureId,
        captureGeneration,
        sequence: 1,
        segment: {
          stream: oldStream,
          engine: 'cloudflare-nova3',
          index: 2,
          revision: 1,
          final: true,
          text: 'late old-epoch result',
          startMs: 200,
          endMs: 210
        }
      })
    }
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

  it('uses closed status only as an incomplete recovery when finish cannot prove the result frontier', async () => {
    const { instance, bridge, finish } = controller()
    finish.mockResolvedValue(failure('CLOSURE_UNCONFIRMED'))
    bridge.cloudSpeechStatus = vi.fn(() =>
      Promise.resolve({
        ok: true,
        captureId,
        captureGeneration,
        state: 'closed',
        tracks: [
          {
            stream: { generation: captureGeneration, track: 'microphone', epoch: 3 },
            lastSequence: 1,
            closeConfirmed: true,
            tail: 'complete',
            reason: 'normal'
          }
        ]
      })
    )
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId)
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
    }

    const result = await instance.stop()
    expect(result).toMatchObject({ ok: true, complete: false, reason: 'incomplete' })
    expect(bridge.cloudSpeechStatus).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      tracks: [{ stream: { generation: captureGeneration, track: 'microphone', epoch: 3 }, tail: 'incomplete' }]
    })
    instance.dispose()
  })
})
