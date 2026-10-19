import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ListenAudioChannelsHost } from './listen-audio-channels'
import { createListenAudioChannels } from './listen-audio-channels'
import type { ListenAudioRecovery, ListenAudioRecoveryHost } from './listen-audio-recovery'
import { failBrokerCaptureRecovery, themDeviceChangeAction, themTracksLookDead } from './listen-audio-recovery'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeTrack(): MediaStreamTrack & {
  applyConstraints: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  return {
    kind: 'audio',
    readyState: 'live',
    muted: false,
    onended: null,
    applyConstraints: vi.fn(async () => {}),
    stop: vi.fn(),
    getSettings: () => ({ sampleRate: 48000, channelCount: 1 })
  } as unknown as MediaStreamTrack & {
    applyConstraints: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }
}

function fakeStream(...tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio')
  } as unknown as MediaStream
}

type FakeNode = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }

function fakeNode(): FakeNode {
  return { connect: vi.fn(), disconnect: vi.fn() }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static addModule: () => Promise<void> = async () => {}
  static actualSampleRate = 16000

  readonly sampleRate = FakeAudioContext.actualSampleRate
  readonly destination = {}
  readonly audioWorklet = { addModule: (): Promise<void> => FakeAudioContext.addModule() }
  readonly source = fakeNode()
  readonly gain = { ...fakeNode(), gain: { value: 1 } }
  readonly limiter = {
    ...fakeNode(),
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 }
  }
  readonly close = vi.fn(async () => {})
  readonly suspend = vi.fn(async () => {})
  readonly resume = vi.fn(async () => {})
  state = 'running'
  onstatechange: (() => void) | null = null

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource(): FakeNode {
    return this.source
  }

  createGain(): typeof this.gain {
    return this.gain
  }

  createDynamicsCompressor(): typeof this.limiter {
    return this.limiter
  }
}

class FakeAudioWorkletNode {
  readonly port = { onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn() }
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()

  constructor(
    _context: AudioContext,
    readonly processorName: string,
    readonly options: AudioWorkletNodeOptions
  ) {}
}

function channelHost(overrides: Partial<ListenAudioChannelsHost> = {}): ListenAudioChannelsHost {
  return {
    isAdmissionOpen: () => true,
    isLive: () => true,
    isStopping: () => false,
    isPaused: () => false,
    isBrokerCapture: () => false,
    currentEpoch: () => 1,
    startedAt: () => 10,
    updateCaptureTrack: vi.fn(() => true),
    publishMicCapture: vi.fn(),
    armNoSpeechWarning: vi.fn(),
    clearNoSpeechWarning: vi.fn(),
    clearThemProbation: vi.fn(),
    onThemChannelOpened: vi.fn(),
    themHeard: () => false,
    themWatchdogDelay: () => 1000,
    onThemWatchdogExpired: vi.fn(),
    onFlushAck: vi.fn(),
    onAudio: vi.fn(),
    onThemWindow: vi.fn(),
    onUnexpectedTrackEnd: vi.fn(),
    onContextState: vi.fn(),
    whisperWorkletUrl: () => 'whisper-worklet.js',
    cloudWorkletUrl: () => 'cloud-worklet.js',
    ...overrides
  }
}

function recoveryHost(overrides: Partial<ListenAudioRecoveryHost> = {}): ListenAudioRecoveryHost {
  return {
    currentEpoch: () => 1,
    admissionOpen: () => true,
    wantsSystemAudio: () => true,
    micDeviceId: () => '',
    acquireMic: vi.fn(async () => ({ stream: fakeStream(fakeTrack()), track: fakeTrack(), health: {} as never })),
    acquireLoopback: vi.fn(async () => fakeStream(fakeTrack())),
    armAudio: vi.fn(async () => {}),
    openChannel: vi.fn(async () => true),
    hasChannel: () => false,
    stopStream: vi.fn(),
    publishMicRecoveryFailure: vi.fn(),
    micRecoverySucceeded: vi.fn(),
    micRecoveryFailed: vi.fn(),
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
    deviceChangeTarget: () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    isWindows: () => false,
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeAudioContext.instances = []
  FakeAudioContext.addModule = async () => {}
  FakeAudioContext.actualSampleRate = 16000
  vi.resetModules()
})

describe('MQA-267: loopback acquisition keeps rendered system audio unprocessed', () => {
  it('uses non-processing constraints for both Windows acquisition attempts and keeps the granted track', async () => {
    const track = fakeTrack()
    const stream = fakeStream(track)
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error('audio-only unavailable'))
      .mockResolvedValueOnce(stream)
    vi.stubGlobal('navigator', { platform: 'Win32', mediaDevices: { getDisplayMedia } })
    vi.resetModules()
    const { acquireLoopback } = await import('./listen-audio-recovery')

    await expect(acquireLoopback()).resolves.toBe(stream)

    expect(getDisplayMedia).toHaveBeenCalledTimes(2)
    expect(getDisplayMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    expect(getDisplayMedia.mock.calls[0]?.[0]).not.toHaveProperty('video')
    expect(getDisplayMedia.mock.calls[1]?.[0]).toMatchObject({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    expect(track.applyConstraints).toHaveBeenCalledWith({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    })
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('uses a video-bound system stream on macOS and keeps mic echo cancellation enabled', async () => {
    const track = fakeTrack()
    track.applyConstraints.mockRejectedValueOnce(new Error('live constraints unsupported'))
    const videoTrack = { ...fakeTrack(), kind: 'video' } as unknown as MediaStreamTrack & {
      stop: ReturnType<typeof vi.fn>
    }
    const stream = fakeStream(track, videoTrack)
    const getDisplayMedia = vi.fn(async () => stream)
    const getUserMedia = vi.fn(async () => stream)
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      mediaDevices: { getDisplayMedia, getUserMedia }
    })
    vi.stubGlobal('window', {
      toto: {
        onMeetingMicCaptureRevoked: () => () => {},
        meetingMicAdmission: vi.fn(async (startedAt: number) => ({
          captureId: '00000000-0000-4000-8000-000000000001',
          startedAt
        })),
        confirmMeetingMicCapture: vi.fn(async () => true),
        releaseMeetingMicCapture: vi.fn(async () => true)
      }
    })
    vi.resetModules()
    const { acquireLoopback, acquireMic } = await import('./listen-audio-recovery')

    await expect(acquireLoopback()).resolves.toBe(stream)
    await acquireMic('', 123)

    expect(getDisplayMedia).toHaveBeenCalledTimes(1)
    expect(getDisplayMedia.mock.calls[0]?.[0]).toMatchObject({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    expect(track.stop).not.toHaveBeenCalled()
    expect(videoTrack.stop).not.toHaveBeenCalled()
  })
})

describe('MQA-268: owned audio channels preserve the limiter graph and serialized recovery', () => {
  it('passes the actual source rate to the worklet and admits only 16 kHz audio callbacks', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
    FakeAudioContext.actualSampleRate = 48000
    const host = channelHost()
    const channels = createListenAudioChannels(() => host)

    await expect(channels.open('you', fakeStream(fakeTrack()), 1)).resolves.toBe(true)

    const context = FakeAudioContext.instances[0]
    const worklet = channels.current.you?.worklet as unknown as FakeAudioWorkletNode | undefined
    expect(context?.sampleRate).toBe(48000)
    expect(worklet?.options.processorOptions).toEqual({ sourceSampleRate: 48000 })

    const audio = new Float32Array([0.25, -0.25])
    worklet?.port.onmessage?.({ data: { audio } } as MessageEvent)
    worklet?.port.onmessage?.({ data: { audio, sampleRate: 48000, partial: true } } as MessageEvent)
    expect(host.onAudio).not.toHaveBeenCalled()

    worklet?.port.onmessage?.({ data: { audio, sampleRate: 16000, partial: true } } as MessageEvent)
    expect(host.onAudio).toHaveBeenCalledOnce()
    expect(host.onAudio).toHaveBeenCalledWith('you', audio, true, 10)

    const themStream = fakeStream(fakeTrack())
    await expect(channels.open('them', themStream, 1)).resolves.toBe(true)
    const themWorklet = channels.current.them?.worklet as unknown as FakeAudioWorkletNode | undefined
    const themAudio = new Float32Array([-0.5, 0.5])
    themWorklet?.port.onmessage?.({ data: { audio: themAudio, sampleRate: 16000, partial: false } } as MessageEvent)
    expect(host.onAudio).toHaveBeenCalledTimes(2)
    expect(host.onAudio).toHaveBeenLastCalledWith('them', themAudio, false, 10)
    channels.close('them')
    channels.close('you')
  })

  it('connects the system boost through the limiter and disconnects it with the channel', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
    const host = channelHost()
    const channels = createListenAudioChannels(() => host)
    const stream = fakeStream(fakeTrack())

    await expect(channels.open('them', stream, 1)).resolves.toBe(true)

    const context = FakeAudioContext.instances[0]
    expect(context?.source.connect).toHaveBeenCalledWith(context?.gain)
    expect(context?.gain.connect).toHaveBeenCalledWith(context?.limiter)
    expect(context?.limiter.connect).toHaveBeenCalledWith(expect.any(FakeAudioWorkletNode))
    expect(channels.current.them?.worklet.connect).toHaveBeenCalledWith(context?.destination)
    channels.close('them')
    expect(context?.limiter.disconnect).toHaveBeenCalledTimes(1)
  })

  it('serializes same-speaker opens and recovers after a failed module load', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
    const host = channelHost()
    const channels = createListenAudioChannels(() => host)
    const gate = deferred<void>()
    let loads = 0
    FakeAudioContext.addModule = () => {
      loads += 1
      return loads === 1 ? gate.promise : Promise.resolve()
    }
    const firstStream = fakeStream(fakeTrack())
    const secondStream = fakeStream(fakeTrack())
    const first = channels.open('them', firstStream, 1)
    const second = channels.open('them', secondStream, 1)
    await vi.waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1))

    gate.resolve()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(channels.current.them?.stream).toBe(secondStream)
    expect(firstStream.getTracks()[0]?.stop).toHaveBeenCalledTimes(1)

    channels.close('them')
    FakeAudioContext.instances = []
    loads = 0
    FakeAudioContext.addModule = () => {
      loads += 1
      return loads === 1 ? Promise.reject(new Error('worklet load failed')) : Promise.resolve()
    }
    const failed = channels.open('them', fakeStream(fakeTrack()), 1)
    const recoveredStream = fakeStream(fakeTrack())
    const recovered = channels.open('them', recoveredStream, 1)
    await expect(failed).rejects.toThrow('worklet load failed')
    await expect(recovered).resolves.toBe(true)
    expect(channels.current.them?.stream).toBe(recoveredStream)
  })

  it('re-reads the current host after module load before admitting or publishing a channel', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
    const gate = deferred<void>()
    FakeAudioContext.addModule = () => gate.promise
    const oldHost = channelHost()
    const latestAdmission = vi.fn(() => false)
    let currentHost = oldHost
    const channels = createListenAudioChannels(() => currentHost)
    const stream = fakeStream(fakeTrack())
    const opening = channels.open('you', stream, 1)
    await Promise.resolve()
    currentHost = channelHost({ isAdmissionOpen: latestAdmission })
    gate.resolve()

    await expect(opening).resolves.toBe(false)
    expect(latestAdmission).toHaveBeenCalledWith(1)
    expect(stream.getTracks()[0]?.stop).toHaveBeenCalledTimes(1)
    expect(channels.current.you).toBeUndefined()
  })
})

describe('device recovery uses current ownership and positive death evidence', () => {
  it('recovers a missing microphone and schedules system probation on a real device change', async () => {
    vi.useFakeTimers()
    const listener = { current: (() => {}) as () => void }
    const probation = { current: (() => {}) as () => void }
    let systemPresent = true
    const host = recoveryHost({
      hasChannel: (speaker) => speaker === 'you' || systemPresent,
      deviceChangeTarget: () => ({
        addEventListener: (_name: string, callback: EventListenerOrEventListenerObject) => {
          listener.current = callback as () => void
        },
        removeEventListener: vi.fn()
      }),
      scheduleThemProbation: (callback) => {
        probation.current = callback
      }
    })
    const { createListenAudioRecovery } = await import('./listen-audio-recovery')
    const recovery = createListenAudioRecovery(() => host)
    const unsubscribe = recovery.watchDeviceChanges()

    listener.current()
    await vi.advanceTimersByTimeAsync(800)

    expect(host.recoverMicNow).toHaveBeenCalledTimes(1)
    expect(host.retireMicForRecovery).toHaveBeenCalledWith(1)
    expect(probation.current).toBeTypeOf('function')
    systemPresent = false
    listener.current()
    await vi.advanceTimersByTimeAsync(800)
    expect(host.recoverSystemNow).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('recycles only the same admitted, dead channel after its probation window', async () => {
    vi.useFakeTimers()
    let epoch = 4
    let windowSeen = false
    let dead = true
    let heard = false
    const host = recoveryHost({
      currentEpoch: () => epoch,
      admissionOpen: (candidate) => candidate === epoch,
      themChannel: () =>
        ({
          stream: fakeStream({
            kind: 'audio',
            readyState: dead ? 'ended' : 'live',
            muted: false
          } as MediaStreamTrack)
        }) as never,
      themHeard: () => heard,
      themWindowSeen: () => windowSeen,
      themDeviceChangeAction: themDeviceChangeAction
    })
    const { createListenAudioRecovery } = await import('./listen-audio-recovery')
    const recovery = createListenAudioRecovery(() => host)
    const scheduled: Array<() => void> = []
    host.scheduleThemProbation = (callback) => scheduled.push(callback)
    recovery.armThemProbation()
    const callback = scheduled[0]
    expect(callback).toBeTypeOf('function')
    callback?.()
    expect(host.onThemProbationRecycle).toHaveBeenCalledTimes(1)

    vi.mocked(host.onThemProbationRecycle).mockClear()
    heard = true
    dead = false
    windowSeen = false
    recovery.armThemProbation()
    scheduled[1]?.()
    expect(host.onThemProbationRecycle).not.toHaveBeenCalled()

    recovery.armThemProbation()
    epoch += 1
    scheduled[2]?.()
    expect(host.onThemProbationRecycle).not.toHaveBeenCalled()
  })

  it('paces Windows permission retries and resets the schedule after recovery succeeds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const recoveryTimes: number[] = []
    let channelOpen = false
    let openCalls = 0
    let recovery: ListenAudioRecovery | undefined
    const host = recoveryHost({
      isWindows: () => true,
      hasChannel: (speaker) => speaker === 'them' && channelOpen,
      recoverSystemNow: () => {
        recoveryTimes.push(Date.now())
        void recovery?.recoverSystemAudio()
      },
      openChannel: vi.fn(async () => {
        openCalls += 1
        channelOpen = openCalls > 1
        return channelOpen
      })
    })
    const { createListenAudioRecovery } = await import('./listen-audio-recovery')
    recovery = createListenAudioRecovery(() => host)
    const stopWatching = recovery.watchSystemPermission()

    await vi.advanceTimersByTimeAsync(7000)
    expect(recoveryTimes).toEqual([3000, 6000])
    channelOpen = false // the successfully recovered track later disappears
    await vi.advanceTimersByTimeAsync(2000)

    expect(recoveryTimes).toEqual([3000, 6000, 9000])
    expect(host.systemRecoverySucceeded).toHaveBeenCalledTimes(2)
    stopWatching()
  })

  it('resets retry backoff on a new session and immediately after a device change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const attempts: number[] = []
    let deviceChange: (() => void) | undefined
    const host = recoveryHost({
      isWindows: () => true,
      recoverSystemNow: () => attempts.push(Date.now()),
      deviceChangeTarget: () => ({
        addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
          deviceChange = listener as () => void
        },
        removeEventListener: vi.fn()
      })
    })
    const { createListenAudioRecovery } = await import('./listen-audio-recovery')
    const recovery = createListenAudioRecovery(() => host)
    const stopPolling = recovery.watchSystemPermission()
    const stopWatching = recovery.watchDeviceChanges()

    await vi.advanceTimersByTimeAsync(7000)
    expect(attempts).toEqual([3000, 6000])
    recovery.resetSystemRetry() // new session clears the previous session's capped delay
    await vi.advanceTimersByTimeAsync(2000)
    expect(attempts).toEqual([3000, 6000, 9000])

    await vi.advanceTimersByTimeAsync(3000)
    expect(attempts).toEqual([3000, 6000, 9000, 12000])
    deviceChange?.()
    await vi.advanceTimersByTimeAsync(800)
    expect(attempts.at(-1)).toBe(12800) // the real device change resets pacing for an immediate attempt
    await vi.advanceTimersByTimeAsync(2200)
    expect(attempts.at(-1)).toBe(15000) // reset also makes the next watcher tick immediately eligible

    stopWatching()
    stopPolling()
  })

  it('fails a broker recovery closed without replacing its capture and exposes the fixed failure source', () => {
    const failCapture = vi.fn()
    expect(failBrokerCaptureRecovery('broker-v1', 'capture-1', 'microphone', failCapture)).toBe(true)
    expect(failCapture).toHaveBeenCalledWith(expect.stringContaining('microphone'), {
      cloudCaptureId: 'capture-1'
    })
    expect(failBrokerCaptureRecovery('legacy', null, 'system', failCapture)).toBe(false)
    expect(themDeviceChangeAction(false, true, false, true)).toBe('ignore')
    expect(themDeviceChangeAction(true, true, false, false)).toBe('ignore')
    expect(themDeviceChangeAction(true, true, false, true)).toBe('recycle')
    expect(themTracksLookDead([{ readyState: 'live', muted: false }])).toBe(false)
    expect(themTracksLookDead([{ readyState: 'ended', muted: false }])).toBe(true)
  })
})
