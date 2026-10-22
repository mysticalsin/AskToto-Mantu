import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createListenAudioRecovery,
  themDeviceChangeAction,
  type ListenAudioRecoveryHost
} from './listen-audio-recovery'

function recoveryHost(overrides: Partial<ListenAudioRecoveryHost> = {}): ListenAudioRecoveryHost {
  return {
    currentEpoch: () => 3,
    admissionOpen: (epoch) => epoch === 3,
    wantsSystemAudio: () => false,
    wantsMic: () => true,
    micDeviceId: () => '',
    meetingStartedAt: () => 1_700_000_000_000,
    acquireMic: vi.fn(async () => {
      throw new Error('NotFoundError')
    }),
    acquireLoopback: vi.fn(async () => {
      throw new Error('unused')
    }),
    armAudio: vi.fn(async () => {}),
    openChannel: vi.fn(async () => true),
    hasChannel: () => false,
    stopStream: vi.fn(),
    publishMicRecoveryFailure: vi.fn(),
    micRecoverySucceeded: vi.fn(),
    micRecoveryFailed: vi.fn(),
    micRecoveryExhausted: vi.fn(),
    systemRecoverySucceeded: vi.fn(),
    systemRecoveryFailed: vi.fn(),
    isLive: () => true,
    isStopping: () => false,
    isPaused: () => false,
    isListening: () => true,
    scheduleThemProbation: vi.fn(),
    themChannel: () => undefined,
    themHeard: () => false,
    themWindowSeen: () => false,
    setThemWindowSeen: vi.fn(),
    onThemProbationRecycle: vi.fn(),
    themProbationDuration: () => 20_000,
    themDeviceChangeAction,
    retireMicForRecovery: vi.fn(async () => true),
    recoverMicNow: vi.fn(),
    recoverSystemNow: vi.fn(),
    setSystemPermissionNote: vi.fn(),
    getPermissions: vi.fn(async () => ({ screenRecording: 'granted' })),
    deviceChangeTarget: () => new EventTarget(),
    isWindows: () => false,
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Q03 mic recovery resilience (D2-3)', () => {
  it('device change re-arms mic recovery when the mic channel was lost', async () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const host = recoveryHost({ hasChannel: () => false, wantsMic: () => true, deviceChangeTarget: () => target })
    const recovery = createListenAudioRecovery(() => host)
    const dispose = recovery.watchDeviceChanges()

    target.dispatchEvent(new Event('devicechange'))
    await vi.advanceTimersByTimeAsync(800)

    expect(host.recoverMicNow).toHaveBeenCalledTimes(1)
    expect(host.retireMicForRecovery).not.toHaveBeenCalled()
    dispose()
  })

  it('does not re-arm the mic when the session does not want one', async () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const host = recoveryHost({ wantsMic: () => false, deviceChangeTarget: () => target })
    const dispose = createListenAudioRecovery(() => host).watchDeviceChanges()

    target.dispatchEvent(new Event('devicechange'))
    await vi.advanceTimersByTimeAsync(800)

    expect(host.recoverMicNow).not.toHaveBeenCalled()
    dispose()
  })

  it('failed recovery retries with backoff, then reports exhaustion', async () => {
    vi.useFakeTimers()
    const host = recoveryHost()
    const recovery = createListenAudioRecovery(() => host)

    await recovery.recoverMic()
    expect(host.acquireMic).toHaveBeenCalledTimes(1)
    expect(host.micRecoveryExhausted).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(host.acquireMic).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(host.acquireMic).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(host.acquireMic).toHaveBeenCalledTimes(4)

    expect(host.micRecoveryExhausted).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(host.acquireMic).toHaveBeenCalledTimes(4)
    expect(host.micRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops retrying once the admission epoch changes or the mic is no longer wanted', async () => {
    vi.useFakeTimers()
    let epoch = 3
    const host = recoveryHost({ currentEpoch: () => epoch, admissionOpen: (candidate) => candidate === epoch })
    const recovery = createListenAudioRecovery(() => host)

    await recovery.recoverMic()
    epoch = 4
    await vi.advanceTimersByTimeAsync(60_000)

    expect(host.acquireMic).toHaveBeenCalledTimes(1)
    expect(host.micRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('a successful retry opens the channel, resets the budget and never reports exhaustion', async () => {
    vi.useFakeTimers()
    const stream = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream
    const acquireMic = vi
      .fn()
      .mockRejectedValueOnce(new Error('NotFoundError'))
      .mockResolvedValue({ stream, track: {}, health: {} })
    const host = recoveryHost({ acquireMic: acquireMic as never })
    const recovery = createListenAudioRecovery(() => host)

    await recovery.recoverMic()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(host.openChannel).toHaveBeenCalledTimes(1)
    expect(host.micRecoverySucceeded).toHaveBeenCalledTimes(1)
    expect(host.micRecoveryExhausted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposing the device-change watcher cancels a pending retry', async () => {
    vi.useFakeTimers()
    const host = recoveryHost()
    const recovery = createListenAudioRecovery(() => host)
    const dispose = recovery.watchDeviceChanges()

    await recovery.recoverMic()
    expect(vi.getTimerCount()).toBe(1)
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
