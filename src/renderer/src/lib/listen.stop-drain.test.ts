/**
 * Task 2b1 — Stop owns the final worklet flush before it reports drained.
 *
 * The hook runs against the same small React/Web Audio boundary used by the
 * live-caption tests. External capture and native ASR are mocked; stop/queue,
 * transcript, error, and subscriber behavior are the real useListen code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHISPER_WORKLET_SRC } from './whisper-worklet-src'

type Slot = { current: unknown }
const host = vi.hoisted(() => {
  let slots: Slot[] = []
  let cursor = 0
  let effectCursor = 0
  let effects: Array<{ run: () => void | (() => void); cleanup: void | (() => void) }> = []
  const slot = <T,>(initial: T): { current: T } => {
    const i = cursor++
    if (!slots[i]) slots[i] = { current: initial }
    return slots[i] as { current: T }
  }
  return {
    useRef: slot,
    useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
      const state = slot(initial)
      return [
        state.current,
        (value) => {
          state.current = typeof value === 'function' ? (value as (previous: T) => T)(state.current) : value
        }
      ]
    },
    beginRender(): void {
      cursor = 0
      effectCursor = 0
    },
    useEffect(effect: () => void | (() => void)): void {
      const i = effectCursor++
      if (effects[i]) {
        effects[i].run = effect
        return
      }
      effects[i] = { run: effect, cleanup: effect() }
    },
    rerunEffect(index: number): void {
      const registered = effects[index]
      if (!registered) throw new Error(`effect ${index} was not registered`)
      registered.cleanup?.()
      registered.cleanup = registered.run()
    },
    unmount(): void {
      for (const effect of effects) effect.cleanup?.()
      effects = []
      effectCursor = 0
    },
    reset(): void {
      slots = []
      cursor = 0
      effects = []
      effectCursor = 0
    }
  }
})

vi.mock('react', () => ({
  useRef: <T,>(initial: T) => host.useRef(initial),
  useState: <T,>(initial: T) => host.useState(initial),
  useEffect: (effect: () => void | (() => void)) => host.useEffect(effect),
  useCallback: <T,>(fn: T) => fn,
  useMemo: <T,>(fn: () => T) => fn()
}))

type WorkletMessage = {
  type?: string
  requestId?: string
  audio?: Float32Array
  partial?: boolean
}
type SealMode = {
  delayMs: number
  audio?: Float32Array
  acknowledge: boolean
  throwOnPost: boolean
}

let worklets: FakeAudioWorkletNode[] = []
let sealMode: SealMode
let workers: FakeWorker[] = []
let contexts: FakeAudioContext[] = []
let streams: Array<{ kind: 'mic' | 'system'; stream: MediaStream; track: FakeTrack }> = []
let addModuleImpl: () => Promise<void>
let getUserMediaImpl: () => Promise<MediaStream>
let getDisplayMediaImpl: () => Promise<MediaStream>
let getPermissionsImpl: () => Promise<{ screenRecording?: string }>
let mediaDeviceListeners: Partial<Record<string, () => void>> = {}

type FakeTrack = {
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
  readyState: string
  applyConstraints: () => Promise<void>
}

function makeStream(kind: 'mic' | 'system'): MediaStream {
  const track: FakeTrack = {
    stop: vi.fn(),
    onended: null,
    readyState: 'live',
    applyConstraints: async () => {}
  }
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  } as unknown as MediaStream
  streams.push({ kind, stream, track })
  return stream
}

class FakeAudioWorkletNode {
  readonly posted: unknown[] = []
  port = {
    onmessage: null as ((event: MessageEvent<WorkletMessage>) => void) | null,
    postMessage: (message: unknown): void => {
      this.posted.push(message)
      if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'seal-and-flush') return
      if (sealMode.throwOnPost) throw new Error('worklet port closed')
      if (!sealMode.acknowledge) return
      const requestId = String((message as { requestId?: unknown }).requestId ?? '')
      setTimeout(() => {
        if (sealMode.audio) this.emit({ audio: sealMode.audio, partial: false })
        this.emit({ type: 'flush-ack', requestId })
      }, sealMode.delayMs)
    }
  }

  constructor() {
    worklets.push(this)
  }

  emit(message: WorkletMessage): void {
    this.port.onmessage?.({ data: message } as MessageEvent<WorkletMessage>)
  }

  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  state = 'running'
  destination = {}
  onstatechange: (() => void) | null = null
  audioWorklet = { addModule: vi.fn(() => addModuleImpl()) }

  constructor() {
    contexts.push(this)
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => {}, disconnect: () => {} }
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }
  }

  createDynamicsCompressor(): {
    threshold: { value: number }
    knee: { value: number }
    ratio: { value: number }
    attack: { value: number }
    release: { value: number }
    connect: () => void
    disconnect: () => void
  } {
    return {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: () => {},
      disconnect: () => {}
    }
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }
  async suspend(): Promise<void> {
    this.state = 'suspended'
  }
  async resume(): Promise<void> {
    this.state = 'running'
  }
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    workers.push(this)
  }
  emit(message: {
    type: string
    qualityDegraded?: boolean
    text?: string
    speaker?: 'you' | 'them'
    message?: string
  }): void {
    this.onmessage?.({ data: message } as MessageEvent)
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }
}

const { useListen } = await import('./listen')
type ListenApi = ReturnType<typeof useListen>
type Engine = 'parakeet' | 'whisper' | 'apple'

function render(engine: Engine = 'parakeet'): ListenApi {
  host.beginRender()
  return useListen(undefined, undefined, undefined, '', undefined, engine, 'fast')
}

function renderBeforeSettingsResolve(): ListenApi {
  host.beginRender()
  return useListen(undefined, undefined, undefined, '', undefined, undefined, 'fast')
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

async function start(engine: Engine = 'parakeet', startedAt?: number): Promise<ListenApi> {
  const api = render(engine)
  await api.start('system', 'fast', engine, 'English', startedAt)
  await settle()
  if (engine === 'whisper') {
    workers.at(-1)?.emit({ type: 'ready', qualityDegraded: false })
    await settle()
  }
  return api
}

beforeEach(() => {
  host.reset()
  worklets = []
  workers = []
  contexts = []
  streams = []
  sealMode = { delayMs: 0, acknowledge: true, throwOnPost: false }
  addModuleImpl = async () => {}
  getUserMediaImpl = async () => makeStream('mic')
  getDisplayMediaImpl = async () => makeStream('system')
  getPermissionsImpl = async () => ({ screenRecording: 'denied' })
  mediaDeviceListeners = {}
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)

  vi.stubGlobal('window', {
    toto: {
      setListeningState: vi.fn(async () => {}),
      armAudio: async () => {},
      parakeetStatus: vi.fn(async () => ({ ready: true, addonError: null })),
      parakeetEnsure: vi.fn(async () => ({ ok: true })),
      onParakeetProgress: () => () => {},
      parakeetFeed: vi.fn(async () => ({ text: '', name: undefined })),
      appleSpeechFeed: vi.fn(async () => ({ text: '', name: undefined })),
      asrBundled: vi.fn(async () => true),
      speakerEmbed: vi.fn(async () => ({})),
      getPermissions: vi.fn(() => getPermissionsImpl())
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  })
  vi.stubGlobal('navigator', {
    platform: 'MacIntel',
    onLine: true,
    mediaDevices: {
      getUserMedia: () => getUserMediaImpl(),
      getDisplayMedia: () => getDisplayMediaImpl(),
      addEventListener: (type: string, listener: () => void) => void (mediaDeviceListeners[type] = listener),
      removeEventListener: (type: string) => void delete mediaDeviceListeners[type]
    }
  })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  host.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('live audio transport identity', () => {
  it('uses the supplied meeting start for start and sealed Stop despite later clock changes', async () => {
    const api = await start('parakeet', 123)
    vi.setSystemTime(1_800_000_000_000)
    api.stop()
    await vi.advanceTimersByTimeAsync(1)
    expect(window.toto.setListeningState).toHaveBeenNthCalledWith(1, true, 123)
    expect(window.toto.setListeningState).toHaveBeenNthCalledWith(2, false, 123)
    expect(window.toto.setListeningState).toHaveBeenCalledTimes(2)
  })

  it('uses the admitted identity for a failed capture start', async () => {
    getUserMediaImpl = async () => { throw new Error('Synthetic microphone refusal') }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await render().start('mic', 'fast', 'parakeet', 'English', 123)
      expect(window.toto.setListeningState).toHaveBeenNthCalledWith(1, true, 123)
      expect(window.toto.setListeningState).toHaveBeenNthCalledWith(2, false, 123)
      expect(render().listening).toBe(false)
    } finally { warning.mockRestore() }
  })

  it('notifies the exact current session once after a live Whisper worker crash', async () => {
    const api = await start('whisper', 123)
    workers.at(-1)!.crash('Synthetic live worker failure')
    api.stop()
    expect(window.toto.setListeningState).toHaveBeenNthCalledWith(1, true, 123)
    expect(window.toto.setListeningState).toHaveBeenNthCalledWith(2, false, 123)
    expect(window.toto.setListeningState).toHaveBeenCalledTimes(2)
  })

  it('a prewarm-only worker crash or unmount cannot send an unowned stop', async () => {
    render('whisper')
    await settle()
    workers.at(-1)!.crash('Synthetic idle worker failure')
    host.unmount()
    expect(window.toto.setListeningState).not.toHaveBeenCalled()
  })

  it.each([false, true])('unmount closes only its owned session (Stop pending=%s)', async stopping => {
    const api = await start('parakeet', 123)
    if (stopping) {
      sealMode.acknowledge = false
      api.stop()
    }
    host.unmount()
    await settle()
    expect(vi.mocked(window.toto.setListeningState).mock.calls).toEqual([
      [true, 123], [false, 123]
    ])
  })

  it('a superseded Stop cannot send A-off after B starts, but B Stop still carries B', async () => {
    const api = await start('parakeet', 123)
    sealMode.acknowledge = false
    api.stop()
    await start('parakeet', 456)
    await vi.advanceTimersByTimeAsync(4_001)
    expect(vi.mocked(window.toto.setListeningState).mock.calls).toEqual([[true, 123], [true, 456]])
    sealMode.acknowledge = true
    render().stop()
    await vi.advanceTimersByTimeAsync(1)
    expect(window.toto.setListeningState).toHaveBeenLastCalledWith(false, 456)
  })

  it.each(['parakeet', 'apple'] as const)('%s queues the window owner and keeps legacy ASR usable', async engine => {
    const feed = engine === 'parakeet' ? window.toto.parakeetFeed : window.toto.appleSpeechFeed
    vi.mocked(feed).mockResolvedValue({ text: 'Identity-bound speech.' })
    await start(engine, 123)
    worklets.at(-1)!.emit({ audio: Float32Array.from([0.2]), partial: false })
    await settle()
    expect(feed).toHaveBeenLastCalledWith(expect.any(Float32Array), 'them', 123)
    expect(render(engine).text()).toBe('THEM: Identity-bound speech.')
    await start(engine)
    worklets.at(-1)!.emit({ audio: Float32Array.from([0.3]), partial: false })
    await settle()
    expect(feed).toHaveBeenLastCalledWith(expect.any(Float32Array), 'them', undefined)
  })

  it('an old worklet callback cannot enqueue its audio under a newer owner', async () => {
    vi.mocked(window.toto.parakeetFeed).mockResolvedValue({ text: 'Only B speech.' })
    await start('parakeet', 123)
    const oldCallback = worklets.at(-1)!.port.onmessage!
    await start('parakeet', 456)
    oldCallback({ data: { audio: Float32Array.from([0.1]), partial: false } } as MessageEvent<WorkletMessage>)
    await settle()
    expect(window.toto.parakeetFeed).not.toHaveBeenCalled()
    worklets.at(-1)!.emit({ audio: Float32Array.from([0.2]), partial: false })
    await settle()
    expect(window.toto.parakeetFeed).toHaveBeenCalledExactlyOnceWith(expect.any(Float32Array), 'them', 456)
    expect(render().text()).toBe('THEM: Only B speech.')
  })

  it('Whisper carries the queued identity on its operator tap and Parakeet language probe', async () => {
    const api = render('whisper')
    await api.start('mic', 'fast', 'whisper', 'auto', 123)
    await settle()
    workers.at(-1)!.emit({ type: 'ready', qualityDegraded: false })
    worklets.at(-1)!.emit({ audio: Float32Array.from([0.2]), partial: false })
    await settle()
    expect(window.toto.parakeetFeed).toHaveBeenCalledExactlyOnceWith(expect.any(Float32Array), 'you', 123)
    expect(window.toto.speakerEmbed).toHaveBeenCalledExactlyOnceWith(expect.any(Float32Array), 'you', 123)
    workers.at(-1)!.emit({ type: 'text', text: 'Operator speech.', speaker: 'you' })
    await settle()
    expect(render('whisper').text()).toBe('YOU: Operator speech.')
  })

  it('Whisper retains the window identity across text delivery before requesting a THEM label', async () => {
    await start('whisper', 123)
    worklets.at(-1)!.emit({ audio: Float32Array.from([0.2]), partial: false })
    await settle()
    vi.setSystemTime(1_800_000_000_000)
    workers.at(-1)!.emit({ type: 'text', text: 'Other participant speech.', speaker: 'them' })
    await settle()
    expect(window.toto.speakerEmbed).toHaveBeenCalledExactlyOnceWith(expect.any(Float32Array), 'them', 123)
    expect(render('whisper').text()).toBe('THEM: Other participant speech.')
  })
})

describe('ASR idle prewarm ownership', () => {
  it('does not guess an ASR warm before settings resolve or prewarm concrete Parakeet', async () => {
    renderBeforeSettingsResolve()
    await settle()
    expect(workers).toHaveLength(0)
    expect(window.toto.parakeetEnsure).not.toHaveBeenCalled()

    render('parakeet')
    host.rerunEffect(3)
    await settle()
    expect(workers).toHaveLength(0)
    expect(window.toto.parakeetEnsure).not.toHaveBeenCalled()
  })

  it('prewarms only a concrete Whisper choice at its requested quality and leaves Apple cold', async () => {
    render('whisper')
    await settle()
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage).toHaveBeenCalledWith({
      type: 'init',
      quality: 'fast',
      bundled: true
    })
    expect(window.toto.parakeetEnsure).not.toHaveBeenCalled()

    host.unmount()
    host.reset()
    workers = []
    render('apple')
    await settle()
    expect(workers).toHaveLength(0)
    expect(window.toto.parakeetEnsure).not.toHaveBeenCalled()
  })

  it('cancels an unresolved Whisper prewarm when the resolved choice changes to Parakeet', async () => {
    let resolveBundled!: (bundled: boolean) => void
    vi.mocked(window.toto.asrBundled).mockImplementation(
      () => new Promise((resolve) => void (resolveBundled = resolve))
    )
    render('whisper')
    await settle()
    expect(workers).toHaveLength(0)

    render('parakeet')
    host.rerunEffect(3)
    resolveBundled(true)
    await settle()

    expect(workers).toHaveLength(0)
    expect(window.toto.parakeetEnsure).not.toHaveBeenCalled()
  })

  it('cancels an unresolved Whisper prewarm when the hook unmounts', async () => {
    let resolveBundled!: (bundled: boolean) => void
    vi.mocked(window.toto.asrBundled).mockImplementation(
      () => new Promise((resolve) => void (resolveBundled = resolve))
    )
    render('whisper')
    await settle()
    host.unmount()
    resolveBundled(true)
    await settle()

    expect(workers).toHaveLength(0)
  })

  it('does not let a late prewarm re-init the worker already owned by live startup', async () => {
    const bundledResolvers: Array<(bundled: boolean) => void> = []
    vi.mocked(window.toto.asrBundled).mockImplementation(
      () => new Promise((resolve) => void bundledResolvers.push(resolve))
    )
    const api = render('whisper')
    await settle()
    expect(bundledResolvers).toHaveLength(1)

    await api.start('system', 'fast', 'whisper', 'English')
    await settle()
    expect(bundledResolvers).toHaveLength(2)
    bundledResolvers[1](true)
    await settle()
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    expect(workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      resetFollow: true,
      language: 'English'
    }))

    bundledResolvers[0](true)
    await settle()
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
  })

  it('captures and queues a cold Parakeet window while readiness is pending', async () => {
    let resolveStatus!: (status: { ready: boolean; addonError: null }) => void
    vi.mocked(window.toto.parakeetStatus).mockImplementation(
      () => new Promise((resolve) => void (resolveStatus = resolve))
    )
    vi.mocked(window.toto.parakeetFeed).mockResolvedValue({ text: 'Queued sentence.' })
    const api = render('parakeet')
    await settle()

    const started = api.start('system', 'fast', 'parakeet', 'English')
    await settle()
    const worklet = worklets.at(-1)
    expect(worklet).toBeDefined()
    worklet?.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()
    expect(window.toto.parakeetFeed).not.toHaveBeenCalled()

    resolveStatus({ ready: true, addonError: null })
    await started
    await settle()
    expect(window.toto.parakeetFeed).toHaveBeenCalledTimes(1)
    expect(window.toto.parakeetFeed).toHaveBeenCalledWith(expect.any(Float32Array), 'them', undefined)
  })
})

describe('worklet seal-and-flush protocol', () => {
  type RuntimeWorklet = {
    port: {
      onmessage: ((event: MessageEvent<unknown>) => void) | null
    }
    process(inputs: Float32Array[][]): boolean
  }

  function instantiate(messages: WorkletMessage[]): RuntimeWorklet {
    const registration: { ctor?: new () => RuntimeWorklet } = {}
    class FakeProcessor {
      port = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        postMessage: (message: WorkletMessage): void => void messages.push(message)
      }
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WHISPER_WORKLET_SRC)(
      FakeProcessor,
      (_name: string, cls: new () => RuntimeWorklet): void => void (registration.ctor = cls),
      16_000
    )
    if (!registration.ctor) throw new Error('worklet source registered no processor')
    return new registration.ctor()
  }

  function tone(samples: number, amplitude: number): Float32Array {
    const result = new Float32Array(samples)
    for (let i = 0; i < samples; i++) result[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 16_000)
    return result
  }

  function modulatedTone(samples: number): Float32Array {
    const result = new Float32Array(samples)
    for (let i = 0; i < samples; i++) {
      const amplitude = Math.floor(i / 800) % 2 === 0 ? 0.1 : 0.01
      result[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 16_000)
    }
    return result
  }

  it('posts the matching acknowledgement after the final buffered audio', () => {
    const messages: WorkletMessage[] = []
    const worklet = instantiate(messages)
    worklet.process([[tone(3_200, 0.1)]])

    worklet.port.onmessage?.({ data: { type: 'seal-and-flush', requestId: 'stop:7' } } as MessageEvent)

    expect(messages).toHaveLength(2)
    expect(messages[0]?.audio).toBeInstanceOf(Float32Array)
    expect(messages[0]?.partial).toBe(false)
    expect(messages[1]).toEqual({ type: 'flush-ack', requestId: 'stop:7' })
  })

  it('does not capture or emit any audio processed after it is sealed', () => {
    const messages: WorkletMessage[] = []
    const worklet = instantiate(messages)
    worklet.port.onmessage?.({ data: { type: 'seal-and-flush', requestId: 'stop:8' } } as MessageEvent)
    messages.length = 0

    worklet.process([[modulatedTone(20_800)]]) // crosses the 1.2s partial threshold when unsealed

    expect(messages).toHaveLength(0)
  })
})

describe('useListen Stop flush ownership', () => {
  it('waits for a delayed paused-session flush ACK and commits its preceding final audio', async () => {
    sealMode = { delayMs: 200, audio: new Float32Array([0.2]), acknowledge: true, throwOnPost: false }
    vi.mocked(window.toto.parakeetFeed).mockResolvedValue({ text: 'The final paused sentence.', name: 'Alice' })
    let api = await start()
    api.pause()
    await vi.advanceTimersByTimeAsync(80)
    api = render()
    expect(api.paused).toBe(true)

    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(199)
    expect(drained).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(61)
    await settle()
    api = render()
    expect(drained).toHaveBeenCalledTimes(1)
    expect(api.text()).toBe('THEM: The final paused sentence.')
  })

  it('keeps every repeated Stop subscriber pending until the shared active decode drains', async () => {
    let resolveFeed!: (value: { text: string; name?: string }) => void
    vi.mocked(window.toto.parakeetFeed).mockImplementation(
      () => new Promise((resolve) => void (resolveFeed = resolve))
    )
    const api = await start()
    const worklet = worklets.at(-1)
    if (!worklet) throw new Error('test worklet did not open')
    worklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()

    const first = vi.fn()
    const second = vi.fn()
    api.stop(first)
    api.stop(second)
    await vi.advanceTimersByTimeAsync(100)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    resolveFeed({ text: 'The pending sentence.', name: 'Alice' })
    await settle()
    await vi.advanceTimersByTimeAsync(60)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps draining a healthy serial native backlog while sealed outstanding work makes progress', async () => {
    let call = 0
    vi.mocked(window.toto.parakeetFeed).mockImplementation(
      () =>
        new Promise((resolve) => {
          const text = call++ === 0 ? 'First healthy window.' : 'Second healthy window.'
          setTimeout(() => resolve({ text, name: 'Alice' }), 4_000)
        })
    )
    let api = await start()
    const worklet = worklets.at(-1)
    if (!worklet) throw new Error('test worklet did not open')
    worklet.emit({ audio: new Float32Array([0.2]), partial: false })
    worklet.emit({ audio: new Float32Array([0.3]), partial: false })
    await settle()

    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(7_000)
    await settle()
    expect(drained).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_200)
    await settle()
    api = render()
    expect(drained).toHaveBeenCalledTimes(1)
    expect(api.text()).toBe('THEM: First healthy window.\nTHEM: Second healthy window.')
  })

  it('continues a sealed native backlog through three rejections and its Whisper fallback', async () => {
    vi.mocked(window.toto.parakeetFeed).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('native decode rejected')), 4_000))
    )
    let api = await start()
    const worklet = worklets.at(-1)
    if (!worklet) throw new Error('test worklet did not open')
    for (let i = 0; i < 4; i++) worklet.emit({ audio: new Float32Array([0.2 + i / 10]), partial: false })
    await settle()

    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(12_100)
    await settle()
    expect(drained).not.toHaveBeenCalled()

    const fallbackWorker = workers.at(-1)
    if (!fallbackWorker) throw new Error('Whisper fallback worker did not open')
    fallbackWorker.emit({ type: 'ready', qualityDegraded: false })
    await settle()
    expect(fallbackWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio' }),
      expect.any(Array)
    )
    fallbackWorker.emit({ type: 'text', text: 'Recovered final window.', speaker: 'them' })
    await vi.advanceTimersByTimeAsync(60)
    await settle()

    api = render()
    expect(drained).toHaveBeenCalledTimes(1)
    expect(api.text()).toContain('Recovered final window.')
  })

  it('uses the explicit Stop-only Whisper no-progress bound while a worker is not ready', async () => {
    let api = render('whisper')
    await api.start('system', 'fast', 'whisper', 'English')
    await settle()
    const worklet = worklets.at(-1)
    const worker = workers.at(-1)
    if (!worklet || !worker) throw new Error('test Whisper capture did not open')
    worklet.emit({ audio: new Float32Array([0.2]), partial: false })

    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(179_999)
    expect(drained).not.toHaveBeenCalled()
    expect(worker.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    await settle()
    api = render('whisper')
    expect(drained).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(api.error).toContain('transcript may be incomplete')
  })

  it('terminates a hung Whisper worker at the no-progress bound and ignores its late messages', async () => {
    let api = await start('whisper')
    const worklet = worklets.at(-1)
    const staleWorker = workers.at(-1)
    if (!worklet || !staleWorker) throw new Error('test Whisper capture did not open')
    worklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()

    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(180_100)
    await settle()
    expect(drained).toHaveBeenCalledTimes(1)
    expect(staleWorker.terminate).toHaveBeenCalledTimes(1)

    api = render('whisper')
    await api.start('system', 'fast', 'whisper', 'English')
    await settle()
    const replacementWorker = workers.at(-1)
    if (!replacementWorker || replacementWorker === staleWorker) throw new Error('replacement worker did not open')
    replacementWorker.emit({ type: 'ready', qualityDegraded: false })
    await settle()
    staleWorker.emit({ type: 'error', message: 'late stale failure' })
    staleWorker.emit({ type: 'text', text: 'late stale text', speaker: 'them' })
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    api = render('whisper')

    expect(drained).toHaveBeenCalledTimes(1)
    expect(replacementWorker.terminate).not.toHaveBeenCalled()
    expect(api.error).toBeNull()
    expect(api.text()).not.toContain('late stale text')
  })

  it('abandons an old Stop watchdog without terminating a replacement session worker', async () => {
    const firstApi = await start('whisper')
    const firstWorklet = worklets.at(-1)
    const firstWorker = workers.at(-1)
    if (!firstWorklet || !firstWorker) throw new Error('first Whisper capture did not open')
    firstWorklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()
    const oldDrained = vi.fn()
    firstApi.stop(oldDrained)

    const replacementApi = render('whisper')
    await replacementApi.start('system', 'fast', 'whisper', 'English')
    await settle()
    const replacementWorker = workers.at(-1)
    if (!replacementWorker || replacementWorker === firstWorker) throw new Error('replacement worker did not open')
    replacementWorker.emit({ type: 'ready', qualityDegraded: false })
    await vi.advanceTimersByTimeAsync(180_100)
    await settle()

    expect(oldDrained).not.toHaveBeenCalled()
    expect(replacementWorker.terminate).not.toHaveBeenCalled()
  })

  it('releases the exact sealed channel hardware as soon as its ACK arrives', async () => {
    vi.mocked(window.toto.parakeetFeed).mockImplementation(() => new Promise(() => {}))
    const api = await start()
    const worklet = worklets.at(-1)
    const systemTrack = streams.find((entry) => entry.kind === 'system')?.track
    if (!worklet || !systemTrack) throw new Error('test system channel did not open')
    worklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()

    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(1)

    expect(systemTrack.stop).toHaveBeenCalledTimes(1)
    expect(drained).not.toHaveBeenCalled()
  })

  it('rejects an acquisition that resolves after Stop sealed the existing capture frontier', async () => {
    let resolveDisplay!: (stream: MediaStream) => void
    getDisplayMediaImpl = () => new Promise((resolve) => void (resolveDisplay = resolve))
    vi.mocked(window.toto.parakeetFeed).mockImplementation(() => new Promise(() => {}))
    let api = render()
    const startPromise = api.start('both', 'fast', 'parakeet', 'English')
    await settle()
    const micWorklet = worklets.at(-1)
    if (!micWorklet) throw new Error('test microphone channel did not open')
    micWorklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()

    api.stop()
    await vi.advanceTimersByTimeAsync(1)
    const lateSystem = makeStream('system')
    const lateTrack = streams.at(-1)?.track
    resolveDisplay(lateSystem)
    await startPromise
    await settle()
    api = render()

    expect(lateTrack?.stop).toHaveBeenCalledTimes(1)
    expect(worklets).toHaveLength(1)
    expect(api.capturing).toBe(false)
  })

  it('rejects a recovery whose worklet module finishes loading during Stop drain', async () => {
    let resolveModule!: () => void
    vi.mocked(window.toto.parakeetFeed).mockImplementation(() => new Promise(() => {}))
    const api = await start('parakeet')
    const initialWorklet = worklets.at(-1)
    const initialTrack = streams.find((entry) => entry.kind === 'system')?.track
    if (!initialWorklet || !initialTrack) throw new Error('test system channel did not open')
    initialWorklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()

    addModuleImpl = () => new Promise((resolve) => void (resolveModule = resolve))
    initialTrack.onended?.()
    await settle()
    const recovery = streams.at(-1)
    expect(contexts).toHaveLength(2)

    api.stop()
    resolveModule()
    await settle()

    expect(recovery?.track.stop).toHaveBeenCalledTimes(1)
    expect(contexts.at(-1)?.state).toBe('closed')
    expect(worklets).toHaveLength(1)
  })

  it('does not let a stale recovery close or publish over a replacement session', async () => {
    let resolveModule!: () => void
    let shouldBlockModule = true
    const firstApi = await start('parakeet')
    const initialTrack = streams.find((entry) => entry.kind === 'system')?.track
    if (!initialTrack) throw new Error('test system channel did not open')

    addModuleImpl = () => {
      if (!shouldBlockModule) return Promise.resolve()
      shouldBlockModule = false
      return new Promise((resolve) => void (resolveModule = resolve))
    }
    initialTrack.onended?.()
    await settle()
    const staleRecovery = streams.at(-1)
    firstApi.stop()

    const replacementApi = render()
    const replacementStart = replacementApi.start('system', 'fast', 'parakeet', 'English')
    await settle()
    const replacement = streams.at(-1)
    resolveModule()
    await replacementStart
    await settle()
    const current = render()

    expect(staleRecovery?.track.stop).toHaveBeenCalledTimes(1)
    expect(replacement?.track.stop).not.toHaveBeenCalled()
    expect(worklets).toHaveLength(2)
    expect(current.capturing).toBe(true)
  })

  it('ignores a device-change debounce that originated before a mic-only replacement session', async () => {
    const firstApi = await start('parakeet')
    mediaDeviceListeners.devicechange?.()
    firstApi.stop()
    await vi.advanceTimersByTimeAsync(1)

    const replacementApi = render()
    await replacementApi.start('mic', 'fast', 'parakeet', 'English')
    const streamsBeforeOldDebounce = streams.length
    const workletsBeforeOldDebounce = worklets.length
    await vi.advanceTimersByTimeAsync(800)
    await settle()

    expect(streams).toHaveLength(streamsBeforeOldDebounce)
    expect(worklets).toHaveLength(workletsBeforeOldDebounce)
    expect(streams.filter((entry) => entry.kind === 'system')).toHaveLength(1)
  })

  it('ignores an old permission result after Stop is replaced by a mic-only session', async () => {
    getDisplayMediaImpl = async () => {
      throw Object.assign(new Error('screen capture denied'), { name: 'NotAllowedError' })
    }
    let resolvePermission!: (value: { screenRecording: string }) => void
    getPermissionsImpl = () => new Promise((resolve) => void (resolvePermission = resolve))

    let firstApi = render()
    await firstApi.start('both', 'fast', 'parakeet', 'English')
    firstApi = render() // refresh the registered permission effect with listening=true
    host.rerunEffect(1)
    getDisplayMediaImpl = async () => makeStream('system')
    await vi.advanceTimersByTimeAsync(3_000)
    await settle()
    expect(window.toto.getPermissions).toHaveBeenCalledTimes(1)

    firstApi.stop()
    await vi.advanceTimersByTimeAsync(1)
    const replacementApi = render()
    await replacementApi.start('mic', 'fast', 'parakeet', 'English')
    const streamsBeforePermission = streams.length
    const workletsBeforePermission = worklets.length
    resolvePermission({ screenRecording: 'granted' })
    await settle()

    expect(streams).toHaveLength(streamsBeforePermission)
    expect(worklets).toHaveLength(workletsBeforePermission)
    expect(streams.filter((entry) => entry.kind === 'system')).toHaveLength(0)
  })

  it('ignores a stale ACK and accepts only the active Stop request identity', async () => {
    sealMode.acknowledge = false
    const api = await start()
    const worklet = worklets.at(-1)
    if (!worklet) throw new Error('test worklet did not open')
    const drained = vi.fn()
    api.stop(drained)
    worklet.emit({ type: 'flush-ack', requestId: 'stale-stop' })
    await vi.advanceTimersByTimeAsync(100)
    expect(drained).not.toHaveBeenCalled()

    const request = worklet.posted.find(
      (message): message is { type: string; requestId: string } =>
        !!message && typeof message === 'object' && (message as { type?: string }).type === 'seal-and-flush'
    )
    expect(request?.requestId).toBeTruthy()
    worklet.emit({ type: 'flush-ack', requestId: request?.requestId })
    await settle()
    expect(drained).toHaveBeenCalledTimes(1)
  })

  it('finishes immediately when no capture channels or queued work exist', async () => {
    const api = render()
    const drained = vi.fn()
    api.stop(drained)
    await settle()
    expect(drained).toHaveBeenCalledTimes(1)
  })

  it('bounds a missing ACK and retains a truthful final-audio warning after teardown', async () => {
    sealMode.acknowledge = false
    let api = await start()
    const drained = vi.fn()
    api.stop(drained)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(drained).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await settle()

    api = render()
    expect(drained).toHaveBeenCalledTimes(1)
    expect(api.error).toContain('final audio')
    expect(api.error).toContain('missing')
  })

  it('treats a closed worklet port as a truthful flush failure rather than a clean drain', async () => {
    sealMode.throwOnPost = true
    let api = await start()
    const drained = vi.fn()
    api.stop(drained)
    await settle()
    api = render()

    expect(drained).toHaveBeenCalledTimes(1)
    expect(api.error).toContain('final audio')
    expect(api.error).toContain('missing')
  })

  it('preserves an existing capture warning through otherwise-clean teardown', async () => {
    let resolveFirst!: (value: { text: string }) => void
    vi.mocked(window.toto.parakeetFeed)
      .mockImplementationOnce(() => new Promise((resolve) => void (resolveFirst = resolve)))
      .mockResolvedValue({ text: 'Queue drained.' })
    let api = await start()
    const worklet = worklets.at(-1)
    if (!worklet) throw new Error('test worklet did not open')
    for (let i = 0; i < 34; i++) worklet.emit({ audio: new Float32Array([0.2]), partial: false })
    await settle()
    api = render()
    expect(api.error).toContain('Transcription fell behind')

    const drained = vi.fn()
    api.stop(drained)
    resolveFirst({ text: 'Queue drain started.' })
    for (let i = 0; i < 200; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(60)
    api = render()

    expect(drained).toHaveBeenCalledTimes(1)
    expect(api.error).toContain('Transcription fell behind')
  })

  it('cancels the pending flush deadline and abandons subscribers when the hook unmounts', async () => {
    sealMode.acknowledge = false
    const api = await start()
    const drained = vi.fn()
    api.stop(drained)

    host.unmount()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(4_001)
    expect(drained).not.toHaveBeenCalled()
  })

  it('settles every Stop subscriber once when the Whisper worker crashes during sealing', async () => {
    sealMode.delayMs = 1_000
    let api = await start('whisper')
    const worker = workers.at(-1)
    if (!worker) throw new Error('test worker did not open')
    const first = vi.fn()
    const second = vi.fn()
    api.stop(first)
    api.stop(second)

    worker.crash('decode worker crashed during final flush')
    await settle()
    api = render('whisper')
    expect(api.error).toContain('decode worker crashed during final flush')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
