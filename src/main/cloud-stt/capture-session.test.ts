import { describe, expect, it, vi } from 'vitest'
import type {
  CloudSpeechCaptureCeilingAck,
  CloudSpeechEpochTransitionAck,
  CloudSpeechEpochTransitionEvent
} from '../../shared/cloud-speech'
import { MainSpeechCaptureSession } from './capture-session'

const captureId = 'b8ff8685-725b-40e0-a8ef-f343bb10b64f'

function acknowledgement(event: CloudSpeechEpochTransitionEvent): CloudSpeechEpochTransitionAck {
  return { ...event, type: 'epoch-transition-ack' } as CloudSpeechEpochTransitionAck
}

describe('main speech capture transition owner', () => {
  it('requires the exact applied receipt, keeps one prior receipt for retries, and rejects conflicting receipts', async () => {
    const h = new MainSpeechCaptureSession({
      captureId,
      captureGeneration: 7,
      tracks: ['microphone'],
      startedAt: 10,
      monotonicNow: () => 0
    })
    const { event: closed, applied: waiting } = h.beginTransition(
      'closed',
      [{ track: 'microphone', previousEpoch: 3, lastSequence: 8 }],
      20
    )
    expect(h.acknowledge({ ...acknowledgement(closed), handoffNonce: '2d3c0b36-b0d1-40c6-8b13-a3b0239ca790' })).toBe(
      false
    )
    expect(h.acknowledge(acknowledgement(closed))).toBe(true)
    await expect(waiting).resolves.toBe(true)
    h.completeTransition()
    expect(h.acknowledge(acknowledgement(closed))).toBe(true)

    const { event: opened, applied: next } = h.beginTransition(
      'opened',
      [{ track: 'microphone', previousEpoch: 3, nextEpoch: 9, lastSequence: 8 }],
      20
    )
    expect(opened.transitionId).toBe(closed.transitionId)
    expect(opened.handoffNonce).toBe(closed.handoffNonce)
    expect(h.acknowledge({ ...acknowledgement(opened), streams: [] } as never)).toBe(false)
    expect(h.acknowledge(acknowledgement(opened))).toBe(true)
    await expect(next).resolves.toBe(true)
    h.completeTransition()
    expect(h.acknowledge(acknowledgement(closed))).toBe(false)
  })

  it('pairs opened receipts only with the acknowledged closed inventory and strictly newer epochs', async () => {
    const h = new MainSpeechCaptureSession({
      captureId,
      captureGeneration: 2,
      tracks: ['microphone'],
      startedAt: 0,
      monotonicNow: () => 0
    })
    const { event: closed, applied } = h.beginTransition(
      'closed',
      [{ track: 'microphone', previousEpoch: 4, lastSequence: 12 }],
      10
    )
    h.acknowledge(acknowledgement(closed))
    await expect(applied).resolves.toBe(true)
    h.completeTransition()

    expect(() =>
      h.beginTransition('opened', [{ track: 'microphone', previousEpoch: 4, nextEpoch: 5, lastSequence: 11 }], 10)
    ).toThrow('speech transition inventory or deadline is invalid')
    expect(() =>
      h.beginTransition('opened', [{ track: 'microphone', previousEpoch: 4, nextEpoch: 4, lastSequence: 12 }], 10)
    ).toThrow('speech transition inventory or deadline is invalid')

    const { event: opened, applied: openedApplied } = h.beginTransition(
      'opened',
      [{ track: 'microphone', previousEpoch: 4, nextEpoch: 8, lastSequence: 12 }],
      10
    )
    expect(opened.transitionId).toBe(closed.transitionId)
    expect(opened.handoffNonce).toBe(closed.handoffNonce)
    h.acknowledge(acknowledgement(opened))
    await expect(openedApplied).resolves.toBe(true)
  })

  it('reserves at most one unresolved invoke per track and expires it at the original deadline', () => {
    let now = 1
    let expire!: () => void
    const schedule = vi.fn((run: () => void) => {
      expire = run
      return () => undefined
    })
    const h = new MainSpeechCaptureSession({
      captureId,
      captureGeneration: 7,
      tracks: ['microphone'],
      startedAt: 0,
      monotonicNow: () => now,
      schedule
    })
    h.phase = 'closing-old'
    const resolve = vi.fn()
    const expired = vi.fn()
    expect(h.reserveFrame('microphone', { sequence: 4 }, 10, resolve, { ok: false }, expired)).toBe(true)
    expect(h.reserveFrame('microphone', { sequence: 4 }, 10, resolve, { ok: false }, expired)).toBe(false)
    now = 10
    expire()
    expect(resolve).toHaveBeenCalledWith({ ok: false })
    expect(expired).toHaveBeenCalledTimes(1)
    expect(h.takePendingFrames()).toEqual([])
  })

  it('expires pending receipts at their absolute monotonic deadline and invalidates unresolved waits', async () => {
    let now = 12
    let expire!: () => void
    const schedule = vi.fn((run: () => void, delay: number) => {
      expect(delay).toBe(8)
      expire = run
      return () => undefined
    })
    const h = new MainSpeechCaptureSession({
      captureId,
      captureGeneration: 7,
      tracks: ['microphone'],
      startedAt: 0,
      monotonicNow: () => now,
      schedule
    })
    const { event, applied: waiting } = h.beginTransition(
      'closed',
      [{ track: 'microphone', previousEpoch: 3, lastSequence: 8 }],
      20
    )
    now = 20
    expire()
    await expect(waiting).resolves.toBe(false)
    expect(h.acknowledge(acknowledgement(event))).toBe(false)

    h.invalidate()
    expect(h.phase).toBe('cancelled')
  })

  it('accepts one exact capture-ceiling receipt and retains only that completed receipt', async () => {
    let now = 10
    const h = new MainSpeechCaptureSession({
      captureId,
      captureGeneration: 4,
      tracks: ['microphone'],
      startedAt: 0,
      monotonicNow: () => now,
      schedule: (run, delay) => {
        expect(delay).toBe(5_000)
        return () => run
      }
    })
    const ceiling = h.beginCeiling(230_400_000, 5_010)
    expect(ceiling.event).toMatchObject({
      type: 'capture-ceiling',
      captureId,
      captureGeneration: 4,
      maxSampleOffsetExclusive: 230_400_000
    })
    const ack: CloudSpeechCaptureCeilingAck = {
      type: 'capture-ceiling-ack',
      captureId,
      captureGeneration: 4,
      ceilingId: ceiling.event.ceilingId,
      tracks: [{ track: 'microphone', finalSequence: 20, finalSampleOffset: 32_000 }]
    }
    // Before the first receipt, this owner enforces global bounds and exact identity/track inventory.
    // The IPC owner separately knows the captured PCM frontier.
    for (const invalid of [
      { ...ack, tracks: [{ ...ack.tracks[0], finalSampleOffset: 230_400_001 }] },
      { ...ack, captureGeneration: 5 },
      { ...ack, tracks: [{ ...ack.tracks[0], track: 'system' }] }
    ])
      expect(h.acknowledgeCeiling(invalid)).toBe(false)
    expect(h.acknowledgeCeiling(ack)).toBe(true)
    const conflicting = { ...ack, tracks: [{ ...ack.tracks[0], finalSampleOffset: 32_002 }] }
    expect(h.acknowledgeCeiling(conflicting)).toBe(false)
    expect(h.acknowledgeCeiling(ack)).toBe(true)
    await expect(ceiling.applied).resolves.toEqual(ack)
    h.completeCeiling()
    expect(h.acknowledgeCeiling(ack)).toBe(true)
    expect(h.acknowledgeCeiling(conflicting)).toBe(false)
    expect(h.acknowledgeCeiling({ ...ack, ceilingId: '00000000-0000-4000-8000-000000000999' })).toBe(false)
  })
})
