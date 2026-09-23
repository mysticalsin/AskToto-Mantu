import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandMicController } from './use-command-mic'

let stopTracks: ReturnType<typeof vi.fn>
let getUserMedia: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  stopTracks = vi.fn()
  getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: stopTracks }]
  }))
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: (constraints: unknown) => getUserMedia(constraints) }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bounded command microphone capture', () => {
  it('stops its microphone track at the command timeout without retaining audio', async () => {
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    })
    expect(capture.getSnapshot()).toMatchObject({ status: 'listening' })

    await vi.advanceTimersByTimeAsync(8_001)

    expect(capture.getSnapshot()).toMatchObject({ status: 'finalizing', reason: 'timeout' })
    expect(stopTracks).toHaveBeenCalledTimes(1)
  })

  it('stops a late microphone stream after cancellation during permission acquisition', async () => {
    let resolveStream: ((stream: { getTracks: () => Array<{ stop: () => void }> }) => void) | null = null
    getUserMedia = vi.fn(
      () =>
        new Promise<{ getTracks: () => Array<{ stop: () => void }> }>((resolve) => {
          resolveStream = resolve
        })
    )
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    const starting = capture.start()
    capture.cancel()
    resolveStream?.({ getTracks: () => [{ stop: stopTracks }] })
    await starting

    expect(stopTracks).toHaveBeenCalledTimes(1)
    expect(capture.getSnapshot()).toMatchObject({ status: 'finalizing', reason: 'cancelled' })
  })

  it('releases an active microphone when the owner unmounts', async () => {
    const capture = createCommandMicController({ maxDurationMs: 8_000 })
    await capture.start()

    capture.dispose()

    expect(stopTracks).toHaveBeenCalledTimes(1)
  })

  it('keeps a microphone permission failure visible until the user retries or cancels', async () => {
    getUserMedia = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(capture.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
  })

  it('releases an active command microphone immediately when its track ends', async () => {
    let onEnded: (() => void) | undefined
    const track = {
      stop: stopTracks,
      addEventListener: (type: string, callback: () => void): void => {
        if (type === 'ended') onEnded = callback
      },
      removeEventListener: vi.fn()
    }
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track]
    }))
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()
    onEnded?.()

    expect(stopTracks).toHaveBeenCalledTimes(1)
    expect(capture.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
  })

  it('releases a microphone stream if setup fails after permission is granted', async () => {
    const track = {
      stop: stopTracks,
      addEventListener: (): never => {
        throw new Error('setup failed')
      },
      removeEventListener: vi.fn()
    }
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track]
    }))
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()

    expect(stopTracks).toHaveBeenCalledTimes(1)
    expect(capture.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
  })

  it('rejects a resolved stream with no active audio track', async () => {
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [],
      getAudioTracks: () => []
    }))
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()

    expect(capture.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
  })

  it('does not overwrite a synchronous track-ended error with listening', async () => {
    const track = {
      readyState: 'live',
      stop: stopTracks,
      addEventListener: (type: string, callback: () => void): void => {
        if (type === 'ended') callback()
      },
      removeEventListener: vi.fn()
    }
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track]
    }))
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()

    expect(stopTracks).toHaveBeenCalledTimes(1)
    expect(capture.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
  })

  it('does not retain a timeout when audio-track discovery throws after permission is granted', async () => {
    const track = { stop: stopTracks }
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: (): never => {
        throw new Error('track lookup failed')
      }
    }))
    const capture = createCommandMicController({ maxDurationMs: 8_000 })

    await capture.start()

    expect(stopTracks).toHaveBeenCalledTimes(1)
    expect(capture.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
