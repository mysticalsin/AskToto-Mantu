import { describe, expect, it } from 'vitest'
import {
  CloudSpeechEpochTransitionAckSchema,
  CloudSpeechEpochTransitionEventSchema,
  CloudSpeechFinishRequestSchema,
  CloudSpeechFinishResultSchema,
  CloudSpeechFrameSchema,
  CloudSpeechCapabilitySchema,
  CloudSpeechStatusResultSchema,
  CloudSpeechStartRequestSchema,
  CloudSpeechCaptureCeilingEventSchema,
  CloudSpeechCaptureCeilingAckSchema,
  CloudSpeechEventSchema,
  type CloudSpeechStartRequest
} from './cloud-speech'
import type { Capture } from './contracts/speech'

const capture: Capture = {
  generation: 3,
  engine: 'deepgram-nova3',
  requestedTracks: ['microphone', 'system'],
  capturedTracks: ['microphone']
}

const start: CloudSpeechStartRequest = {
  captureId: 'a3cfc5ce-6427-4a17-86b8-6f2b2c82c620',
  capture,
  language: 'auto',
  consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
}

function frame(overrides: Record<string, unknown> = {}): unknown {
  return {
    captureId: start.captureId,
    captureGeneration: capture.generation,
    track: 'microphone',
    sequence: 1,
    sampleOffset: 0,
    kind: 'full',
    pcm16le: new ArrayBuffer(3_200),
    ...overrides
  }
}

describe('cloud speech shared wire contracts', () => {
  it('binds the fixed four-hour ceiling to exact ordered sealed frontiers', () => {
    const ceiling = {
      type: 'capture-ceiling',
      captureId: start.captureId,
      captureGeneration: capture.generation,
      ceilingId: '00000000-0000-4000-8000-000000000704',
      maxSampleOffsetExclusive: 230_400_000
    }
    expect(CloudSpeechCaptureCeilingEventSchema.safeParse(ceiling).success).toBe(true)
    expect(CloudSpeechEventSchema.safeParse(ceiling).success).toBe(true)
    const ack = {
      type: 'capture-ceiling-ack',
      captureId: start.captureId,
      captureGeneration: capture.generation,
      ceilingId: ceiling.ceilingId,
      tracks: [
        { track: 'microphone', finalSequence: 300, finalSampleOffset: 480_000 },
        { track: 'system', finalSequence: 299, finalSampleOffset: 478_400 }
      ]
    }
    expect(CloudSpeechCaptureCeilingAckSchema.safeParse(ack).success).toBe(true)
    for (const invalid of [
      { ...ceiling, maxSampleOffsetExclusive: 230_400_001 },
      { ...ceiling, ceilingId: 'not-a-uuid' },
      { ...ack, tracks: [ack.tracks[0], ack.tracks[0]] },
      { ...ack, tracks: [...ack.tracks, ack.tracks[0]] },
      { ...ack, tracks: [{ ...ack.tracks[0], finalSampleOffset: 230_400_001 }, ack.tracks[1]] },
      { ...ack, privateSessionId: 'server-only' }
    ]) {
      expect(
        'type' in invalid && invalid.type === 'capture-ceiling'
          ? CloudSpeechCaptureCeilingEventSchema.safeParse(invalid).success
          : CloudSpeechCaptureCeilingAckSchema.safeParse(invalid).success
      ).toBe(false)
    }
  })

  it('binds closed and opened epoch inventories to the exact capture and opaque handoff receipt', () => {
    const closed = {
      type: 'epoch-transition',
      captureId: start.captureId,
      captureGeneration: capture.generation,
      transitionId: 4,
      handoffNonce: '00000000-0000-4000-8000-000000000701',
      stage: 'closed',
      streams: [
        { track: 'microphone', previousEpoch: 11, lastSequence: 200 },
        { track: 'system', previousEpoch: 8, lastSequence: 198 }
      ]
    }
    const opened = {
      ...closed,
      stage: 'opened',
      streams: [
        { track: 'microphone', previousEpoch: 11, nextEpoch: 15, lastSequence: 200 },
        { track: 'system', previousEpoch: 8, nextEpoch: 10, lastSequence: 198 }
      ]
    }
    expect(CloudSpeechEpochTransitionEventSchema.safeParse(closed).success).toBe(true)
    expect(CloudSpeechEpochTransitionEventSchema.safeParse(opened).success).toBe(true)
    expect(CloudSpeechEventSchema.safeParse(closed).success).toBe(true)
    expect(
      CloudSpeechEpochTransitionAckSchema.safeParse({
        ...closed,
        type: 'epoch-transition-ack'
      }).success
    ).toBe(true)

    for (const invalid of [
      { ...closed, streams: [...closed.streams, closed.streams[0]] },
      { ...closed, streams: [{ ...closed.streams[0], nextEpoch: 12 }] },
      { ...opened, streams: [{ ...opened.streams[0], nextEpoch: 11 }, opened.streams[1]] },
      { ...opened, streams: [{ ...opened.streams[0], nextEpoch: 10 }, opened.streams[1]] },
      { ...closed, transitionId: 0 },
      { ...closed, handoffNonce: 'not-a-random-nonce' },
      { ...closed, brokerSessionId: 'server-secret-id' },
      { ...closed, tracks: ['microphone', 'system'] }
    ]) {
      expect(CloudSpeechEpochTransitionEventSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('requires strict explicit consent, matching capture identity and a supported cloud engine', () => {
    expect(CloudSpeechStartRequestSchema.safeParse(start).success).toBe(true)
    expect(CloudSpeechStartRequestSchema.safeParse({ ...start, rawToken: 'secret' }).success).toBe(false)
    expect(CloudSpeechStartRequestSchema.safeParse({ ...start, capture: { ...capture, generation: 0 } }).success).toBe(
      false
    )
    expect(
      CloudSpeechStartRequestSchema.safeParse({
        ...start,
        consent: { accepted: false, disclosureVersion: 'cloud-speech-v1' }
      }).success
    ).toBe(false)
    expect(
      CloudSpeechStartRequestSchema.safeParse({
        ...start,
        capture: { ...capture, engine: 'soniox' }
      }).success
    ).toBe(false)
    expect(
      CloudSpeechStartRequestSchema.safeParse({
        ...start,
        capture: { ...capture, capturedTracks: [] }
      }).success
    ).toBe(false)
  })

  it('accepts exactly one full 100 ms PCM frame and bounded nonempty sealed remainders', () => {
    expect(CloudSpeechFrameSchema.safeParse(frame()).success).toBe(true)
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: new ArrayBuffer(3_198) })).success).toBe(false)
    expect(CloudSpeechFrameSchema.safeParse(frame({ kind: 'sealed-final', pcm16le: new ArrayBuffer(2) })).success).toBe(
      true
    )
    expect(
      CloudSpeechFrameSchema.safeParse(frame({ kind: 'sealed-final', pcm16le: new ArrayBuffer(3_198) })).success
    ).toBe(true)
    for (const bytes of [0, 1, 3_200, 3_202]) {
      expect(
        CloudSpeechFrameSchema.safeParse(frame({ kind: 'sealed-final', pcm16le: new ArrayBuffer(bytes) })).success
      ).toBe(false)
    }
    expect(CloudSpeechFrameSchema.safeParse(frame({ unknown: true })).success).toBe(false)
  })

  it('rejects typed views, shared, resizable, detached and spoofed PCM buffers', () => {
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: new Uint8Array(3_200) })).success).toBe(false)
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: new SharedArrayBuffer(3_200) })).success).toBe(false)
    }
    const bufferConstructor = ArrayBuffer as typeof ArrayBuffer & {
      new (length: number, options: { maxByteLength: number }): ArrayBuffer
    }
    const resizable = new bufferConstructor(3_200, { maxByteLength: 6_400 })
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: resizable })).success).toBe(false)
    const detached = new ArrayBuffer(3_200)
    structuredClone(detached, { transfer: [detached] })
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: detached })).success).toBe(false)
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: { byteLength: 3_200 } })).success).toBe(false)
  })

  it('rejects invalid counters and sample-frontier overflow', () => {
    expect(CloudSpeechFrameSchema.safeParse(frame({ sequence: 0 })).success).toBe(false)
    expect(CloudSpeechFrameSchema.safeParse(frame({ sequence: Number.MAX_SAFE_INTEGER + 1 })).success).toBe(false)
    expect(CloudSpeechFrameSchema.safeParse(frame({ sampleOffset: Number.MAX_SAFE_INTEGER - 799 })).success).toBe(false)
  })

  it('requires finish to describe every unique captured track with a safe exact frontier', () => {
    expect(
      CloudSpeechFinishRequestSchema.safeParse({
        captureId: start.captureId,
        captureGeneration: capture.generation,
        tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }]
      }).success
    ).toBe(true)
    expect(
      CloudSpeechFinishRequestSchema.safeParse({
        captureId: start.captureId,
        captureGeneration: capture.generation,
        tracks: [
          { track: 'microphone', finalSequence: 0, finalSampleOffset: 0 },
          { track: 'microphone', finalSequence: 0, finalSampleOffset: 0 }
        ]
      }).success
    ).toBe(false)
    expect(
      CloudSpeechFinishRequestSchema.safeParse({
        captureId: start.captureId,
        captureGeneration: capture.generation,
        tracks: [{ track: 'microphone', finalSequence: -1, finalSampleOffset: 0 }]
      }).success
    ).toBe(false)
    expect(
      CloudSpeechFinishRequestSchema.safeParse({
        captureId: start.captureId,
        captureGeneration: capture.generation,
        tracks: [{ track: 'microphone', finalSequence: 0, finalSampleOffset: 1 }]
      }).success
    ).toBe(false)
  })

  it('keeps capability refusal and closure evidence internally consistent', () => {
    const route = { engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' }
    expect(
      CloudSpeechCapabilitySchema.safeParse({
        disclosureVersion: 'cloud-speech-v1',
        selected: null,
        allowed: [],
        ready: false,
        refusal: null
      }).success
    ).toBe(false)
    expect(
      CloudSpeechCapabilitySchema.safeParse({
        disclosureVersion: 'cloud-speech-v1',
        selected: route,
        allowed: [route],
        ready: true,
        refusal: null
      }).success
    ).toBe(true)
    expect(
      CloudSpeechCapabilitySchema.safeParse({
        disclosureVersion: 'cloud-speech-v1',
        selected: route,
        allowed: [],
        ready: true,
        refusal: null
      }).success
    ).toBe(false)

    const closure = {
      stream: { generation: capture.generation, track: 'microphone', epoch: 1 },
      lastSequence: 0,
      closeConfirmed: false,
      tail: 'complete',
      reason: 'normal'
    }
    const finish = {
      ok: true,
      captureId: start.captureId,
      captureGeneration: capture.generation,
      complete: false,
      tracks: [closure],
      reason: 'normal'
    }
    expect(CloudSpeechFinishResultSchema.safeParse(finish).success).toBe(false)
    expect(
      CloudSpeechFinishResultSchema.safeParse({
        ...finish,
        complete: true,
        tracks: [{ ...closure, closeConfirmed: true }]
      }).success
    ).toBe(true)
    expect(
      CloudSpeechFinishResultSchema.safeParse({
        ...finish,
        complete: true,
        tracks: [
          {
            ...closure,
            closeConfirmed: true,
            stream: { ...closure.stream, generation: capture.generation + 1 }
          }
        ]
      }).success
    ).toBe(false)
    expect(
      CloudSpeechFinishResultSchema.safeParse({
        ...finish,
        complete: true,
        reason: 'cancelled',
        tracks: [{ ...closure, closeConfirmed: true }]
      }).success
    ).toBe(false)

    const status = {
      ok: true,
      captureId: start.captureId,
      captureGeneration: capture.generation,
      state: 'closed',
      tracks: [
        {
          stream: closure.stream,
          phase: 'closed',
          lastSequence: 0,
          closeConfirmed: true,
          tail: 'incomplete'
        }
      ]
    }
    expect(CloudSpeechStatusResultSchema.safeParse(status).success).toBe(true)
    expect(
      CloudSpeechStatusResultSchema.safeParse({
        ...status,
        tracks: [{ ...status.tracks[0], stream: { ...status.tracks[0].stream, generation: 99 } }]
      }).success
    ).toBe(false)
    expect(
      CloudSpeechStatusResultSchema.safeParse({
        ...status,
        state: 'active',
        tracks: [{ ...status.tracks[0], phase: 'open', closeConfirmed: false, tail: null }]
      }).success
    ).toBe(true)
    expect(
      CloudSpeechStatusResultSchema.safeParse({
        ...status,
        state: 'active',
        tracks: [{ ...status.tracks[0], phase: 'open', closeConfirmed: true, tail: null }]
      }).success
    ).toBe(false)
    expect(
      CloudSpeechStatusResultSchema.safeParse({
        ...status,
        state: 'closing',
        tracks: [
          status.tracks[0],
          {
            stream: { generation: capture.generation, track: 'system', epoch: 2 },
            phase: 'closing',
            lastSequence: 3,
            closeConfirmed: false,
            tail: null
          }
        ]
      }).success
    ).toBe(true)
    expect(
      CloudSpeechStatusResultSchema.safeParse({
        ...status,
        state: 'active',
        tracks: []
      }).success
    ).toBe(false)
    expect(
      CloudSpeechStatusResultSchema.safeParse({
        ...status,
        tracks: [status.tracks[0], status.tracks[0]]
      }).success
    ).toBe(false)
  })

  it('wraps existing speech segments in strict bounded event envelopes without relay identity', () => {
    const event = {
      type: 'segment',
      captureId: start.captureId,
      captureGeneration: capture.generation,
      sequence: 1,
      segment: {
        stream: { generation: capture.generation, track: 'microphone', epoch: 1 },
        engine: 'deepgram-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'bonjour',
        startMs: 0,
        endMs: 100
      },
      languages: ['fr'],
      words: [{ text: 'bonjour', startMs: 0, endMs: 100, language: 'fr' }]
    }
    expect(CloudSpeechEventSchema.safeParse(event).success).toBe(true)
    expect(CloudSpeechEventSchema.safeParse({ ...event, sessionId: 'private' }).success).toBe(false)
    expect(
      CloudSpeechEventSchema.safeParse({
        ...event,
        words: Array.from({ length: 257 }, () => ({ text: 'x', startMs: 0, endMs: 1 }))
      }).success
    ).toBe(false)
    expect(
      CloudSpeechEventSchema.safeParse({
        type: 'terminal',
        captureId: start.captureId,
        captureGeneration: capture.generation,
        stream: { generation: capture.generation, track: 'microphone', epoch: 1 },
        lastSequence: 0,
        closeConfirmed: false,
        tail: 'complete',
        reason: 'normal'
      }).success
    ).toBe(false)
  })
})
