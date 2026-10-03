import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLoopbackSelfTest } from './loopback-self-test'

/**
 * M2-0429 — onboarding's "Meeting audio & screen" row turns green only on a REAL loopback: a live system-audio
 * track acquired the way Listen acquires it, then stopped. A permission status alone is not proof.
 */
function fakeTrack(readyState: 'live' | 'ended') {
  return { readyState, stop: vi.fn(), applyConstraints: vi.fn(async () => {}) }
}

function install(getDisplayMedia: () => Promise<unknown>) {
  const armAudio = vi.fn(async (_on: boolean) => {})
  vi.stubGlobal('window', { toto: { armAudio } })
  vi.stubGlobal('navigator', { platform: 'MacIntel', mediaDevices: { getDisplayMedia: vi.fn(getDisplayMedia) } })
  return { armAudio }
}

function stream(audio: ReturnType<typeof fakeTrack>[], video: ReturnType<typeof fakeTrack>[] = [fakeTrack('live')]) {
  return { getAudioTracks: () => audio, getTracks: () => [...audio, ...video] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runLoopbackSelfTest', () => {
  it('passes on a live system-audio track, then stops every track and disarms', async () => {
    const audio = fakeTrack('live')
    const video = fakeTrack('live')
    const { armAudio } = install(async () => stream([audio], [video]))
    await expect(runLoopbackSelfTest()).resolves.toBe(true)
    expect(audio.stop).toHaveBeenCalled()
    expect(video.stop).toHaveBeenCalled()
    expect(armAudio.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  it('fails when the grant came back without a live audio track', async () => {
    const audio = fakeTrack('ended')
    install(async () => stream([audio]))
    await expect(runLoopbackSelfTest()).resolves.toBe(false)
    expect(audio.stop).toHaveBeenCalled()
  })

  it('fails (never throws) when main denies the capture, and still disarms', async () => {
    const { armAudio } = install(async () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')))
    await expect(runLoopbackSelfTest()).resolves.toBe(false)
    expect(armAudio).toHaveBeenLastCalledWith(false)
  })
})
