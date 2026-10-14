import { describe, expect, it } from 'vitest'
import type {
  CloudSpeechEpochTransitionEvent,
  CloudSpeechStartRequest,
  CloudSpeechStartResult
} from '@shared/cloud-speech'
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
    tracker.markTerminalApplied(prior)
    tracker.markApplied(prior, terminal.lastSequence)

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

    const closed: Extract<CloudSpeechEpochTransitionEvent, { stage: 'closed' }> = {
      type: 'epoch-transition',
      captureId: request.captureId,
      captureGeneration: request.capture.generation,
      transitionId: 9,
      handoffNonce: '00000000-0000-4000-8000-000000000709',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 0 }]
    }
    const opened: Extract<CloudSpeechEpochTransitionEvent, { stage: 'opened' }> = {
      ...closed,
      stage: 'opened',
      streams: [{ track: 'microphone', previousEpoch: 3, nextEpoch: 9, lastSequence: 0 }]
    }
    expect(tracker.validateTransition(closed)).toBe(true)
    tracker.installTransition(closed)
    expect(tracker.validateTransition(opened)).toBe(true)
    tracker.installTransition(opened)
    const successor = {
      ...unannounced,
      segment: { ...unannounced.segment, stream: { ...prior, epoch: 9 }, text: 'announced' }
    }
    expect(tracker.validate(successor, 'cloudflare-nova3')).toEqual(successor)
  })

  it('refuses an opened inventory unless each predecessor terminal is applied and complete', () => {
    const tracker = createCloudSpeechResultTracker(request)
    tracker.initialize(started)
    const closed: Extract<CloudSpeechEpochTransitionEvent, { stage: 'closed' }> = {
      type: 'epoch-transition',
      captureId: request.captureId,
      captureGeneration: request.capture.generation,
      transitionId: 9,
      handoffNonce: '00000000-0000-4000-8000-000000000709',
      stage: 'closed',
      streams: [{ track: 'microphone', previousEpoch: 3, lastSequence: 0 }]
    }
    expect(tracker.validateTransition(closed)).toBe(false)

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
    tracker.markTerminalApplied(terminal.stream)
    tracker.markApplied(terminal.stream, terminal.lastSequence)
    expect(tracker.validateTransition(closed)).toBe(false)
  })

  it.each([
    { closeConfirmed: false, tail: 'incomplete' as const, reason: 'unknown' as const },
    { closeConfirmed: true, tail: 'incomplete' as const, reason: 'unknown' as const }
  ])('does not accept a closed transition without complete confirmed provider closure (%s)', (closure) => {
    const tracker = createCloudSpeechResultTracker(request)
    tracker.initialize(started)
    const terminal = {
      type: 'terminal' as const,
      captureId: request.captureId,
      captureGeneration: 7,
      stream: { generation: 7, track: 'microphone' as const, epoch: 3 },
      lastSequence: 0,
      closeConfirmed: closure.closeConfirmed,
      tail: closure.tail,
      reason: closure.reason
    }
    const closed = {
      type: 'epoch-transition' as const,
      captureId: request.captureId,
      captureGeneration: 7,
      transitionId: 9,
      handoffNonce: '00000000-0000-4000-8000-000000000709',
      stage: 'closed' as const,
      streams: [{ track: 'microphone' as const, previousEpoch: 3, lastSequence: 0 }]
    }

    expect(tracker.validate(terminal, 'cloudflare-nova3')).toEqual(terminal)
    tracker.markTerminalApplied(terminal.stream)
    tracker.markApplied(terminal.stream, terminal.lastSequence)
    expect(tracker.validateTransition(closed)).toBe(false)
  })
})
