import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputSessionContext, InputSessionLease, InputSessionRevoked } from '@shared/ipc'

type SpeechResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'policy_blocked'
        | 'unsupported_engine'
        | 'busy'
        | 'stale'
        | 'invalid'
        | 'no_speech'
        | 'recognition_unavailable'
    }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void }
type TrackFixture = MediaStreamTrack & {
  emitEnded(): void
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>
  setReadyState(value: MediaStreamTrackState): void
  stop: ReturnType<typeof vi.fn>
}
type TestController = {
  start(options?: { source?: 'push-to-talk' | 'deliberate-talk' }): Promise<void>
  finish(expectedGeneration?: number): Promise<void>
  cancel(): Promise<void>
  dispose(): void
  getSnapshot(): { status: string; reason?: string }
}

const controllers: TestController[] = []
const ownedTasks = new Set<Promise<unknown>>()
const unexpectedTaskFailures: unknown[] = []
const settleDeferreds: Array<() => void> = []
const context: InputSessionContext = { authSessionGeneration: 7, contextRevision: 3 }

function trackTask<T>(promise: Promise<T>, reportFailure = true): Promise<T> {
  ownedTasks.add(promise)
  void promise.then(
    () => ownedTasks.delete(promise),
    (error) => {
      ownedTasks.delete(promise)
      if (reportFailure) unexpectedTaskFailures.push(error)
    }
  )
  return promise
}

function trackBoundaryTask<T>(promise: Promise<T>): Promise<T> {
  return trackTask(promise, false)
}

function deferred<T>(fallback: T): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  let settled = false
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      settled = true
      resolve(value)
    }
    rejectPromise = (reason) => {
      settled = true
      reject(reason)
    }
  })
  settleDeferreds.push(() => resolvePromise(fallback))
  return {
    promise,
    resolve(value) {
      if (!settled) resolvePromise(value)
    },
    reject(reason) {
      if (!settled) rejectPromise(reason)
    }
  }
}

function start(controller: TestController, options?: { source?: 'push-to-talk' | 'deliberate-talk' }): Promise<void> {
  return controller.start(options)
}

type HarnessOptions = {
  noAudioTrack?: boolean
  throwAudioTrackDiscovery?: boolean
  throwEndedListener?: boolean
  endDuringEndedListener?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const order: string[] = []
  const tracks = new Set<TrackFixture>()
  const sources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  const gains: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  const contexts: Array<{ close: ReturnType<typeof vi.fn>; state: string }> = []
  const nodes: Array<{
    port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> }
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    emit(data: unknown): void
  }> = []
  const revocationListeners = new Set<(event: InputSessionRevoked) => void>()
  const deviceListeners = new Set<EventListenerOrEventListenerObject>()
  const ids: string[] = []
  let availability: { ok: true } | { ok: false; reason: 'policy_blocked' | 'unsupported_engine' | 'unauthorized' } = {
    ok: true
  }
  let activationReady = true
  let finishResult: SpeechResult = { ok: true }
  let nextInputSession = 0
  let audioContextNumber = 0
  let sealFrames: Float32Array[] = []
  let mediaStream: MediaStream
  let moduleGate: Deferred<void> | null = null
  let availabilityRefreshGate: Deferred<typeof availability> | null = null
  let availabilityCallCount = 0

  const makeTrack = (): TrackFixture => {
    const fixture = {
      readyState: 'live' as MediaStreamTrackState,
      listeners: new Map<string, Set<EventListenerOrEventListenerObject>>(),
      stop: vi.fn(() => {
        order.push('track.stop')
      }),
      setReadyState(value: MediaStreamTrackState) {
        fixture.readyState = value
      },
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (options.throwEndedListener && type === 'ended') throw new Error('track listener setup failed')
        const listeners = fixture.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
        listeners.add(listener)
        fixture.listeners.set(type, listeners)
        if (options.endDuringEndedListener && type === 'ended') fixture.emitEnded()
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        fixture.listeners.get(type)?.delete(listener)
        order.push('track.listener.remove')
      }),
      emitEnded() {
        fixture.readyState = 'ended'
        for (const listener of [...(fixture.listeners.get('ended') ?? [])]) {
          if (typeof listener === 'function') listener(new Event('ended'))
          else listener.handleEvent(new Event('ended'))
        }
      }
    } as unknown as TrackFixture
    tracks.add(fixture)
    return fixture
  }
  const makeStream = (streamTrack: TrackFixture): MediaStream =>
    ({
      getTracks: () => [streamTrack],
      getAudioTracks: () => {
        if (options.throwAudioTrackDiscovery) throw new Error('audio track discovery failed')
        return options.noAudioTrack ? [] : [streamTrack]
      }
    }) as unknown as MediaStream
  const track = makeTrack()
  mediaStream = makeStream(track)
  let mediaRequestCount = 0
  const getUserMedia = vi.fn((_constraints?: MediaStreamConstraints) =>
    trackBoundaryTask(
      (async () => {
        if (mediaRequestCount++ === 0) return mediaStream
        mediaStream = makeStream(makeTrack())
        return mediaStream
      })()
    )
  )
  const commandSpeechStart = vi.fn(
    (sessionId: string): Promise<SpeechResult> =>
      trackBoundaryTask(
        (async () => {
          order.push(`speech.start:${sessionId}`)
          return { ok: true }
        })()
      )
  )
  const commandSpeechFrame = vi.fn(
    (sessionId: string, sequence: number, _samples: Float32Array): Promise<SpeechResult> =>
      trackBoundaryTask(
        (async () => {
          order.push(`speech.frame:${sessionId}:${sequence}`)
          return { ok: true }
        })()
      )
  )
  const commandSpeechFinish = vi.fn(
    (sessionId: string, frameCount: number): Promise<SpeechResult> =>
      trackBoundaryTask(
        (async () => {
          order.push(`speech.finish:${sessionId}:${frameCount}`)
          return finishResult
        })()
      )
  )
  const commandSpeechCancel = vi.fn(
    (sessionId: string): Promise<SpeechResult> =>
      trackBoundaryTask(
        (async () => {
          order.push(`speech.cancel:${sessionId}`)
          return { ok: true }
        })()
      )
  )
  const stopInputSession = vi.fn(({ sessionId }: { sessionId: string }, _owner: InputSessionContext) =>
    trackBoundaryTask(
      (async () => {
        order.push(`session.stop:${sessionId}`)
        return { ok: true as const }
      })()
    )
  )
  const startInputSession = vi.fn(
    (input: { source: string; purpose: string; activation: string }, owner: InputSessionContext) =>
      trackBoundaryTask(
        (async () => {
          const sessionId = (++nextInputSession).toString(16).padStart(48, '0')
          ids.push(sessionId)
          const lease: InputSessionLease = {
            sessionId,
            source: input.source as InputSessionLease['source'],
            purpose: input.purpose as InputSessionLease['purpose'],
            activation: input.activation as InputSessionLease['activation'],
            authSessionGeneration: owner.authSessionGeneration,
            contextRevision: owner.contextRevision,
            revision: 1,
            startedAt: 1234,
            actionAuthority: false
          }
          return { ok: true as const, lease }
        })()
      )
  )
  const confirmInputSession = vi.fn((_sessionId: string, _owner: InputSessionContext) =>
    trackBoundaryTask((async () => true)())
  )
  const commandMicAvailability = vi.fn(() =>
    trackBoundaryTask(
      (async () => {
        const call = availabilityCallCount++
        if (call === 1 && availabilityRefreshGate) return availabilityRefreshGate.promise
        return availability
      })()
    )
  )
  const onInputSessionRevoked = vi.fn((listener: (event: InputSessionRevoked) => void) => {
    revocationListeners.add(listener)
    return () => revocationListeners.delete(listener)
  })
  const mediaDevices = {
    getUserMedia,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'devicechange') deviceListeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'devicechange') deviceListeners.delete(listener)
    })
  }

  class FakeAudioContext {
    constructor() {
      contexts.push(this)
    }
    state = 'suspended'
    destination = { kind: 'destination' }
    audioWorklet = {
      addModule: vi.fn((_url: string) =>
        trackBoundaryTask(
          (async () => {
            order.push(`worklet.module:${++audioContextNumber}`)
            if (moduleGate) await moduleGate.promise
          })()
        )
      )
    }
    close = vi.fn(() =>
      trackBoundaryTask(
        (async () => {
          order.push('context.close')
          this.state = 'closed'
        })()
      )
    )
    resume = vi.fn(() =>
      trackBoundaryTask(
        (async () => {
          this.state = 'running'
        })()
      )
    )
    createMediaStreamSource = vi.fn((_stream: MediaStream) => {
      const source = {
        connect: vi.fn(() => {
          order.push('source.connect')
        }),
        disconnect: vi.fn(() => {
          order.push('source.disconnect')
        })
      }
      sources.push(source)
      return source as unknown as MediaStreamAudioSourceNode
    })
    createGain = vi.fn(() => {
      const gain = {
        gain: { value: 1 },
        connect: vi.fn(() => {
          order.push('gain.connect')
        }),
        disconnect: vi.fn(() => {
          order.push('gain.disconnect')
        })
      }
      gains.push(gain)
      return gain as unknown as GainNode
    })
  }

  class FakeAudioWorkletNode {
    readonly port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> }
    readonly connect = vi.fn(() => {
      order.push('node.connect')
    })
    readonly disconnect = vi.fn(() => {
      order.push('node.disconnect')
    })
    constructor(_context: AudioContext, _name: string, _options: AudioWorkletNodeOptions) {
      this.port = {
        onmessage: null,
        postMessage: vi.fn((message: unknown) => {
          if (message !== 'seal') return
          order.push('worklet.seal')
          for (const [sequence, samples] of sealFrames.entries()) this.emit({ type: 'frame', sequence, samples })
          this.emit({ type: 'sealed' })
        })
      }
      nodes.push(this)
    }
    emit(data: unknown): void {
      this.port.onmessage?.({ data } as MessageEvent)
    }
  }

  vi.stubGlobal('navigator', { mediaDevices })
  vi.stubGlobal('window', {
    toto: {
      getInputSessionContext: vi.fn(() => trackBoundaryTask((async () => context)())),
      startInputSession,
      confirmInputSession,
      stopInputSession,
      onInputSessionRevoked,
      commandMicAvailability,
      commandMicActivationReady: vi.fn(() => trackBoundaryTask((async () => activationReady)())),
      commandSpeechStart,
      commandSpeechFrame,
      commandSpeechFinish,
      commandSpeechCancel
    }
  })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)

  const env = {
    order,
    tracks,
    track,
    sources,
    gains,
    contexts,
    nodes,
    ids,
    mediaDevices,
    getUserMedia,
    startInputSession,
    confirmInputSession,
    stopInputSession,
    onInputSessionRevoked,
    commandSpeechStart,
    commandSpeechFrame,
    commandSpeechFinish,
    commandSpeechCancel,
    commandMicAvailability,
    get availability() {
      return availability
    },
    set availability(value: typeof availability) {
      availability = value
    },
    get activationReady() {
      return activationReady
    },
    set activationReady(value: boolean) {
      activationReady = value
    },
    get stoppedTrackCount() {
      return [...tracks].reduce((count, item) => count + item.stop.mock.calls.length, 0)
    },
    set finishResult(value: SpeechResult) {
      finishResult = value
    },
    set sealFrames(value: Float32Array[]) {
      sealFrames = value
    },
    deferFinish() {
      const gate = deferred<SpeechResult>({ ok: true })
      commandSpeechFinish.mockImplementation((sessionId, frameCount) =>
        trackBoundaryTask(
          (async () => {
            order.push(`speech.finish:${sessionId}:${frameCount}`)
            return gate.promise
          })()
        )
      )
      return gate
    },
    deferFrames() {
      const gate = deferred<SpeechResult>({ ok: true })
      commandSpeechFrame.mockImplementation((sessionId, sequence, _samples) =>
        trackBoundaryTask(
          (async () => {
            order.push(`speech.frame:${sessionId}:${sequence}`)
            return gate.promise
          })()
        )
      )
      return gate
    },
    deferModule() {
      moduleGate = deferred<void>(undefined)
      return moduleGate
    },
    deferMedia() {
      const gate = deferred<MediaStream>(mediaStream)
      getUserMedia.mockImplementation(() => trackBoundaryTask(gate.promise))
      return gate
    },
    deferConfirmation() {
      const gate = deferred<boolean>(true)
      confirmInputSession.mockImplementation(() => trackBoundaryTask(gate.promise))
      return gate
    },
    deferAvailabilityRefresh() {
      availabilityRefreshGate = deferred<typeof availability>({ ok: true })
      return availabilityRefreshGate
    },
    revokeInput(sessionId = ids.at(-1) ?? '') {
      for (const listener of [...revocationListeners]) listener({ sessionId, revision: 1, reason: 'auth-revoked' })
    },
    changeDevice() {
      for (const listener of [...deviceListeners]) {
        if (typeof listener === 'function') listener(new Event('devicechange'))
        else listener.handleEvent(new Event('devicechange'))
      }
    },
    async createController(maxDurationMs = 8_000) {
      vi.resetModules()
      const { CommandMicController } = await import('./use-command-mic')
      const controller = new CommandMicController({ maxDurationMs }) as TestController
      const originalStart = controller.start.bind(controller)
      const originalFinish = controller.finish.bind(controller)
      const originalCancel = controller.cancel.bind(controller)
      controller.start = (options) => trackTask(originalStart(options))
      controller.finish = (expectedGeneration) => trackTask(originalFinish(expectedGeneration))
      controller.cancel = () => trackTask(originalCancel())
      controllers.push(controller)
      return controller
    },
    async makeContext() {
      return this.createController()
    },
    getMediaStream() {
      return mediaStream
    }
  }
  return env
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  controllers.length = 0
  ownedTasks.clear()
  unexpectedTaskFailures.length = 0
  settleDeferreds.length = 0
})

afterEach(async () => {
  for (const controller of controllers) controller.dispose()
  for (const settle of settleDeferreds) settle()
  for (let pass = 0; pass < 12; pass++) {
    await vi.runAllTimersAsync()
    await Promise.allSettled([...ownedTasks])
    await Promise.resolve()
    if (ownedTasks.size === 0 && vi.getTimerCount() === 0) break
  }
  expect(ownedTasks.size).toBe(0)
  expect(unexpectedTaskFailures).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bounded command microphone capture', () => {
  it('stops the microphone at the eight-second timeout and retains the exact lease through finish', async () => {
    const env = createHarness()
    const controller = await env.createController()
    const finish = env.deferFinish()
    await start(controller)

    expect(env.getUserMedia).toHaveBeenCalledWith({
      audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    expect(controller.getSnapshot()).toEqual({ status: 'listening' })
    expect(env.commandSpeechStart).toHaveBeenCalledExactlyOnceWith(env.ids[0])

    await vi.advanceTimersByTimeAsync(8_000)
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())

    expect(controller.getSnapshot()).toEqual({ status: 'finalizing' })
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()
    expect(env.order.indexOf('track.stop')).toBeLessThan(
      env.order.findIndex((entry) => entry.startsWith(`speech.finish:${env.ids[0]}:`))
    )

    finish.resolve({ ok: true })
    await vi.waitFor(() => expect(controller.getSnapshot()).toEqual({ status: 'done' }))
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
  })

  it('stops a late microphone stream after cancellation during permission acquisition', async () => {
    const env = createHarness()
    const lateMedia = env.deferMedia()
    const controller = await env.createController()
    const starting = start(controller)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())

    await controller.cancel()
    lateMedia.resolve(env.getMediaStream())
    await starting

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'idle', reason: 'cancelled' })
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(env.commandSpeechStart).not.toHaveBeenCalled()
    expect(env.nodes).toHaveLength(0)
  })

  it('releases an active microphone and graph when the owner is disposed', async () => {
    const env = createHarness()
    const controller = await env.createController()
    await start(controller)

    controller.dispose()
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledOnce())

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.commandSpeechCancel).toHaveBeenCalledExactlyOnceWith(env.ids[0])
    expect(env.nodes[0].disconnect).toHaveBeenCalledOnce()
    expect(env.sources[0].disconnect).toHaveBeenCalledOnce()
    expect(env.gains[0].disconnect).toHaveBeenCalledOnce()
    expect(env.contexts).toHaveLength(1)
    expect(env.contexts[0].close).toHaveBeenCalledOnce()
    expect(env.contexts[0].state).toBe('closed')
  })

  it('keeps disposal authoritative while an exact command finish is pending', async () => {
    const env = createHarness()
    const controller = await env.createController()
    const finish = env.deferFinish()
    await start(controller)

    const finishing = controller.finish()
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())
    controller.dispose()
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledOnce())

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.commandSpeechCancel).toHaveBeenCalledExactlyOnceWith(env.ids[0])
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    finish.resolve({ ok: true })
    await finishing
    expect(controller.getSnapshot()).toEqual({ status: 'finalizing' })
    expect(env.track.stop).toHaveBeenCalledOnce()
  })

  it('keeps a microphone permission failure visible until the user retries or cancels', async () => {
    const env = createHarness()
    env.getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
    const controller = await env.createController()

    await start(controller)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(env.track.stop).not.toHaveBeenCalled()
  })

  it('releases an active command microphone immediately when its track ends', async () => {
    const env = createHarness()
    const controller = await env.createController()
    await start(controller)

    env.track.emitEnded()
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledOnce())

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    expect(env.commandSpeechCancel).toHaveBeenCalledExactlyOnceWith(env.ids[0])
  })

  it('releases a microphone stream exactly once if setup fails after permission is granted', async () => {
    const env = createHarness({ throwEndedListener: true })
    const controller = await env.createController()

    await start(controller)

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    expect(env.nodes[0].disconnect).toHaveBeenCalledOnce()
    expect(env.contexts[0].close).toHaveBeenCalledOnce()
  })

  it('rejects a resolved stream with no active audio track and still cleans up its media', async () => {
    const env = createHarness({ noAudioTrack: true })
    const controller = await env.createController()

    await start(controller)

    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(env.commandSpeechStart).not.toHaveBeenCalled()
  })

  it('does not overwrite a synchronous track-ended error with listening or connect a retired graph', async () => {
    const env = createHarness({ endDuringEndedListener: true })
    const controller = await env.createController()

    await start(controller)
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledOnce())

    expect(env.sources[0].connect).not.toHaveBeenCalled()
    expect(env.nodes[0].connect).not.toHaveBeenCalled()
    expect(env.gains[0].connect).not.toHaveBeenCalled()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
  })

  it('does not retain a timeout when audio-track discovery throws after permission is granted', async () => {
    const env = createHarness({ throwAudioTrackDiscovery: true })
    const controller = await env.createController()

    await start(controller)

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('denies unavailable or unactivated command capture before requesting browser media', async () => {
    const env = createHarness()
    const controller = await env.createController()
    env.availability = { ok: false, reason: 'unsupported_engine' }
    await start(controller)
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'unsupported_engine' })
    expect(env.startInputSession).not.toHaveBeenCalled()
    expect(env.getUserMedia).not.toHaveBeenCalled()

    env.availability = { ok: true }
    env.activationReady = false
    await start(controller)
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'activation_required' })
    expect(env.startInputSession).not.toHaveBeenCalled()
    expect(env.getUserMedia).not.toHaveBeenCalled()
  })

  it('does not let a stale unauthorized availability refresh overwrite a successor', async () => {
    const env = createHarness()
    const refresh = env.deferAvailabilityRefresh()
    const controller = await env.createController()
    env.startInputSession.mockRejectedValueOnce(new Error('unauthorized'))

    const oldStart = start(controller)
    await vi.waitFor(() => expect(env.commandMicAvailability).toHaveBeenCalledTimes(2))
    await controller.cancel()
    env.availability = { ok: true }
    await start(controller)
    expect(controller.getSnapshot()).toEqual({ status: 'listening' })

    refresh.resolve({ ok: false, reason: 'unsupported_engine' })
    await oldStart
    expect(controller.getSnapshot()).toEqual({ status: 'listening' })
    expect(env.stopInputSession).not.toHaveBeenCalled()
    await controller.cancel()
  })

  it('seals and drains queued frames, retires physical media, then finishes before releasing the lease', async () => {
    const env = createHarness()
    const controller = await env.createController()
    const frame = env.deferFrames()
    const finish = env.deferFinish()
    env.sealFrames = [new Float32Array([0.25, -0.25])]
    await start(controller)

    const finishing = controller.finish()
    await vi.waitFor(() => expect(env.commandSpeechFrame).toHaveBeenCalledOnce())
    expect(env.commandSpeechFinish).not.toHaveBeenCalled()
    expect(env.track.stop).not.toHaveBeenCalled()

    frame.resolve({ ok: true })
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())
    expect(env.commandSpeechFinish).toHaveBeenCalledExactlyOnceWith(env.ids[0], 1)
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.nodes[0].disconnect).toHaveBeenCalledOnce()
    expect(env.sources[0].disconnect).toHaveBeenCalledOnce()
    expect(env.gains[0].disconnect).toHaveBeenCalledOnce()
    expect(env.track.listeners.get('ended')?.size).toBe(0)
    expect(env.stopInputSession).not.toHaveBeenCalled()
    expect(env.order.indexOf('track.stop')).toBeLessThan(env.order.indexOf(`speech.finish:${env.ids[0]}:1`))
    expect(env.order.indexOf('context.close')).toBeLessThan(env.order.indexOf(`speech.finish:${env.ids[0]}:1`))
    expect(env.nodes[0].port.onmessage).toBeNull()
    const sentFrames = env.commandSpeechFrame.mock.calls.length
    const priorTasks = new Set(ownedTasks)
    env.nodes[0].emit({ type: 'frame', sequence: 2, samples: new Float32Array([0.5]) })
    await Promise.resolve()
    await Promise.allSettled([...ownedTasks].filter((task) => !priorTasks.has(task)))
    await Promise.resolve()
    expect(env.commandSpeechFrame).toHaveBeenCalledTimes(sentFrames)

    finish.resolve({ ok: true })
    await finishing
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledOnce())
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(env.mediaDevices.removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function))
  })

  it('cancels only the current capture while command finish is pending', async () => {
    const env = createHarness()
    const controller = await env.createController()
    const finish = env.deferFinish()
    await start(controller)

    const finishing = controller.finish()
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())
    expect(env.stopInputSession).not.toHaveBeenCalled()
    await controller.cancel()
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledOnce())

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    finish.resolve({ ok: true })
    await finishing
    expect(controller.getSnapshot()).toEqual({ status: 'idle', reason: 'cancelled' })
    expect(env.track.stop).toHaveBeenCalledOnce()
  })

  it('does not let a late old finish publish over or release a successor capture', async () => {
    const env = createHarness()
    const controller = await env.createController()
    const oldFinish = env.deferFinish()
    await start(controller)

    const finishing = controller.finish()
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())
    await controller.cancel()
    await start(controller)
    expect(controller.getSnapshot()).toEqual({ status: 'listening' })
    expect(env.ids).toHaveLength(2)

    oldFinish.reject(new Error('late transport failure'))
    await finishing
    expect(controller.getSnapshot()).toEqual({ status: 'listening' })
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(env.stoppedTrackCount).toBe(1)
    expect([...env.tracks][1].stop).not.toHaveBeenCalled()

    await controller.cancel()
    await vi.waitFor(() => expect(env.stopInputSession).toHaveBeenCalledTimes(2))
    expect(env.stopInputSession).toHaveBeenLastCalledWith({ sessionId: env.ids[1] }, context)
    expect(env.stoppedTrackCount).toBe(2)
  })

  it('stops physical media on revocation while finish is pending without a duplicate stop', async () => {
    const env = createHarness()
    const controller = await env.createController()
    const finish = env.deferFinish()
    await start(controller)

    const finishing = controller.finish()
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())
    env.revokeInput(env.ids[0])
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'microphone_unavailable' })
    )

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()
    finish.resolve({ ok: true })
    await finishing
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()
  })

  it('does not reopen capture when delayed module loading completes after cancellation', async () => {
    const env = createHarness()
    const module = env.deferModule()
    const controller = await env.createController()
    const starting = start(controller)
    await vi.waitFor(() => expect(env.nodes).toHaveLength(0))
    await vi.waitFor(() => expect(env.confirmInputSession).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(env.order.some((entry) => entry.startsWith('worklet.module:'))).toBe(true))

    await controller.cancel()
    module.resolve(undefined)
    await starting

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toEqual({ status: 'idle', reason: 'cancelled' })
    expect(env.commandSpeechStart).not.toHaveBeenCalled()
    expect(env.nodes).toHaveLength(0)
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
  })

  it('does not reopen capture when delayed lease confirmation completes after cancellation', async () => {
    const env = createHarness()
    const confirmation = env.deferConfirmation()
    const controller = await env.createController()
    const starting = start(controller)
    await vi.waitFor(() => expect(env.confirmInputSession).toHaveBeenCalledOnce())

    await controller.cancel()
    confirmation.resolve(true)
    await starting

    expect(controller.getSnapshot()).toEqual({ status: 'idle', reason: 'cancelled' })
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)
    expect(env.contexts).toHaveLength(0)
    expect(env.nodes).toHaveLength(0)
    expect(env.commandSpeechStart).not.toHaveBeenCalled()
  })

  it('keeps typed no_speech and recognition failures visible after exact cleanup', async () => {
    const env = createHarness()
    const controller = await env.createController()
    env.finishResult = { ok: false, reason: 'no_speech' }
    await start(controller)
    await controller.finish()

    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'no_speech' })
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: env.ids[0] }, context)

    env.finishResult = { ok: false, reason: 'recognition_unavailable' }
    await start(controller)
    await controller.finish()
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'recognition_unavailable' })
    expect(env.stoppedTrackCount).toBe(2)
    expect(env.stopInputSession).toHaveBeenCalledTimes(2)
  })
})

describe('voice turn capture started from a main-pushed begin', () => {
  it('a push-to-talk start skips the click-activation pre-check and asks main for a push-to-talk command lease', async () => {
    const env = createHarness()
    env.activationReady = false
    const controller = await env.createController(15_000)
    await start(controller, { source: 'push-to-talk' })

    expect(controller.getSnapshot()).toEqual({ status: 'listening' })
    expect(env.startInputSession).toHaveBeenCalledExactlyOnceWith(
      { source: 'push-to-talk', purpose: 'command', activation: 'explicit' },
      context
    )
    await controller.cancel()
  })

  it('the default start is unchanged: a deliberate-talk lease that needs the Start click', async () => {
    const env = createHarness()
    env.activationReady = false
    const controller = await env.createController()
    await start(controller)
    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'activation_required' })
    expect(env.startInputSession).not.toHaveBeenCalled()

    env.activationReady = true
    await start(controller)
    expect(env.startInputSession).toHaveBeenCalledExactlyOnceWith(
      { source: 'deliberate-talk', purpose: 'command', activation: 'explicit' },
      context
    )
    await controller.cancel()
  })

  it('a main refusal of the hardware activation reads as activation_required and opens no microphone', async () => {
    const env = createHarness()
    const controller = await env.createController(15_000)
    env.startInputSession.mockRejectedValueOnce(new Error('unauthorized'))
    await start(controller, { source: 'push-to-talk' })

    expect(controller.getSnapshot()).toEqual({ status: 'error', reason: 'activation_required' })
    expect(env.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops at fifteen seconds when given the voice cap, and clamps anything longer', async () => {
    const env = createHarness()
    const finish = env.deferFinish()
    const controller = await env.createController(60_000)
    await start(controller, { source: 'push-to-talk' })

    await vi.advanceTimersByTimeAsync(14_999)
    expect(env.commandSpeechFinish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(env.commandSpeechFinish).toHaveBeenCalledOnce())
    finish.resolve({ ok: true })
    await vi.waitFor(() => expect(controller.getSnapshot()).toEqual({ status: 'done' }))
  })
})
