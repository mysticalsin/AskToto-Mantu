import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudSpeechCancelResult,
  CloudSpeechCaptureCeilingEvent,
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
  const acknowledgeEpochTransition = vi.fn(
    (value: Parameters<CloudSpeechControllerBridge['cloudSpeechAckEpochTransition']>[0]) =>
      Promise.resolve({
        ok: true as const,
        captureId: value.captureId,
        captureGeneration: value.captureGeneration,
        transitionId: value.transitionId,
        handoffNonce: value.handoffNonce,
        stage: value.stage
      })
  )
  const acknowledgeCaptureCeiling = vi.fn(
    (value: Parameters<CloudSpeechControllerBridge['cloudSpeechAckCaptureCeiling']>[0]) =>
      Promise.resolve({
        ok: true as const,
        captureId: value.captureId,
        captureGeneration: value.captureGeneration,
        ceilingId: value.ceilingId,
        tracks: value.tracks
      })
  )
  const bridge: CloudSpeechControllerBridge = {
    cloudSpeechCapability: vi.fn(() => Promise.resolve(readyCapability)),
    cloudSpeechStart: vi.fn(() => Promise.resolve(started())),
    cloudSpeechFrame: frame,
    cloudSpeechFinish: finish,
    cloudSpeechAckEpochTransition: acknowledgeEpochTransition,
    cloudSpeechAckCaptureCeiling: acknowledgeCaptureCeiling,
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
  return { bridge, events, frame, finish, acknowledgeEpochTransition, acknowledgeCaptureCeiling }
}

class FakePort {
  private listeners = new Set<(event: MessageEvent) => void>()
  readonly sent: unknown[] = []
  closed = false
  startFailure?: Error
  onPost?: (message: unknown) => void

  get listenerCount(): number {
    return this.listeners.size
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  start(): void {
    if (this.startFailure) throw this.startFailure
  }

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
    onStopped?: (identity: { captureId: string; captureGeneration: number }, reason: 'user' | 'ceiling') => void
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
    onStopped: options.onStopped,
    now: options.now,
    deadlineMs: options.deadlineMs
  })
  return { ...fakes, instance }
}

afterEach(() => vi.useRealTimers())

describe('cloud speech capture controller', () => {
  it('seals once at capture ceiling, ACKs the exact frontier, and tears down the current identity', async () => {
    const stopped = vi.fn()
    const next = controller({ onStopped: stopped })
    next.finish.mockResolvedValue({
      ok: true,
      captureId,
      captureGeneration,
      complete: true,
      reason: 'normal',
      tracks: [
        {
          stream: { generation: captureGeneration, track: 'microphone', epoch: 3 },
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        }
      ]
    })
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        const command = message as { requestId: string }
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
      }
    }
    // A positive stream origin with no emitted PCM still has the exact empty
    // capture frontier 0/0; the origin is not evidence that samples exist.
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 48_000)).toBe(true)
    const ceiling: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration,
      ceilingId: '00000000-0000-4000-8000-000000000704',
      maxSampleOffsetExclusive: 230_400_000
    }
    for (const listener of next.events) listener(ceiling)
    for (const listener of next.events) listener(ceiling)
    await vi.waitFor(() => expect(next.acknowledgeCaptureCeiling).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(next.finish).toHaveBeenCalledTimes(1))
    expect(port.sent).toEqual([{ type: 'seal-and-flush', requestId: expect.any(String) }])
    expect(next.acknowledgeCaptureCeiling).toHaveBeenCalledWith({
      type: 'capture-ceiling-ack',
      captureId,
      captureGeneration,
      ceilingId: ceiling.ceilingId,
      tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }]
    })
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith({ captureId, captureGeneration }, 'ceiling', true))
    next.instance.dispose()
  })

  it('refuses ceiling acknowledgement instead of trimming a final frontier past the sample cap', async () => {
    const onFailure = vi.fn()
    const next = controller({ onFailure })
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        const command = message as { requestId: string }
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 1, finalSampleOffset: 1_600 })
      }
    }
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 230_400_000 - 1_599)).toBe(true)
    port.emit(pcmFrame(1, 0))
    const ceiling: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration,
      ceilingId: '00000000-0000-4000-8000-000000000705',
      maxSampleOffsetExclusive: 230_400_000
    }
    for (const listener of next.events) listener(ceiling)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled())
    expect(next.acknowledgeCaptureCeiling).not.toHaveBeenCalled()
    expect(next.finish).not.toHaveBeenCalled()
    next.instance.dispose()
  })

  it('admits the exact last sample but never sends a frame beyond the capture ceiling', async () => {
    const onFailure = vi.fn()
    const next = controller({ onFailure })
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 230_400_000 - 1_600)).toBe(true)
    port.emit(pcmFrame(1, 0))
    port.emit(pcmFrame(2, 1_600))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('ORDER'))
    expect(next.frame).toHaveBeenCalledTimes(1)
    expect(next.frame.mock.calls[0]?.[0]).toMatchObject({ sampleOffset: 230_398_400 })
    next.instance.dispose()
  })

  it('joins a ceiling receipt to an already-started user Stop without sealing twice', async () => {
    const next = controller()
    next.finish.mockResolvedValue({
      ok: true,
      captureId,
      captureGeneration,
      complete: true,
      reason: 'normal',
      tracks: [
        {
          stream: { generation: captureGeneration, track: 'microphone', epoch: 3 },
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        }
      ]
    })
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    let flushId = ''
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        flushId = (message as { requestId: string }).requestId
      }
    }
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(true)
    const stopping = next.instance.stop()
    const ceiling: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration,
      ceilingId: '00000000-0000-4000-8000-000000000706',
      maxSampleOffsetExclusive: 230_400_000
    }
    for (const listener of next.events) listener(ceiling)
    port.emit({ type: 'flush-ack', requestId: flushId, finalSequence: 0, finalSampleOffset: 0 })
    await expect(stopping).resolves.toMatchObject({ ok: true, complete: true })
    expect(port.sent).toHaveLength(1)
    expect(next.acknowledgeCaptureCeiling).toHaveBeenCalledTimes(1)
    expect(next.finish).toHaveBeenCalledTimes(1)
    next.instance.dispose()
  })

  it('shortens an in-flight user Stop to the original ceiling deadline without sealing again', async () => {
    vi.useFakeTimers()
    let clock = 0
    const onFailure = vi.fn()
    const next = controller({ onFailure, now: () => clock })
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(true)
    const stopping = next.instance.stop()
    await vi.waitFor(() => expect(port.sent).toHaveLength(1))
    const ceiling: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration,
      ceilingId: '00000000-0000-4000-8000-000000000710',
      maxSampleOffsetExclusive: 230_400_000
    }
    for (const listener of next.events) listener(ceiling)
    await vi.advanceTimersByTimeAsync(4_999)
    clock = 4_999
    expect(onFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    clock = 5_000
    await expect(stopping).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(onFailure).toHaveBeenCalledWith('TIMEOUT')
    expect(port.sent).toHaveLength(1)
    expect(next.finish).not.toHaveBeenCalled()
    next.instance.dispose()
  })

  it('fails closed if the ceiling arrives after finish was already sent', async () => {
    const finishing = deferred<CloudSpeechFinishResult>()
    const onFailure = vi.fn()
    const next = controller({ onFailure })
    next.finish.mockReturnValue(finishing.promise)
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        const command = message as { requestId: string }
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
      }
    }
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(true)
    const stopping = next.instance.stop()
    await vi.waitFor(() => expect(next.finish).toHaveBeenCalledTimes(1))
    const ceiling: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration,
      ceilingId: '00000000-0000-4000-8000-000000000711',
      maxSampleOffsetExclusive: 230_400_000
    }
    for (const listener of next.events) listener(ceiling)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('STALE'))
    finishing.resolve({
      ok: true,
      captureId,
      captureGeneration,
      complete: true,
      reason: 'normal',
      tracks: [
        {
          stream: { generation: captureGeneration, track: 'microphone', epoch: 3 },
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        }
      ]
    })
    await expect(stopping).resolves.toMatchObject({ ok: false, code: 'STALE' })
    expect(next.acknowledgeCaptureCeiling).not.toHaveBeenCalled()
    next.instance.dispose()
  })

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

  it('subscribes before Start and applies a result emitted before the Start response', async () => {
    const applied: CloudSpeechEvent[] = []
    const next = controller({ applyEvent: async (event) => void applied.push(event) })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    expect(next.events.size).toBe(1)
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const earlyEvent: CloudSpeechEvent = {
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
        text: 'startup flush result',
        startMs: 0,
        endMs: 12
      }
    }
    for (const listener of next.events) listener(earlyEvent)
    expect(applied).toEqual([])
    startResult.resolve(started())

    expect(await starting).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(applied).toEqual([earlyEvent]))
    next.instance.dispose()
  })

  it('applies predecessor results before the closed receipt and installs only the announced successor epoch', async () => {
    const applied: CloudSpeechEvent[] = []
    const next = controller({ applyEvent: async (event) => void applied.push(event) })
    expect((await next.instance.start()).ok).toBe(true)
    const oldStream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const final: CloudSpeechEvent = {
      type: 'segment',
      captureId,
      captureGeneration,
      sequence: 1,
      segment: {
        stream: oldStream,
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'old final',
        startMs: 0,
        endMs: 20
      }
    }
    const terminal: CloudSpeechEvent = {
      type: 'terminal',
      captureId,
      captureGeneration,
      stream: oldStream,
      lastSequence: 1,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    }
    const closed: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 4,
      handoffNonce: '00000000-0000-4000-8000-000000000704',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 1 }]
    }
    const opened: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 4,
      handoffNonce: closed.handoffNonce,
      stage: 'opened',
      streams: [{ track: 'microphone', previousEpoch: 3, nextEpoch: 9, lastSequence: 1 }]
    }
    for (const event of [final, terminal, closed]) for (const listener of next.events) listener(event)
    await vi.waitFor(() => expect(next.acknowledgeEpochTransition).toHaveBeenCalledTimes(1))
    expect(applied).toEqual([final, terminal])
    expect(next.acknowledgeEpochTransition).toHaveBeenNthCalledWith(1, {
      type: 'epoch-transition-ack',
      captureId,
      captureGeneration,
      transitionId: 4,
      handoffNonce: closed.handoffNonce,
      stage: 'closed',
      streams: closed.streams
    })

    for (const listener of next.events) listener(opened)
    await vi.waitFor(() => expect(next.acknowledgeEpochTransition).toHaveBeenCalledTimes(2))
    expect(next.acknowledgeEpochTransition).toHaveBeenNthCalledWith(2, {
      type: 'epoch-transition-ack',
      captureId,
      captureGeneration,
      transitionId: 4,
      handoffNonce: closed.handoffNonce,
      stage: 'opened',
      streams: opened.streams
    })

    const successor: CloudSpeechEvent = {
      ...final,
      sequence: 1,
      segment: { ...final.segment, stream: { ...oldStream, epoch: 9 }, text: 'new final' }
    }
    for (const listener of next.events) listener(successor)
    await vi.waitFor(() => expect(applied).toEqual([final, terminal, successor]))
    next.instance.dispose()
  })

  it('rejects an unannounced epoch jump and never applies successor results', async () => {
    const onFailure = vi.fn()
    const applied: CloudSpeechEvent[] = []
    const next = controller({ onFailure, applyEvent: async (event) => void applied.push(event) })
    expect((await next.instance.start()).ok).toBe(true)
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const terminal: CloudSpeechEvent = {
      type: 'terminal',
      captureId,
      captureGeneration,
      stream,
      lastSequence: 0,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    }
    const unannounced: CloudSpeechEvent = {
      type: 'segment',
      captureId,
      captureGeneration,
      sequence: 1,
      segment: {
        stream: { ...stream, epoch: 4 },
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'must not cross epochs implicitly',
        startMs: 0,
        endMs: 20
      }
    }
    for (const listener of next.events) listener(terminal)
    for (const listener of next.events) listener(unannounced)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('STALE'))
    expect(applied).toEqual([terminal])
    expect(next.acknowledgeEpochTransition).not.toHaveBeenCalled()
    next.instance.dispose()
  })

  it('queues successor results until the opened epoch inventory is acknowledged', async () => {
    const applied: CloudSpeechEvent[] = []
    const fakes = fakeBridge()
    const openedAck = deferred<unknown>()
    fakes.bridge.cloudSpeechAckEpochTransition = vi.fn((value) =>
      value.stage === 'opened'
        ? openedAck.promise
        : Promise.resolve({
            ok: true,
            captureId: value.captureId,
            captureGeneration: value.captureGeneration,
            transitionId: value.transitionId,
            handoffNonce: value.handoffNonce,
            stage: value.stage
          })
    )
    const next = controller({ bridge: fakes.bridge, applyEvent: async (event) => void applied.push(event) })
    expect((await next.instance.start()).ok).toBe(true)
    const oldStream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const terminal: CloudSpeechEvent = {
      type: 'terminal',
      captureId,
      captureGeneration,
      stream: oldStream,
      lastSequence: 0,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    }
    const closed: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 6,
      handoffNonce: '00000000-0000-4000-8000-000000000706',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 0 }]
    }
    const opened: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 6,
      handoffNonce: closed.handoffNonce,
      stage: 'opened',
      streams: [{ track: 'microphone', previousEpoch: 3, nextEpoch: 15, lastSequence: 0 }]
    }
    for (const event of [terminal, closed, opened]) for (const listener of next.events) listener(event)
    await vi.waitFor(() => expect(fakes.bridge.cloudSpeechAckEpochTransition).toHaveBeenCalledTimes(2))
    const successor: CloudSpeechEvent = {
      type: 'segment',
      captureId,
      captureGeneration,
      sequence: 1,
      segment: {
        stream: { ...oldStream, epoch: 15 },
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'wait for applied open receipt',
        startMs: 0,
        endMs: 20
      }
    }
    for (const listener of next.events) listener(successor)
    await Promise.resolve()
    expect(applied).toEqual([terminal])
    openedAck.resolve({
      ok: true,
      captureId,
      captureGeneration,
      transitionId: 6,
      handoffNonce: closed.handoffNonce,
      stage: 'opened'
    })
    await vi.waitFor(() => expect(applied).toEqual([terminal, successor]))
    next.instance.dispose()
  })

  it('does not open a successor after an incomplete or unconfirmed predecessor terminal', async () => {
    const onFailure = vi.fn()
    const next = controller({ onFailure })
    expect((await next.instance.start()).ok).toBe(true)
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const terminal: CloudSpeechEvent = {
      type: 'terminal',
      captureId,
      captureGeneration,
      stream,
      lastSequence: 0,
      closeConfirmed: true,
      tail: 'incomplete',
      reason: 'drain-timeout'
    }
    const closed: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 7,
      handoffNonce: '00000000-0000-4000-8000-000000000707',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 0 }]
    }
    for (const event of [terminal, closed]) for (const listener of next.events) listener(event)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('STALE'))
    expect(next.acknowledgeEpochTransition).not.toHaveBeenCalled()
    next.instance.dispose()
  })

  it('does not acknowledge closure while a predecessor revision remains provisional', async () => {
    const onFailure = vi.fn()
    const next = controller({ onFailure })
    expect((await next.instance.start()).ok).toBe(true)
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const interim: CloudSpeechEvent = {
      type: 'segment',
      captureId,
      captureGeneration,
      sequence: 1,
      segment: {
        stream,
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: false,
        text: 'provisional',
        startMs: 0,
        endMs: 20
      }
    }
    const terminal: CloudSpeechEvent = {
      type: 'terminal',
      captureId,
      captureGeneration,
      stream,
      lastSequence: 1,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    }
    const closed: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 5,
      handoffNonce: '00000000-0000-4000-8000-000000000705',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 1 }]
    }
    for (const event of [interim, terminal, closed]) for (const listener of next.events) listener(event)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled())
    expect(next.acknowledgeEpochTransition).not.toHaveBeenCalled()
    next.instance.dispose()
  })

  it('keeps a frame pending only until its original enqueue plus two-second deadline, including Stop', async () => {
    vi.useFakeTimers()
    let clock = 0
    const pendingFrame = deferred<CloudSpeechFrameResult>()
    const onFailure = vi.fn()
    const bounded = controller({ now: () => clock, onFailure })
    bounded.frame.mockReturnValue(pendingFrame.promise)
    expect((await bounded.instance.start()).ok).toBe(true)
    const port = new FakePort()
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        const command = message as { requestId: string }
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 1, finalSampleOffset: 1_600 })
      }
    }
    expect(bounded.instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(true)
    port.emit(pcmFrame(1, 0))
    expect(bounded.frame).toHaveBeenCalledTimes(1)
    const stopping = bounded.instance.stop()
    clock = 2_000
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(stopping).resolves.toEqual(failure('QUEUE_STALE'))
    expect(onFailure).toHaveBeenCalledWith('QUEUE_STALE')
    expect(bounded.finish).not.toHaveBeenCalled()
    bounded.instance.dispose()
  })

  it('drains a bounded startup batch through result application without exceeding the live backlog cap', async () => {
    const applied = vi.fn()
    const applicationGates: Array<ReturnType<typeof deferred<void>>> = []
    const next = controller({
      applyEvent: async () => {
        const gate = deferred<void>()
        applicationGates.push(gate)
        await gate.promise
        applied()
      }
    })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    for (let sequence = 1; sequence <= 80; sequence += 1) {
      const event: CloudSpeechEvent = {
        type: 'segment',
        captureId,
        captureGeneration,
        sequence,
        segment: {
          stream,
          engine: 'cloudflare-nova3',
          index: sequence,
          revision: 1,
          final: true,
          text: 'staged startup result',
          startMs: sequence * 20,
          endMs: sequence * 20 + 10
        }
      }
      for (const listener of next.events) listener(event)
    }
    startResult.resolve(started())

    for (let count = 1; count <= 80; count += 1) {
      await vi.waitFor(() => expect(applicationGates).toHaveLength(count))
      expect(applied).toHaveBeenCalledTimes(count - 1)
      applicationGates[count - 1].resolve()
    }
    expect(await starting).toMatchObject({ ok: true })
    expect(applied).toHaveBeenCalledTimes(80)
    expect(next.events.size).toBe(1)
    next.instance.dispose()
  })

  it('discards startup results and unsubscribes when Start fails', async () => {
    const onFailure = vi.fn()
    const applied = vi.fn()
    const next = controller({ onFailure, applyEvent: async (event) => void applied(event) })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    expect(next.events.size).toBe(1)
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    for (const listener of next.events)
      listener({
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
          text: 'must not escape failed start',
          startMs: 0,
          endMs: 12
        }
      })
    startResult.resolve(failure('POLICY'))

    expect(await starting).toEqual(failure('POLICY'))
    expect(next.events.size).toBe(0)
    expect(applied).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith('POLICY')
    next.instance.dispose()
  })

  it('fails closed at the startup event-count limit and cancels a later successful Start', async () => {
    const onFailure = vi.fn()
    const next = controller({ onFailure })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    expect(next.events.size).toBe(1)
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const makeEvent = (sequence: number): CloudSpeechEvent => ({
      type: 'segment',
      captureId,
      captureGeneration,
      sequence,
      segment: {
        stream,
        engine: 'cloudflare-nova3',
        index: sequence,
        revision: 1,
        final: true,
        text: 'bounded startup result',
        startMs: sequence * 20,
        endMs: sequence * 20 + 10
      }
    })
    for (let sequence = 1; sequence <= 128; sequence += 1) {
      for (const listener of next.events) listener(makeEvent(sequence))
    }
    expect(onFailure).not.toHaveBeenCalled()
    for (const listener of next.events) listener(makeEvent(129))

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('QUEUE_LIMIT'))
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(next.events.size).toBe(0)
    startResult.resolve(started())
    expect(await starting).toMatchObject({ ok: false, code: 'QUEUE_LIMIT' })
    await vi.waitFor(() => expect(next.bridge.cloudSpeechCancel).toHaveBeenCalledWith({ captureId, captureGeneration }))
    next.instance.dispose()
  })

  it('fails closed at the startup byte limit and does not deliver buffered content', async () => {
    const onFailure = vi.fn()
    const applied = vi.fn()
    const next = controller({ onFailure, applyEvent: async (event) => void applied(event) })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const makeEvent = (sequence: number): CloudSpeechEvent => ({
      type: 'segment',
      captureId,
      captureGeneration,
      sequence,
      segment: {
        stream,
        engine: 'cloudflare-nova3',
        index: sequence,
        revision: 1,
        final: true,
        text: 'x'.repeat(4_000),
        startMs: sequence * 20,
        endMs: sequence * 20 + 10
      }
    })
    let sequence = 1
    let bytes = 0
    while (true) {
      const event = makeEvent(sequence)
      const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
      if (bytes + eventBytes > 256 * 1024) {
        for (const listener of next.events) listener(event)
        break
      }
      for (const listener of next.events) listener(event)
      bytes += eventBytes
      sequence += 1
    }
    expect(sequence).toBeLessThan(128)

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('QUEUE_LIMIT'))
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(next.events.size).toBe(0)
    startResult.resolve(started())
    expect(await starting).toMatchObject({ ok: false, code: 'QUEUE_LIMIT' })
    await vi.waitFor(() => expect(next.bridge.cloudSpeechCancel).toHaveBeenCalledWith({ captureId, captureGeneration }))
    expect(applied).not.toHaveBeenCalled()
    next.instance.dispose()
  })

  it('bounds startup activation when applying an early event stalls', async () => {
    const onFailure = vi.fn()
    const applyResult = deferred<void>()
    const applyStarted = deferred<void>()
    const next = controller({
      deadlineMs: 50,
      onFailure,
      applyEvent: () => {
        applyStarted.resolve()
        return applyResult.promise
      }
    })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    for (const listener of next.events)
      listener({
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
          text: 'startup application stalls',
          startMs: 0,
          endMs: 10
        }
      })
    startResult.resolve(started())
    await applyStarted.promise

    expect(await starting).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(onFailure).toHaveBeenCalledWith('TIMEOUT')
    await vi.waitFor(() => expect(next.bridge.cloudSpeechCancel).toHaveBeenCalledWith({ captureId, captureGeneration }))
    applyResult.resolve()
    next.instance.dispose()
  })

  it('discards buffered results and cancels the exact identity after a stale late Start', async () => {
    const applied = vi.fn()
    const next = controller({ applyEvent: async (event) => void applied(event) })
    const startResult = deferred<unknown>()
    next.bridge.cloudSpeechStart = vi.fn(() => startResult.promise)
    const starting = next.instance.start()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStart).toHaveBeenCalledTimes(1))
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    for (const listener of next.events)
      listener({
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
          text: 'must not escape cancelled start',
          startMs: 0,
          endMs: 12
        }
      })
    await next.instance.cancel()
    expect(next.events.size).toBe(0)
    startResult.resolve(started())

    expect(await starting).toMatchObject({ ok: false, code: 'CLOSED' })
    await vi.waitFor(() => expect(next.bridge.cloudSpeechCancel).toHaveBeenCalledTimes(1))
    expect(next.bridge.cloudSpeechCancel).toHaveBeenCalledWith({ captureId, captureGeneration })
    expect(applied).not.toHaveBeenCalled()
    next.instance.dispose()
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

  it('releases the exact port and listener when attaching the worklet port fails', async () => {
    const onFailure = vi.fn()
    const { instance } = controller({ onFailure })
    await instance.start()
    const port = new FakePort()
    port.startFailure = new Error('private port detail')

    expect(instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(false)
    expect(port.listenerCount).toBe(0)
    expect(port.closed).toBe(true)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledWith('TRANSPORT')
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

  it('rejects a full frame after the sealed-final remainder', async () => {
    const onFailure = vi.fn()
    const { instance, frame } = controller({ onFailure })
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type !== 'seal-and-flush' || !command.requestId) return
      port.emit(pcmFrame(1, 0, 7))
      port.emit(pcmFrame(2, 7))
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

  it('downgrades a complete transport finish when its final applied revision is still interim', async () => {
    const apply = deferred<void>()
    const applyStarted = deferred<void>()
    const finishResult = deferred<CloudSpeechFinishResult>()
    const { instance, events, finish } = controller({
      applyEvent: () => {
        applyStarted.resolve()
        return apply.promise
      }
    })
    finish.mockReturnValue(finishResult.promise)
    await instance.start()
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId)
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
    }

    const stopping = instance.stop()
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    finishResult.resolve({
      ok: true,
      captureId,
      captureGeneration,
      complete: true,
      reason: 'normal',
      tracks: [{ stream, lastSequence: 1, closeConfirmed: true, tail: 'complete', reason: 'normal' }]
    })
    setTimeout(() => {
      for (const listener of events)
        listener({
          type: 'segment',
          captureId,
          captureGeneration,
          sequence: 1,
          segment: {
            stream,
            engine: 'cloudflare-nova3',
            index: 1,
            revision: 1,
            final: false,
            text: 'pending final revision',
            startMs: 0,
            endMs: 20
          }
        })
    }, 0)
    await applyStarted.promise
    apply.resolve()

    const result = await stopping
    expect(result).toMatchObject({ ok: true, complete: false, reason: 'incomplete' })
    instance.dispose()
  })

  it('does not report complete when disposed while the final event callback is still draining', async () => {
    const apply = deferred<void>()
    const applyStarted = deferred<void>()
    const { instance, events, finish } = controller({
      applyEvent: () => {
        applyStarted.resolve()
        return apply.promise
      }
    })
    await instance.start()
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    for (const listener of events)
      listener({
        type: 'terminal',
        captureId,
        captureGeneration,
        stream,
        lastSequence: 0,
        closeConfirmed: true,
        tail: 'complete',
        reason: 'normal'
      })
    await applyStarted.promise
    const port = new FakePort()
    instance.attachTrack('microphone', port as unknown as MessagePort, 0)
    port.onPost = (message) => {
      const command = message as { type: string; requestId?: string }
      if (command.type === 'seal-and-flush' && command.requestId)
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
    }
    finish.mockResolvedValue({
      ok: true,
      captureId,
      captureGeneration,
      complete: true,
      reason: 'normal',
      tracks: [{ stream, lastSequence: 0, closeConfirmed: true, tail: 'complete', reason: 'normal' }]
    })
    const stopping = instance.stop()
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    instance.dispose()
    apply.resolve()

    expect(await stopping).toMatchObject({ ok: false, code: 'CLOSED' })
  })

  it('bounds queued result application while an earlier application is stalled', async () => {
    const onFailure = vi.fn()
    const apply = deferred<void>()
    const applyStarted = deferred<void>()
    const applied = vi.fn(() => {
      applyStarted.resolve()
      return apply.promise
    })
    const { instance, events } = controller({ onFailure, applyEvent: applied })
    await instance.start()
    const stream = { generation: captureGeneration, track: 'microphone' as const, epoch: 3 }
    const makeEvent = (sequence: number): CloudSpeechEvent => ({
      type: 'segment',
      captureId,
      captureGeneration,
      sequence,
      segment: {
        stream,
        engine: 'cloudflare-nova3',
        index: sequence,
        revision: 1,
        final: true,
        text: 'bounded pending event',
        startMs: sequence * 20,
        endMs: sequence * 20 + 10
      }
    })
    for (const listener of events) listener(makeEvent(1))
    await applyStarted.promise
    for (let sequence = 2; sequence <= 65; sequence += 1) {
      for (const listener of events) listener(makeEvent(sequence))
    }

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith('QUEUE_LIMIT'))
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(applied).toHaveBeenCalledTimes(1)
    apply.resolve()
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
    const terminal: CloudSpeechEvent = {
      type: 'terminal',
      captureId,
      captureGeneration,
      stream: oldStream,
      lastSequence: 0,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    }
    for (const listener of next.events) listener(terminal)
    const closed: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: 8,
      handoffNonce: '00000000-0000-4000-8000-000000000708',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 0 }]
    }
    const opened: CloudSpeechEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration,
      transitionId: closed.transitionId,
      handoffNonce: closed.handoffNonce,
      stage: 'opened',
      streams: [{ track: 'microphone', previousEpoch: 3, nextEpoch: 4, lastSequence: 0 }]
    }
    for (const event of [closed, opened]) for (const listener of next.events) listener(event)
    await vi.waitFor(() => expect(next.acknowledgeEpochTransition).toHaveBeenCalledTimes(2))
    const successor: CloudSpeechEvent = {
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
    }
    for (const listener of next.events) listener(successor)
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
            phase: 'closed',
            lastSequence: 1,
            closeConfirmed: true,
            tail: 'complete'
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
    expect(result).toMatchObject({
      ok: true,
      complete: false,
      reason: 'incomplete',
      tracks: [{ reason: 'unknown', tail: 'incomplete' }]
    })
    expect(bridge.cloudSpeechStatus).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      tracks: [{ stream: { generation: captureGeneration, track: 'microphone', epoch: 3 }, tail: 'incomplete' }]
    })
    instance.dispose()
  })

  it('tears down the current owner after ceiling recovery confirms closure but not a complete tail', async () => {
    const stopped = vi.fn()
    const onFailure = vi.fn()
    const next = controller({ onStopped: stopped, onFailure })
    next.finish.mockResolvedValue(failure('CLOSURE_UNCONFIRMED'))
    next.bridge.cloudSpeechStatus = vi.fn(() =>
      Promise.resolve({
        ok: true,
        captureId,
        captureGeneration,
        state: 'closed',
        tracks: [
          {
            stream: { generation: captureGeneration, track: 'microphone', epoch: 3 },
            phase: 'closed',
            lastSequence: 0,
            closeConfirmed: true,
            tail: 'complete'
          }
        ]
      })
    )
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        const command = message as { requestId: string }
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
      }
    }
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(true)
    const ceiling: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration,
      ceilingId: '00000000-0000-4000-8000-000000000712',
      maxSampleOffsetExclusive: 230_400_000
    }
    for (const listener of next.events) listener(ceiling)
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1))
    expect(stopped).toHaveBeenCalledWith({ captureId, captureGeneration }, 'ceiling', false)
    expect(onFailure).not.toHaveBeenCalled()
    expect(next.bridge.cloudSpeechStatus).toHaveBeenCalledTimes(1)
    next.instance.dispose()
  })

  it('does not notify the owner from a closed-status recovery after cancellation wins', async () => {
    const status = deferred<unknown>()
    const stopped = vi.fn()
    const next = controller({ onStopped: stopped })
    next.finish.mockResolvedValue(failure('CLOSURE_UNCONFIRMED'))
    next.bridge.cloudSpeechStatus = vi.fn(() => status.promise)
    expect((await next.instance.start()).ok).toBe(true)
    const port = new FakePort()
    port.onPost = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'seal-and-flush') {
        const command = message as { requestId: string }
        port.emit({ type: 'flush-ack', requestId: command.requestId, finalSequence: 0, finalSampleOffset: 0 })
      }
    }
    expect(next.instance.attachTrack('microphone', port as unknown as MessagePort, 0)).toBe(true)
    const stopping = next.instance.stop()
    await vi.waitFor(() => expect(next.bridge.cloudSpeechStatus).toHaveBeenCalledTimes(1))
    await next.instance.cancel()
    status.resolve({
      ok: true,
      captureId,
      captureGeneration,
      state: 'closed',
      tracks: [
        {
          stream: { generation: captureGeneration, track: 'microphone', epoch: 3 },
          phase: 'closed',
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'complete'
        }
      ]
    })
    await expect(stopping).resolves.toMatchObject({ ok: false, code: 'CLOSED' })
    expect(stopped).not.toHaveBeenCalled()
    next.instance.dispose()
  })
})
