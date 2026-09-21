import { describe, expect, it } from 'vitest'
import { captureHealthForTrack, captureHealthIfCurrent, micSelectionOutcome } from './listen'

describe('live microphone capture health', () => {
  it('distinguishes a selected-device capture from its system-default fallback', () => {
    expect(micSelectionOutcome(true, false)).toBe('requested-device')
    expect(micSelectionOutcome(true, true)).toBe('fallback-default')
    expect(micSelectionOutcome(false, false)).toBe('system-default')
  })

  it('never calls a failed fallback an active fallback source', () => {
    expect(micSelectionOutcome(true, true, true)).toBe('unavailable')
    expect(micSelectionOutcome(false, false, true)).toBe('unavailable')
    expect(captureHealthForTrack(null, true, 'unavailable')).toMatchObject({
      selectionOutcome: 'unavailable',
      trackState: 'unavailable'
    })
  })

  it('reports the actual selected capture track format without exposing its device identity', () => {
    const health = captureHealthForTrack(
      { readyState: 'live', getSettings: () => ({ sampleRate: 48000, channelCount: 2, deviceId: 'private-device-id' }) },
      true,
      'requested-device'
    )

    expect(health).toEqual({
      requestedDevice: true,
      selectionOutcome: 'requested-device',
      inputSampleRate: 48000,
      inputChannelCount: 2,
      processingSampleRate: 16000,
      trackState: 'connected'
    })
    expect(health).not.toHaveProperty('deviceId')
  })

  it('makes a failed selected-device request explicit while retaining only fallback track facts', () => {
    expect(
      captureHealthForTrack(
        { readyState: 'live', getSettings: () => ({ sampleRate: 44100, channelCount: 1, deviceId: 'default-device-id' }) },
        true,
        'fallback-default'
      )
    ).toMatchObject({
      requestedDevice: true,
      selectionOutcome: 'fallback-default',
      inputSampleRate: 44100,
      inputChannelCount: 1,
      processingSampleRate: 16000,
      trackState: 'connected'
    })
  })

  it('does not let a retired capture epoch overwrite the current session health', () => {
    const current = captureHealthForTrack(null, false, 'system-default')
    const stale = captureHealthForTrack(null, true, 'fallback-default')

    expect(captureHealthIfCurrent(8, 7, current, stale)).toBe(current)
    expect(captureHealthIfCurrent(8, 8, current, stale)).toBe(stale)
  })
})
