/**
 * WP03 live meeting journal, renderer seam: commitLine hands each committed cloud-final line to the journal write
 * bridge exactly once, never a local-engine or provisional line, and never waits on or fails because of the bridge.
 *
 * The hook is driven through the same minimal React host used by listen.partial-caption.test.ts. The broker
 * speech session is faked at its one seam (`startCloudSpeechSession`) so a real provider segment event can be
 * delivered to the real `applyEvent` -> `commitLine` path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { TranscriptLine } from '@shared/ipc'

type Slot = { current: unknown }

const host = vi.hoisted(() => {
  let slots: Slot[] = []
  let cursor = 0
  const slot = <T>(initial: T): { current: T } => {
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
  useRef: <T>(initial: T) => host.useRef(initial),
  useState: <T>(initial: T) => host.useState(initial),
  useEffect: () => {},
  useCallback: <T>(fn: T) => fn,
  useMemo: <T>(fn: () => T) => fn()
}))

type WorkletMessage = { audio: Float32Array; sampleRate?: number; partial?: boolean }
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
    this.port.onmessage?.({ data: { sampleRate: 16000, ...message } } as MessageEvent<WorkletMessage>)
  }

  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  sampleRate = 16000
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

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }

  terminate(): void {}
}

type BrokerHost = {
  applyEvent(event: CloudSpeechEvent, epoch: number): void
  setController(controller: unknown): void
  setCaptureId(captureId: string): void
  setReady(): void
}
type BrokerInput = { epoch: number; captureId: string }
const broker = vi.hoisted(() => ({
  session: null as null | { host: BrokerHost; input: BrokerInput }
}))

vi.mock('./cloud-speech-listen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cloud-speech-listen')>()),
  startCloudSpeechSession: vi.fn(async (input: BrokerInput, host: BrokerHost) => {
    broker.session = { host, input }
    host.setController({ dispose: () => {}, stop: async () => ({ ok: true }), cancel: async () => {} })
    host.setCaptureId(input.captureId)
    host.setReady()
    return true
  })
}))

const { useListen } = await import('./listen')
type ListenApi = ReturnType<typeof useListen>
type Engine = 'parakeet' | 'apple' | 'whisper'

const STARTED_AT = 1_700_000_000_000
const CAPTURE_ID = '11111111-1111-4111-8111-111111111111'
const BROKER = { transport: 'broker-v1', engine: 'deepgram-nova3' } as const
const CONSENT = { engine: 'deepgram-nova3', requestedTracks: ['system'], disclosureVersion: 'cloud-speech-v1' } as const

let appendMeetingJournal: ReturnType<typeof vi.fn>
let appendSessionLedgerLine: ReturnType<typeof vi.fn>

async function settlePromises(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function renderCloud(): ListenApi {
  host.beginRender()
  return useListen(
    vi.fn(),
    undefined,
    undefined,
    '',
    undefined,
    'cloud',
    'fast',
    undefined,
    'deepgram',
    undefined,
    BROKER
  )
}

function renderLocal(engine: Engine): ListenApi {
  host.beginRender()
  return useListen(vi.fn(), undefined, undefined, '', undefined, engine, 'fast')
}

async function startCloud(): Promise<ListenApi> {
  const api = renderCloud()
  await api.start('system', 'fast', 'cloud', 'English', STARTED_AT, CONSENT)
  await settlePromises()
  if (!broker.session) throw new Error('the broker speech session was not started')
  return api
}

function finalEvent(index: number, text: string, overrides: { final?: boolean } = {}): CloudSpeechEvent {
  return {
    type: 'segment',
    captureId: CAPTURE_ID,
    captureGeneration: 1,
    sequence: index,
    segment: {
      stream: { generation: 1, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision: 1,
      final: overrides.final ?? true,
      text,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900
    }
  } as CloudSpeechEvent
}

async function deliver(event: CloudSpeechEvent): Promise<void> {
  const session = broker.session
  if (!session) throw new Error('no broker session')
  session.host.applyEvent(event, session.input.epoch)
  await settlePromises()
}

beforeEach(() => {
  host.reset()
  worklets = []
  workers = []
  broker.session = null
  appendMeetingJournal = vi.fn(async () => ({ status: 'durable' }))
  appendSessionLedgerLine = vi.fn(async () => ({ status: 'accepted' }))
  vi.useFakeTimers()
  vi.setSystemTime(STARTED_AT + 10_000)
  const track = {
    stop: () => {},
    onended: null as (() => void) | null,
    readyState: 'live',
    applyConstraints: async () => {}
  }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  vi.stubGlobal('window', {
    toto: {
      setListeningState: async () => true,
      armAudio: async () => {},
      parakeetStatus: async () => ({ ready: true, addonError: null }),
      parakeetEnsure: async () => ({ ok: true }),
      onParakeetProgress: () => () => {},
      parakeetFeed: async () => ({ text: 'a local engine sentence', name: 'Alice' }),
      appleSpeechFeed: async () => ({ text: 'a local engine sentence', name: 'Alice' }),
      asrBundled: async () => true,
      speakerEmbed: async () => ({ name: 'Alice' }),
      onMeetingMicCaptureRevoked: () => () => {},
      appendMeetingJournal: (payload: unknown) => appendMeetingJournal(payload),
      appendSessionLedgerLine: (payload: unknown) => appendSessionLedgerLine(payload)
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  })
  vi.stubGlobal('navigator', {
    platform: 'MacIntel',
    onLine: true,
    mediaDevices: { getUserMedia: async () => stream, getDisplayMedia: async () => stream }
  })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('renderer live-journal write seam', () => {
  it('sends exactly one append for a committed cloud final, carrying the committed line and the meeting start', async () => {
    await startCloud()
    await deliver(finalEvent(1, 'We agreed to ship the pilot on Tuesday'))
    const api = renderCloud()
    expect(api.lines).toHaveLength(1)
    expect(appendMeetingJournal).toHaveBeenCalledTimes(1)
    const payload = appendMeetingJournal.mock.calls[0]![0] as { startedAt: number; line: TranscriptLine }
    expect(payload.startedAt).toBe(STARTED_AT)
    expect(payload.line).toBe(api.lines[0])
    expect(payload.line.speech?.segment.final).toBe(true)
    expect(payload.line.text).toBe('We agreed to ship the pilot on Tuesday')
    expect(Object.keys(payload).sort()).toEqual(['line', 'startedAt'])
    // Main sees a relay segment itself and feeds its own ledger from it: the renderer never forwards it.
    expect(appendSessionLedgerLine).not.toHaveBeenCalled()
  })

  it('sends one append per final, in commit order', async () => {
    await startCloud()
    await deliver(finalEvent(1, 'first sentence of the meeting'))
    await deliver(finalEvent(2, 'second sentence of the meeting'))
    expect(appendMeetingJournal.mock.calls.map((call) => (call[0] as { line: TranscriptLine }).line.text)).toEqual([
      'first sentence of the meeting',
      'second sentence of the meeting'
    ])
  })

  it('does not journal a non-final cloud segment, which never commits a line', async () => {
    await startCloud()
    await deliver(finalEvent(1, 'still being spoken', { final: false }))
    expect(renderCloud().lines).toHaveLength(0)
    expect(appendMeetingJournal).not.toHaveBeenCalled()
  })

  it.each(['parakeet', 'apple', 'whisper'] as const)('does not journal a %s local-engine line', async (engine) => {
    const api = renderLocal(engine)
    await api.start('system', 'fast', engine, 'English', STARTED_AT)
    await settlePromises()
    if (engine === 'whisper') {
      workers.at(-1)?.postMessage.mockClear()
      workers.at(-1)?.emit({ type: 'ready', qualityDegraded: false })
      await settlePromises()
    }
    worklets.at(-1)?.emit({ audio: new Float32Array([0.2, -0.1, 0.3]), partial: false })
    await settlePromises()
    if (engine === 'whisper') {
      workers.at(-1)?.emit({ type: 'text', text: 'a local engine sentence', speaker: 'them', partial: false })
      await settlePromises()
    }
    expect(renderLocal(engine).lines.some((line) => line.text === 'a local engine sentence')).toBe(true)
    expect(appendMeetingJournal).not.toHaveBeenCalled()
    // Main never sees a committed local line, so the renderer forwards it to the ledger main owns: text and
    // identity only, never a name, and never as part of any ask.
    expect(appendSessionLedgerLine).toHaveBeenCalledTimes(1)
    const sent = appendSessionLedgerLine.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ op: 'final', startedAt: STARTED_AT, speaker: 'them', text: 'a local engine sentence' })
    expect(Object.keys(sent).sort()).toEqual(['op', 'speaker', 'startedAt', 't', 'text'])
  })

  it('never lets the bridge change capture: a rejecting, throwing, hanging or missing bridge leaves lines untouched', async () => {
    await startCloud()
    appendMeetingJournal.mockRejectedValueOnce(new Error('journal exploded'))
    await deliver(finalEvent(1, 'rejected append'))
    appendMeetingJournal.mockImplementationOnce(() => {
      throw new Error('bridge threw synchronously')
    })
    await deliver(finalEvent(2, 'throwing append'))
    appendMeetingJournal.mockImplementationOnce(() => new Promise(() => undefined))
    await deliver(finalEvent(3, 'hanging append'))
    const bridge = (globalThis as unknown as { window: { toto: Record<string, unknown> } }).window.toto
    delete bridge.appendMeetingJournal
    await deliver(finalEvent(4, 'missing bridge'))
    expect(renderCloud().lines.map((line) => line.text)).toEqual([
      'rejected append',
      'throwing append',
      'hanging append',
      'missing bridge'
    ])
  })

  it('does not wait on the journal: the line is committed before the bridge settles', async () => {
    await startCloud()
    let settle!: () => void
    appendMeetingJournal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ status: 'durable' })
        })
    )
    await deliver(finalEvent(1, 'committed while the journal is still writing'))
    expect(renderCloud().lines).toHaveLength(1)
    settle()
  })
})
