import { describe, expect, it, vi } from 'vitest'
import {
  CLOUD_SPEECH_IPC,
  type CloudSpeechEvent,
  type CloudSpeechCaptureCeilingEvent,
  type CloudSpeechCaptureCeilingAck,
  type CloudSpeechEpochTransitionAck,
  type CloudSpeechEpochTransitionEvent,
  type CloudSpeechFinishRequest,
  type CloudSpeechStartRequest
} from '../shared/cloud-speech'
import type { Capture } from '../shared/contracts/speech'
import { createCloudSpeechPreloadApi } from './cloud-speech'

const capture: Capture = {
  generation: 7,
  engine: 'deepgram-nova3',
  requestedTracks: ['microphone'],
  capturedTracks: ['microphone']
}
const captureId = 'b8ff8685-725b-40e0-a8ef-f343bb10b64f'
const start: CloudSpeechStartRequest = {
  captureId,
  capture,
  language: 'auto',
  consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
}

function makeRenderer() {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
  const on = vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
    listeners.set(channel, listener)
  })
  const removeListener = vi.fn((channel: string) => {
    listeners.delete(channel)
  })
  return {
    renderer: { invoke, on, removeListener } as never,
    invoke,
    listeners,
    on,
    removeListener
  }
}

function pcmFrame(pcm16le = new ArrayBuffer(3_200)) {
  return {
    captureId,
    captureGeneration: capture.generation,
    track: 'microphone' as const,
    sequence: 1,
    sampleOffset: 0,
    kind: 'full' as const,
    pcm16le
  }
}

describe('cloud speech preload boundary', () => {
  it('delivers an exact ceiling event and accepts only its matching sealed-frontier acknowledgement', async () => {
    const fixture = makeRenderer()
    const event: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId,
      captureGeneration: capture.generation,
      ceilingId: '00000000-0000-4000-8000-000000000704',
      maxSampleOffsetExclusive: 230_400_000
    }
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    const received: CloudSpeechEvent[] = []
    api.onCloudSpeechEvent(captureId, capture.generation, (value) => received.push(value))
    fixture.listeners.get(CLOUD_SPEECH_IPC.event)?.({}, event)
    expect(received).toEqual([event])

    const acknowledgement: CloudSpeechCaptureCeilingAck = {
      type: 'capture-ceiling-ack',
      captureId,
      captureGeneration: capture.generation,
      ceilingId: event.ceilingId,
      tracks: [{ track: 'microphone', finalSequence: 20, finalSampleOffset: 32_000 }]
    }
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      ceilingId: event.ceilingId,
      tracks: acknowledgement.tracks
    })
    await expect(api.cloudSpeechAckCaptureCeiling(acknowledgement)).resolves.toEqual({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      ceilingId: event.ceilingId,
      tracks: acknowledgement.tracks
    })
    expect(fixture.invoke).toHaveBeenCalledWith(CLOUD_SPEECH_IPC.ceilingAck, acknowledgement)

    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      ceilingId: '00000000-0000-4000-8000-000000000705',
      tracks: acknowledgement.tracks
    })
    await expect(api.cloudSpeechAckCaptureCeiling(acknowledgement)).resolves.toMatchObject({
      ok: false,
      code: 'TRANSPORT'
    })
  })

  it('does not invoke main for an invalid request and validates successful responses', async () => {
    const fixture = makeRenderer()
    fixture.invoke.mockResolvedValueOnce({
      disclosureVersion: 'cloud-speech-v1',
      selected: null,
      allowed: [],
      ready: false,
      refusal: 'NOT_READY'
    })
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    expect(await api.cloudSpeechCapability()).toMatchObject({ ready: false, refusal: 'NOT_READY' })
    expect(fixture.invoke).toHaveBeenCalledWith(CLOUD_SPEECH_IPC.capability)

    const rejected = await api.cloudSpeechStart({ ...start, consent: { ...start.consent, accepted: false } } as never)
    expect(rejected).toEqual({ ok: false, code: 'INVALID_REQUEST', captureId, captureGeneration: capture.generation })
    expect(fixture.invoke).toHaveBeenCalledTimes(1)

    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation + 1,
      engine: 'deepgram-nova3',
      streams: [{ track: 'microphone', streamEpoch: 1 }],
      limits: { frameBytes: 3_200, maxPendingFrames: 20, maxPendingBytes: 65_536, maxPendingAudioMs: 2_000 }
    })
    await expect(api.cloudSpeechStart(start)).resolves.toEqual({
      ok: false,
      code: 'TRANSPORT',
      captureId,
      captureGeneration: capture.generation
    })
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      engine: 'deepgram-nova3',
      streams: [{ track: 'microphone', streamEpoch: 1 }],
      limits: { frameBytes: 3_200, maxPendingFrames: 20, maxPendingBytes: 65_536, maxPendingAudioMs: 2_000 }
    })
    await expect(api.cloudSpeechStart(start)).resolves.toMatchObject({ ok: true, captureId })
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      engine: 'cloudflare-nova3',
      streams: [{ track: 'microphone', streamEpoch: 1 }],
      limits: { frameBytes: 3_200, maxPendingFrames: 20, maxPendingBytes: 65_536, maxPendingAudioMs: 2_000 }
    })
    await expect(api.cloudSpeechStart(start)).resolves.toMatchObject({ ok: false, code: 'TRANSPORT' })
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      engine: 'deepgram-nova3',
      streams: [{ track: 'system', streamEpoch: 1 }],
      limits: { frameBytes: 3_200, maxPendingFrames: 20, maxPendingBytes: 65_536, maxPendingAudioMs: 2_000 }
    })
    await expect(api.cloudSpeechStart(start)).resolves.toMatchObject({ ok: false, code: 'TRANSPORT' })
  })

  it('clones the fixed PCM buffer and refuses a second concurrent frame invoke per track', async () => {
    const fixture = makeRenderer()
    let resolveFirst!: (value: unknown) => void
    fixture.invoke.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    const original = pcmFrame()
    const first = api.cloudSpeechFrame(original)
    const second = await api.cloudSpeechFrame(pcmFrame())
    expect(second).toEqual({ ok: false, code: 'QUEUE_LIMIT', captureId, captureGeneration: capture.generation })
    expect(fixture.invoke).toHaveBeenCalledTimes(1)
    const sent = fixture.invoke.mock.calls[0]?.[1] as typeof original
    expect(sent.pcm16le).not.toBe(original.pcm16le)
    expect(sent.pcm16le.byteLength).toBe(3_200)
    resolveFirst({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      track: 'microphone',
      sequence: 1,
      nextSequence: 2,
      nextSampleOffset: 1_600
    })
    await expect(first).resolves.toMatchObject({ ok: true, nextSequence: 2 })
  })

  it('copies PCM into a fixed buffer without invoking a caller-controlled ArrayBuffer species', async () => {
    const fixture = makeRenderer()
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      track: 'microphone',
      sequence: 1,
      nextSequence: 2,
      nextSampleOffset: 1_600
    })
    const source = new ArrayBuffer(3_200)
    let speciesCalls = 0
    Object.defineProperty(source, 'constructor', {
      value: {
        [Symbol.species]: class {
          constructor() {
            speciesCalls += 1
            throw new Error('caller-controlled species must not run')
          }
        }
      }
    })

    const api = createCloudSpeechPreloadApi(fixture.renderer)
    await expect(api.cloudSpeechFrame(pcmFrame(source))).resolves.toMatchObject({ ok: true })
    const sent = fixture.invoke.mock.calls[0]?.[1] as ReturnType<typeof pcmFrame>
    expect(sent.pcm16le).not.toBe(source)
    expect(sent.pcm16le.byteLength).toBe(3_200)
    expect(speciesCalls).toBe(0)
  })

  it('caps total frame invokes and event subscriptions even across distinct tracks', async () => {
    const fixture = makeRenderer()
    const pending: Array<(value: unknown) => void> = []
    fixture.invoke.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    const mic = api.cloudSpeechFrame(pcmFrame())
    const system = api.cloudSpeechFrame({ ...pcmFrame(), track: 'system', sampleOffset: 4_000 })
    const third = await api.cloudSpeechFrame({ ...pcmFrame(), captureId: 'c1f85141-fcfe-4bac-9d96-658fce84ca87' })
    expect(third).toMatchObject({ ok: false, code: 'QUEUE_LIMIT' })
    expect(fixture.invoke).toHaveBeenCalledTimes(2)

    pending[0]?.({ ok: false, code: 'CANCELLED' })
    pending[1]?.({ ok: false, code: 'CANCELLED' })
    await Promise.all([mic, system])

    const unsubscribers = Array.from({ length: 3 }, () =>
      api.onCloudSpeechEvent(captureId, capture.generation, () => undefined)
    )
    expect(fixture.on).toHaveBeenCalledTimes(2)
    for (const unsubscribe of unsubscribers) unsubscribe()
    expect(fixture.removeListener).toHaveBeenCalledTimes(2)
  })

  it('rejects a valid-shaped ACK that does not bind the exact admitted frame frontier', async () => {
    const fixture = makeRenderer()
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      track: 'microphone',
      sequence: 1,
      nextSequence: 2,
      nextSampleOffset: 1
    })
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    await expect(api.cloudSpeechFrame(pcmFrame())).resolves.toEqual({
      ok: false,
      code: 'TRANSPORT',
      captureId,
      captureGeneration: capture.generation
    })
  })

  it('accepts a finish result only when its exact capture tuple matches the request', async () => {
    const fixture = makeRenderer()
    const request: CloudSpeechFinishRequest = {
      captureId,
      captureGeneration: capture.generation,
      tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }]
    }
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      complete: true,
      reason: 'normal',
      tracks: [
        {
          stream: { generation: capture.generation, track: 'microphone', epoch: 1 },
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        }
      ]
    })
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    await expect(api.cloudSpeechFinish(request)).resolves.toMatchObject({ ok: true, captureId })
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      complete: true,
      reason: 'normal',
      tracks: [
        {
          stream: { generation: capture.generation, track: 'system', epoch: 1 },
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'complete',
          reason: 'normal'
        }
      ]
    })
    await expect(api.cloudSpeechFinish(request)).resolves.toMatchObject({ ok: false, code: 'TRANSPORT' })
  })

  it('filters strict events by the subscribed capture tuple and removes the exact listener', () => {
    const fixture = makeRenderer()
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    const received: CloudSpeechEvent[] = []
    const unsubscribe = api.onCloudSpeechEvent(captureId, capture.generation, (event) => received.push(event))
    const listener = fixture.listeners.get(CLOUD_SPEECH_IPC.event)
    expect(listener).toBeDefined()
    const event = {
      type: 'segment',
      captureId,
      captureGeneration: capture.generation,
      sequence: 1,
      segment: {
        stream: { generation: capture.generation, track: 'microphone', epoch: 1 },
        engine: 'deepgram-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'hello',
        startMs: 0,
        endMs: 100
      }
    }
    listener?.({}, { ...event, captureId: 'c1f85141-fcfe-4bac-9d96-658fce84ca87' })
    listener?.({}, { ...event, sessionId: 'private-relay-id' })
    expect(received).toHaveLength(0)
    listener?.({}, event)
    expect(received).toHaveLength(1)
    unsubscribe()
    expect(fixture.removeListener).toHaveBeenCalledWith(CLOUD_SPEECH_IPC.event, listener)
  })

  it('delivers only a closed epoch transition for the subscribed capture and validates its applied acknowledgement', async () => {
    const fixture = makeRenderer()
    const transition: CloudSpeechEpochTransitionEvent = {
      type: 'epoch-transition',
      captureId,
      captureGeneration: capture.generation,
      transitionId: 2,
      handoffNonce: '00000000-0000-4000-8000-000000000702',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 28 }]
    }
    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      transitionId: 2,
      handoffNonce: transition.handoffNonce,
      stage: 'closed'
    })
    const api = createCloudSpeechPreloadApi(fixture.renderer)
    const received: CloudSpeechEvent[] = []
    api.onCloudSpeechEvent(captureId, capture.generation, (event) => received.push(event))
    const listener = fixture.listeners.get(CLOUD_SPEECH_IPC.event)
    listener?.({}, { ...transition, captureGeneration: capture.generation + 1 })
    listener?.({}, transition)
    expect(received).toEqual([transition])
    const acknowledgement: CloudSpeechEpochTransitionAck = {
      type: 'epoch-transition-ack',
      captureId,
      captureGeneration: capture.generation,
      transitionId: transition.transitionId,
      handoffNonce: transition.handoffNonce,
      stage: transition.stage,
      streams: transition.streams
    }
    await expect(api.cloudSpeechAckEpochTransition(acknowledgement)).resolves.toMatchObject({
      ok: true,
      transitionId: 2,
      stage: 'closed'
    })
    expect(fixture.invoke).toHaveBeenCalledWith(CLOUD_SPEECH_IPC.transitionAck, {
      type: 'epoch-transition-ack',
      captureId,
      captureGeneration: capture.generation,
      transitionId: 2,
      handoffNonce: transition.handoffNonce,
      stage: 'closed',
      streams: transition.streams
    })

    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation,
      transitionId: 3,
      handoffNonce: transition.handoffNonce,
      stage: 'closed'
    })
    await expect(api.cloudSpeechAckEpochTransition(acknowledgement)).resolves.toEqual({
      ok: false,
      code: 'TRANSPORT',
      captureId,
      captureGeneration: capture.generation
    })

    fixture.invoke.mockResolvedValueOnce({
      ok: true,
      captureId,
      captureGeneration: capture.generation + 1,
      transitionId: transition.transitionId,
      handoffNonce: transition.handoffNonce,
      stage: transition.stage
    })
    await expect(api.cloudSpeechAckEpochTransition(acknowledgement)).resolves.toEqual({
      ok: false,
      code: 'TRANSPORT',
      captureId,
      captureGeneration: capture.generation
    })
  })
})
