/**
 * Task 2a — streaming captions are provisional on every live ASR engine.
 *
 * The hook is driven through the same minimal React host used by listen.compile-once.test.ts. The Web
 * Audio boundary is faked only far enough to deliver real worklet messages; assertions are on useListen's
 * public lines/text output and question callback, never on source text or mock call counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptLine } from '@shared/ipc'

type Slot = { current: unknown }

const host = vi.hoisted(() => {
  let slots: Slot[] = []
  let cursor = 0
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
    },
    reset(): void {
      slots = []
      cursor = 0
    }
  }
})

vi.mock('react', () => ({
  useRef: <T,>(initial: T) => host.useRef(initial),
  useState: <T,>(initial: T) => host.useState(initial),
  useEffect: () => {},
  useCallback: <T,>(fn: T) => fn,
  useMemo: <T,>(fn: () => T) => fn()
}))

type WorkletMessage = { audio: Float32Array; partial?: boolean }
let worklets: FakeAudioWorkletNode[] = []

class FakeAudioWorkletNode {
  port = {
    onmessage: null as ((event: MessageEvent<WorkletMessage>) => void) | null,
    postMessage: vi.fn()
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
  audioWorklet = { addModule: async (): Promise<void> => {} }

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

  async close(): Promise<void> {}
  async suspend(): Promise<void> {}
  async resume(): Promise<void> {}
}

type WorkerMessage = {
  type: string
  text?: string
  speaker?: 'them' | 'you'
  partial?: boolean
  qualityDegraded?: boolean
}
let workers: FakeWorker[] = []

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()

  constructor() {
    workers.push(this)
  }

  emit(message: WorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>)
  }

  terminate(): void {}
}

const { useListen } = await import('./listen')
type ListenApi = ReturnType<typeof useListen>
type Engine = 'parakeet' | 'apple' | 'whisper'

const partialText = 'What is the roadmap?'
const fullText = 'What is the roadmap for Europe?'
const laterText = 'Please send the revised plan tomorrow.'
const fixedNow = 1_700_000_000_000

let engineResponses: Array<{ text: string; name: string }> = []

function render(onQuestion: (line: TranscriptLine) => void, engine: Engine): ListenApi {
  host.beginRender()
  return useListen(onQuestion, undefined, undefined, '', undefined, engine, 'fast')
}

async function settlePromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

async function startSession(engine: Engine, onQuestion: (line: TranscriptLine) => void): Promise<ListenApi> {
  const api = render(onQuestion, engine)
  await api.start('system', 'fast', engine, 'English')
  await settlePromises()
  if (engine === 'whisper') {
    workers.at(-1)?.emit({ type: 'ready', qualityDegraded: false })
    await settlePromises()
  }
  return api
}

async function emitCaption(engine: Engine, text: string, partial: boolean): Promise<void> {
  const worklet = worklets.at(-1)
  if (!worklet) throw new Error('test worklet was not opened')
  worklet.emit({ audio: new Float32Array([0.2, -0.1, 0.3]), partial })
  await settlePromises()
  if (engine === 'whisper') {
    const worker = workers.at(-1)
    if (!worker) throw new Error('test worker was not opened')
    worker.emit({ type: 'text', text, speaker: 'them', partial })
  }
  await settlePromises()
}

beforeEach(() => {
  host.reset()
  worklets = []
  workers = []
  engineResponses = [
    { text: partialText, name: 'Alice' },
    { text: fullText, name: 'Alice' },
    { text: laterText, name: 'Alice' }
  ]
  vi.useFakeTimers()
  vi.setSystemTime(fixedNow)

  const nextEngineResponse = async (): Promise<{ text: string; name: string }> => {
    const next = engineResponses.shift()
    if (!next) throw new Error('unexpected engine feed')
    return next
  }
  const track = {
    stop: () => {},
    onended: null as (() => void) | null,
    readyState: 'live',
    applyConstraints: async () => {}
  }
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  }

  vi.stubGlobal('window', {
    toto: {
      setListeningState: async () => {},
      armAudio: async () => {},
      parakeetStatus: async () => ({ ready: true, addonError: null }),
      parakeetEnsure: async () => ({ ok: true }),
      onParakeetProgress: () => () => {},
      parakeetFeed: nextEngineResponse,
      appleSpeechFeed: nextEngineResponse,
      asrBundled: async () => true,
      speakerEmbed: async () => ({ name: 'Alice' })
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  })
  vi.stubGlobal('navigator', {
    platform: 'MacIntel',
    onLine: true,
    mediaDevices: {
      getUserMedia: async () => stream,
      getDisplayMedia: async () => stream
    }
  })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(['parakeet', 'apple', 'whisper'] as const)(
  '%s live caption behavior',
  (engine) => {
    it('replaces an overlapping partial with the named final, defers its question, and keeps later speech', async () => {
      const onQuestion = vi.fn()
      await startSession(engine, onQuestion)

      await emitCaption(engine, partialText, true)
      let api = render(onQuestion, engine)

      // Date.now is fixed: cleanup must remove the exact "…" placeholder, not this same-timestamp caption.
      expect(api.lines).toHaveLength(1)
      expect(api.lines[0]).toMatchObject({ speaker: 'them', text: partialText, t: fixedNow, provisional: true })
      expect(api.lines[0]?.text).not.toBe('…')
      expect(api.text()).toBe('')
      expect(onQuestion).not.toHaveBeenCalled()

      await emitCaption(engine, fullText, false)
      api = render(onQuestion, engine)

      expect(api.lines).toHaveLength(1)
      expect(api.lines[0]).toMatchObject({ speaker: 'them', text: fullText, name: 'Alice' })
      expect(api.lines[0]?.provisional).toBeUndefined()
      expect(api.text()).toBe(`THEM: ${fullText}`)
      expect(onQuestion).toHaveBeenCalledTimes(1)
      expect(onQuestion).toHaveBeenLastCalledWith(expect.objectContaining({ text: fullText }))

      await emitCaption(engine, laterText, false)
      api = render(onQuestion, engine)

      expect(api.lines.map((line) => line.text)).toEqual([fullText, laterText])
      expect(api.text()).toBe(`THEM: ${fullText}\nTHEM: ${laterText}`)
      expect(onQuestion).toHaveBeenCalledTimes(1)
    })
  }
)
