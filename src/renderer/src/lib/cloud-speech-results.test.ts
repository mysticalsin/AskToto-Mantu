import { describe, expect, it } from 'vitest'
import type { CloudSpeechStartRequest, CloudSpeechStartResult } from '@shared/cloud-speech'
import { createCloudSpeechResultTracker } from './cloud-speech-results'

const request: CloudSpeechStartRequest = {
  captureId: '9d87dc1a-0a52-4a5e-bbc2-f44320890cd4',
  capture: {
    generation: 7,
    engine: 'cloudflare-nova3',
    requestedTracks: ['microphone'],
    capturedTracks: ['microphone']
  },
  language: 'auto',
  consent: { accepted: true, disclosureVersion: 'cloud-speech-v1' }
}

const started: Extract<CloudSpeechStartResult, { ok: true }> = {
  ok: true,
  captureId: request.captureId,
  captureGeneration: request.capture.generation,
  engine: 'cloudflare-nova3',
  streams: [{ track: 'microphone', streamEpoch: 3 }],
  limits: { frameBytes: 3_200, maxPendingFrames: 20, maxPendingBytes: 65_536, maxPendingAudioMs: 2_000 }
}

describe('cloud speech result epoch tracking', () => {
  it('rejects implicit epoch increments and accepts only a fully applied announced successor', () => {
    const tracker = createCloudSpeechResultTracker(request)
    tracker.initialize(started)
    const prior = { generation: 7, track: 'microphone' as const, epoch: 3 }
    const terminal = {
      type: 'terminal' as const,
      captureId: request.captureId,
      captureGeneration: 7,
      stream: prior,
      lastSequence: 0,
      closeConfirmed: true,
      tail: 'complete' as const,
      reason: 'normal' as const
    }
    expect(tracker.validate(terminal, 'cloudflare-nova3')).toEqual(terminal)
    tracker.markApplied(terminal)

    const unannounced = {
      type: 'segment' as const,
      captureId: request.captureId,
      captureGeneration: 7,
      sequence: 1,
      segment: {
        stream: { ...prior, epoch: 4 },
        engine: 'cloudflare-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'unannounced',
        startMs: 0,
        endMs: 10
      }
    }
    expect(tracker.validate(unannounced, 'cloudflare-nova3')).toBeNull()

    expect(
      tracker.installEpochTransition([{ track: 'microphone', previousEpoch: 3, nextEpoch: 9, lastSequence: 0 }])
    ).toBe(true)
    const successor = {
      ...unannounced,
      segment: { ...unannounced.segment, stream: { ...prior, epoch: 9 }, text: 'announced' }
    }
    expect(tracker.validate(successor, 'cloudflare-nova3')).toEqual(successor)
  })

  it('refuses an opened inventory unless each predecessor terminal is applied and complete', () => {
    const tracker = createCloudSpeechResultTracker(request)
    tracker.initialize(started)
    expect(
      tracker.installEpochTransition([{ track: 'microphone', previousEpoch: 3, nextEpoch: 9, lastSequence: 0 }])
    ).toBe(false)

    const terminal = {
      type: 'terminal' as const,
      captureId: request.captureId,
      captureGeneration: 7,
      stream: { generation: 7, track: 'microphone' as const, epoch: 3 },
      lastSequence: 0,
      closeConfirmed: false,
      tail: 'incomplete' as const,
      reason: 'unknown' as const
    }
    expect(tracker.validate(terminal, 'cloudflare-nova3')).toEqual(terminal)
    tracker.markApplied(terminal)
    expect(
      tracker.installEpochTransition([{ track: 'microphone', previousEpoch: 3, nextEpoch: 9, lastSequence: 0 }])
    ).toBe(false)
  })
})
