import { describe, expect, it } from 'vitest'
import {
  CloudSpeechEventSchema,
  CloudSpeechFinishRequestSchema,
  CloudSpeechFrameSchema,
  CloudSpeechStartRequestSchema,
  type CloudSpeechStartRequest
} from './cloud-speech'

const capture = {
  generation: 3,
  engine: 'deepgram-nova3',
  requestedTracks: ['microphone', 'system'],
  capturedTracks: ['microphone']
} as const

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
  it('requires strict explicit consent, matching capture identity and a supported cloud engine', () => {
    expect(CloudSpeechStartRequestSchema.safeParse(start).success).toBe(true)
    expect(CloudSpeechStartRequestSchema.safeParse({ ...start, rawToken: 'secret' }).success).toBe(false)
    expect(
      CloudSpeechStartRequestSchema.safeParse({
        ...start,
        capture: { ...capture, generation: capture.generation + 1 }
      }).success
    ).toBe(false)
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
    try {
      const resizable = new bufferConstructor(3_200, { maxByteLength: 6_400 })
      expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: resizable })).success).toBe(false)
    } catch {
      // Older test runtimes may not implement resizable ArrayBuffer; the fixed-byte checks still run.
    }
    const detached = new ArrayBuffer(3_200)
    structuredClone(detached, { transfer: [detached] })
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: detached })).success).toBe(false)
    expect(CloudSpeechFrameSchema.safeParse(frame({ pcm16le: { byteLength: 3_200 } })).success).toBe(false)
  })

  it('rejects unrequested tracks, invalid counters, and sample-frontier overflow', () => {
    expect(CloudSpeechFrameSchema.safeParse(frame({ track: 'system' })).success).toBe(false)
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
  })
})
