import WebSocket from 'ws'
import {
  SPEECH_BROKER_WS_MAX_PAYLOAD,
  SpeechBrokerClient,
  type BrokerFailureCode,
  type CreatedSpeechSession,
  type SpeechCreateRequest,
  type SpeechTrack
} from './broker-client'
import { BoundedRelayPcmQueue, type RelayPcmFrame, type RelayQueueFailureCode } from './relay-queue'
import { RelayResultSequence, type RelayIdentity, type RelayTerminal, type RelayTranscript } from './relay-results'

export type RelayTrackClosure = {
  track: SpeechTrack
  streamEpoch: number
  closeConfirmed: boolean
  tail: 'complete' | 'incomplete'
  lastSequence: number
  reason: RelayTerminal['reason']
}

export type RelaySessionFinish = {
  complete: boolean
  tracks: RelayTrackClosure[]
  reason: 'normal' | 'incomplete' | 'cancelled'
}

export type RelaySessionFailureCode = BrokerFailureCode | 'TRACK_OPEN' | 'CANCELLED'
export type RelaySessionStartResult =
  | { ok: true; value: RelaySpeechSession }
  | { ok: false; code: RelaySessionFailureCode }

export type RelaySpeechSessionOptions = {
  client: SpeechBrokerClient
  createRequest: SpeechCreateRequest
  expectedSelection: {
    routeId: CreatedSpeechSession['routeId']
    modelId: CreatedSpeechSession['model']
    language: string
  }
  expectedContinuation?: {
    configVersion: string
    policyVersion: string
    epochs: Partial<Record<SpeechTrack, number>>
  }
  initialFrontiers?: Partial<Record<SpeechTrack, { sequence: number; sampleOffset: number }>>
  isCurrent?: () => boolean
  onTranscript?: (event: RelayTranscript, context: { timeBase: 'stream'; firstCaptureSampleOffset: number }) => void
}

type TrackRuntime = {
  track: SpeechTrack
  streamEpoch: number
  socket: WebSocket
  queue: BoundedRelayPcmQueue
  results: RelayResultSequence
  maxInputBytes: number
  maxStreamInputBytes: number
  admittedBytes: number
  firstCaptureSampleOffset: number | null
  captureNextSequence: number
  captureNextSampleOffset: number
  streamNextSequence: number
  streamNextSampleOffset: number
  terminal: RelayTerminal | null
  closure: Promise<RelayTrackClosure>
  resolveClosure: (value: RelayTrackClosure) => void
  finishPromise: Promise<RelayTrackClosure> | null
  failureReason: RelayTerminal['reason'] | null
  stopped: boolean
}

const MAX_CLOUD_FRAME_BYTES = 3_200
const MAX_FINISH_WAIT_MS = 5_000
const FINISH_MESSAGE = '{"type":"finish"}'
type DeadlineResult<T> = { done: true; value: T } | { done: false }

function toUtf8Text(data: WebSocket.RawData): string | null {
  try {
    if (typeof data === 'string') return data
    if (Buffer.isBuffer(data)) return data.toString('utf8')
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
    return null
  } catch {
    return null
  }
}

function closureFromTerminal(track: SpeechTrack, streamEpoch: number, terminal: RelayTerminal): RelayTrackClosure {
  return {
    track,
    streamEpoch,
    closeConfirmed: terminal.closeConfirmed,
    tail: terminal.tail,
    lastSequence: terminal.lastSequence,
    reason: terminal.reason
  }
}

function incompleteClosure(track: SpeechTrack, streamEpoch: number, lastSequence: number): RelayTrackClosure {
  return {
    track,
    streamEpoch,
    closeConfirmed: false,
    tail: 'incomplete',
    lastSequence,
    reason: 'unknown'
  }
}

/** Main-process session for one consent-scoped allocation and its exact active tracks. */
export class RelaySpeechSession {
  private readonly tracks = new Map<SpeechTrack, TrackRuntime>()
  private finishing = false
  private cancelled = false
  private finishPromise: Promise<RelaySessionFinish> | null = null
  private cancelPromise: Promise<void> | null = null

  private constructor(
    private readonly client: SpeechBrokerClient,
    private readonly sessionId: string,
    private readonly captureGeneration: number,
    private readonly maxStreamMs: number,
    private readonly audioDeadlineAt: number,
    private readonly maxInputBytesPerTrack: number,
    private readonly maxClientFrameBytes: number,
    private readonly maxOutputBytesPerTrack: number,
    private readonly drainWindowMs: number,
    private readonly routeId: CreatedSpeechSession['routeId'],
    private readonly model: CreatedSpeechSession['model'],
    private readonly language: string,
    private readonly configVersion: string,
    private readonly policyVersion: string,
    private readonly tracksOrder: SpeechTrack[],
    private readonly initialFrontiers: RelaySpeechSessionOptions['initialFrontiers'],
    private readonly isCurrent: () => boolean,
    private readonly onTranscript?: RelaySpeechSessionOptions['onTranscript']
  ) {}

  static async create(options: RelaySpeechSessionOptions): Promise<RelaySessionStartResult> {
    for (const track of options.createRequest.tracks) {
      const frontier = options.initialFrontiers?.[track]
      if (
        frontier &&
        (!Number.isSafeInteger(frontier.sequence) ||
          frontier.sequence < 1 ||
          !Number.isSafeInteger(frontier.sampleOffset) ||
          frontier.sampleOffset < 0)
      )
        return { ok: false, code: 'SCHEMA' }
    }
    const created = await options.client.createSession(options.createRequest)
    if (!created.ok) return created
    const isCurrent = (): boolean => {
      try {
        return options.isCurrent?.() ?? true
      } catch {
        return false
      }
    }
    if (!isCurrent()) {
      await options.client.cancel(created.value.sessionId, 1_000)
      return { ok: false, code: 'CANCELLED' }
    }
    if (
      created.value.routeId !== options.expectedSelection.routeId ||
      created.value.model !== options.expectedSelection.modelId ||
      created.value.language !== options.expectedSelection.language ||
      (options.expectedContinuation !== undefined &&
        (created.value.configVersion !== options.expectedContinuation.configVersion ||
          created.value.policyVersion !== options.expectedContinuation.policyVersion ||
          created.value.grants.some(
            (grant) => grant.streamEpoch <= (options.expectedContinuation?.epochs[grant.track] ?? 0)
          )))
    ) {
      await options.client.cancel(created.value.sessionId, 1_000)
      return { ok: false, code: 'SCHEMA' }
    }
    const session = new RelaySpeechSession(
      options.client,
      created.value.sessionId,
      created.value.captureGeneration,
      created.value.limits.maxStreamMs,
      created.value.limits.audioDeadlineAt,
      created.value.limits.maxInputBytesPerTrack,
      created.value.limits.maxClientFrameBytes,
      created.value.limits.maxOutputBytesPerTrack,
      created.value.limits.drainWindowMs,
      created.value.routeId,
      created.value.model,
      created.value.language,
      created.value.configVersion,
      created.value.policyVersion,
      [...options.createRequest.tracks],
      options.initialFrontiers,
      isCurrent,
      options.onTranscript
    )
    for (const grant of created.value.grants) {
      if (!isCurrent()) {
        await session.cancel()
        return { ok: false, code: 'CANCELLED' }
      }
      const opened = await options.client.openTrack(created.value, grant.track)
      if (!opened.ok) {
        await session.cancel()
        return { ok: false, code: 'TRACK_OPEN' }
      }
      if (opened.value.readyState !== WebSocket.OPEN) {
        opened.value.terminate()
        await session.cancel()
        return { ok: false, code: 'TRACK_OPEN' }
      }
      if (!isCurrent()) {
        opened.value.terminate()
        await session.cancel()
        return { ok: false, code: 'CANCELLED' }
      }
      const runtime = session.makeTrackRuntime(grant.track, grant.streamEpoch, opened.value)
      session.tracks.set(grant.track, runtime)
      session.attachTrack(runtime)
    }
    return { ok: true, value: session }
  }

  get identity(): {
    sessionId: string
    captureGeneration: number
    routeId: CreatedSpeechSession['routeId']
    model: CreatedSpeechSession['model']
    language: string
    configVersion: string
    policyVersion: string
    audioDeadlineAt: number
    limits: {
      maxStreamMs: number
      drainWindowMs: number
      maxInputBytesPerTrack: number
      maxClientFrameBytes: number
      maxOutputBytesPerTrack: number
    }
    tracks: ReadonlyArray<{ track: SpeechTrack; streamEpoch: number }>
  } {
    return {
      sessionId: this.sessionId,
      captureGeneration: this.captureGeneration,
      routeId: this.routeId,
      model: this.model,
      language: this.language,
      configVersion: this.configVersion,
      policyVersion: this.policyVersion,
      audioDeadlineAt: this.audioDeadlineAt,
      limits: {
        maxStreamMs: this.maxStreamMs,
        drainWindowMs: this.drainWindowMs,
        maxInputBytesPerTrack: this.maxInputBytesPerTrack,
        maxClientFrameBytes: this.maxClientFrameBytes,
        maxOutputBytesPerTrack: this.maxOutputBytesPerTrack
      },
      tracks: [...this.tracks.values()].map(({ track, streamEpoch }) => ({ track, streamEpoch }))
    }
  }

  /** Allocate a fresh relay epoch only after the current one is fully closed; accepted PCM is never replayed. */
  async renew(createRequest: SpeechCreateRequest): Promise<RelaySessionStartResult> {
    const previous = await this.finish()
    if (!previous.complete || this.cancelled) return { ok: false, code: 'CANCELLED' }
    if (
      createRequest.captureGeneration !== this.captureGeneration ||
      createRequest.tracks.length !== this.tracksOrder.length ||
      createRequest.tracks.some((track, index) => track !== this.tracksOrder[index])
    )
      return { ok: false, code: 'SCHEMA' }
    const initialFrontiers: Partial<Record<SpeechTrack, { sequence: number; sampleOffset: number }>> = {}
    for (const [track, runtime] of this.tracks) {
      initialFrontiers[track] = {
        sequence: runtime.captureNextSequence,
        sampleOffset: runtime.captureNextSampleOffset
      }
    }
    const next = await RelaySpeechSession.create({
      client: this.client,
      createRequest,
      expectedSelection: { routeId: this.routeId, modelId: this.model, language: this.language },
      expectedContinuation: {
        configVersion: this.configVersion,
        policyVersion: this.policyVersion,
        epochs: Object.fromEntries([...this.tracks].map(([track, runtime]) => [track, runtime.streamEpoch]))
      },
      initialFrontiers,
      isCurrent: this.isCurrent,
      onTranscript: this.onTranscript
    })
    if (!next.ok) return next
    const sameTracks =
      next.value.tracksOrder.length === this.tracksOrder.length &&
      this.tracksOrder.every((track, index) => next.value.tracksOrder[index] === track)
    const matchingTrackEpochs = [...this.tracks.values()].every((runtime) => {
      const replacement = next.value.tracks.get(runtime.track)
      return replacement !== undefined && replacement.streamEpoch > runtime.streamEpoch
    })
    if (
      !sameTracks ||
      !matchingTrackEpochs ||
      next.value.routeId !== this.routeId ||
      next.value.model !== this.model ||
      next.value.configVersion !== this.configVersion ||
      next.value.policyVersion !== this.policyVersion
    ) {
      await next.value.cancel()
      return { ok: false, code: 'SCHEMA' }
    }
    return next
  }

  pushFrame(
    track: SpeechTrack,
    frame: RelayPcmFrame
  ): { ok: true } | { ok: false; code: RelayQueueFailureCode | 'LEASE_DRAINING' } {
    const runtime = this.tracks.get(track)
    if (!runtime || this.finishing || this.cancelled || runtime.stopped) return { ok: false, code: 'CLOSED' }
    if (Date.now() >= this.audioDeadlineAt) return { ok: false, code: 'LEASE_DRAINING' }
    if (
      !Number.isSafeInteger(frame.sequence) ||
      !Number.isSafeInteger(frame.sampleOffset) ||
      frame.sequence !== runtime.captureNextSequence ||
      frame.sampleOffset !== runtime.captureNextSampleOffset
    )
      return { ok: false, code: 'ORDER' }
    if (
      !(frame.pcm16le instanceof Uint8Array) ||
      frame.pcm16le.byteLength < 2 ||
      frame.pcm16le.byteLength % 2 !== 0 ||
      frame.pcm16le.byteLength > Math.min(MAX_CLOUD_FRAME_BYTES, this.maxClientFrameBytes)
    )
      return { ok: false, code: 'FRAME' }
    if (
      runtime.admittedBytes + frame.pcm16le.byteLength > runtime.maxInputBytes ||
      runtime.admittedBytes + frame.pcm16le.byteLength > runtime.maxStreamInputBytes
    ) {
      runtime.failureReason = 'limit'
      void this.cancel()
      return { ok: false, code: 'QUEUE_LIMIT' }
    }
    const accepted = runtime.queue.enqueue({
      sequence: runtime.streamNextSequence,
      sampleOffset: runtime.streamNextSampleOffset,
      pcm16le: frame.pcm16le
    })
    if (!accepted.ok) {
      runtime.failureReason = accepted.code === 'QUEUE_LIMIT' || accepted.code === 'QUEUE_STALE' ? 'limit' : 'unknown'
      void this.cancel()
      return accepted
    }
    runtime.admittedBytes += frame.pcm16le.byteLength
    if (runtime.firstCaptureSampleOffset === null) runtime.firstCaptureSampleOffset = frame.sampleOffset
    runtime.captureNextSequence += 1
    runtime.captureNextSampleOffset += frame.pcm16le.byteLength / 2
    runtime.streamNextSequence += 1
    runtime.streamNextSampleOffset += frame.pcm16le.byteLength / 2
    void this.drain(runtime)
    return { ok: true }
  }

  finish(timeoutMs = MAX_FINISH_WAIT_MS): Promise<RelaySessionFinish> {
    if (this.finishPromise) return this.finishPromise
    this.finishing = true
    const boundedTimeout = Math.max(1, Math.min(timeoutMs, this.drainWindowMs, MAX_FINISH_WAIT_MS))
    this.finishPromise = this.finishAll(Date.now() + boundedTimeout)
    return this.finishPromise
  }

  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise
    this.cancelled = true
    this.finishing = true
    for (const runtime of this.tracks.values()) {
      runtime.stopped = true
      runtime.queue.close()
      try {
        runtime.socket.terminate()
      } catch {
        /* best-effort local teardown */
      }
      runtime.resolveClosure(incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence))
    }
    this.cancelPromise = this.client.cancel(this.sessionId, 1_000).then(
      () => undefined,
      () => undefined
    )
    return this.cancelPromise
  }

  private makeTrackRuntime(track: SpeechTrack, streamEpoch: number, socket: WebSocket): TrackRuntime {
    let resolveClosure!: (value: RelayTrackClosure) => void
    const closure = new Promise<RelayTrackClosure>((resolve) => {
      resolveClosure = resolve
    })
    const expected: RelayIdentity = {
      protocolVersion: 1,
      sessionId: this.sessionId,
      captureGeneration: this.captureGeneration,
      track,
      streamEpoch
    }
    return {
      track,
      streamEpoch,
      socket,
      queue: new BoundedRelayPcmQueue(),
      results: new RelayResultSequence(expected, this.maxStreamMs, this.maxOutputBytesPerTrack),
      maxInputBytes: this.maxInputBytesPerTrack,
      maxStreamInputBytes:
        this.maxStreamMs > this.maxInputBytesPerTrack / 32 ? this.maxInputBytesPerTrack : this.maxStreamMs * 32,
      admittedBytes: 0,
      firstCaptureSampleOffset: null,
      captureNextSequence: this.initialFrontiers?.[track]?.sequence ?? 1,
      captureNextSampleOffset: this.initialFrontiers?.[track]?.sampleOffset ?? 0,
      streamNextSequence: 1,
      streamNextSampleOffset: 0,
      terminal: null,
      closure,
      resolveClosure,
      finishPromise: null,
      failureReason: null,
      stopped: false
    }
  }

  private attachTrack(runtime: TrackRuntime): void {
    runtime.socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary || runtime.stopped) return
      const text = toUtf8Text(data)
      if (text === null || Buffer.byteLength(text, 'utf8') > SPEECH_BROKER_WS_MAX_PAYLOAD) {
        this.failTrack(runtime, 'unknown')
        return
      }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        this.failTrack(runtime, 'unknown')
        return
      }
      const accepted = runtime.results.accept(value)
      if (!accepted.ok) {
        this.failTrack(runtime, 'unknown')
        return
      }
      if (accepted.event.type === 'transcript') {
        try {
          this.onTranscript?.(accepted.event, {
            timeBase: 'stream',
            firstCaptureSampleOffset: runtime.firstCaptureSampleOffset ?? 0
          })
        } catch {
          /* transcript consumer failure does not change relay ownership or leak provider data */
        }
      } else if (accepted.event.type === 'terminal') {
        runtime.terminal = accepted.event
        runtime.stopped = true
        runtime.resolveClosure(closureFromTerminal(runtime.track, runtime.streamEpoch, accepted.event))
        try {
          runtime.socket.close()
        } catch {
          /* closure is already confirmed by the relay event */
        }
      } else {
        runtime.failureReason = 'upstream-error'
      }
    })
    runtime.socket.once('close', () => {
      if (runtime.terminal) return
      runtime.stopped = true
      runtime.resolveClosure(incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence))
    })
    runtime.socket.once('error', () => {
      if (runtime.terminal) return
      runtime.failureReason = 'unknown'
    })
  }

  private failTrack(runtime: TrackRuntime, reason: RelayTerminal['reason']): void {
    runtime.failureReason = reason
    runtime.stopped = true
    runtime.queue.close()
    runtime.resolveClosure(incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence))
    try {
      runtime.socket.terminate()
    } catch {
      /* teardown remains incomplete */
    }
    void this.cancel()
  }

  private drain(runtime: TrackRuntime): Promise<void> {
    const result = runtime.queue.drain((pcm, _sequence) => {
      if (Date.now() >= this.audioDeadlineAt) {
        runtime.failureReason = 'lease-expired'
        throw new Error('audio deadline reached')
      }
      if (runtime.socket.readyState !== WebSocket.OPEN) throw new Error('socket not open')
      const bufferedAmount = runtime.socket.bufferedAmount
      if (
        !Number.isFinite(bufferedAmount) ||
        bufferedAmount < 0 ||
        bufferedAmount + pcm.byteLength > BoundedRelayPcmQueueMaxBytes
      )
        throw new Error('send queue full')
      return new Promise<void>((resolve, reject) => {
        runtime.socket.send(pcm, { binary: true }, (error?: Error) => (error ? reject(error) : resolve()))
      })
    })
    return result.then((status) => {
      if (!status.ok) {
        runtime.failureReason = status.code === 'QUEUE_LIMIT' || status.code === 'QUEUE_STALE' ? 'limit' : 'unknown'
        runtime.queue.close()
        void this.cancel()
      }
    })
  }

  private finishTrack(runtime: TrackRuntime, deadlineAt: number): Promise<RelayTrackClosure> {
    if (runtime.finishPromise) return runtime.finishPromise
    runtime.finishPromise = this.finishOneTrack(runtime, deadlineAt)
    return runtime.finishPromise
  }

  private async finishOneTrack(runtime: TrackRuntime, deadlineAt: number): Promise<RelayTrackClosure> {
    runtime.queue.seal()
    const draining = runtime.queue.drain((pcm) => {
      if (Date.now() >= this.audioDeadlineAt) {
        runtime.failureReason = 'lease-expired'
        throw new Error('audio deadline reached')
      }
      if (runtime.socket.readyState !== WebSocket.OPEN) throw new Error('socket not open')
      const bufferedAmount = runtime.socket.bufferedAmount
      if (
        !Number.isFinite(bufferedAmount) ||
        bufferedAmount < 0 ||
        bufferedAmount + pcm.byteLength > BoundedRelayPcmQueueMaxBytes
      )
        throw new Error('send queue full')
      return new Promise<void>((resolve, reject) => {
        runtime.socket.send(pcm, { binary: true }, (error?: Error) => (error ? reject(error) : resolve()))
      })
    })
    const drainResult = await this.untilDeadline(draining, deadlineAt)
    if (!drainResult.done) return this.stopAtDeadline(runtime)
    if (!drainResult.value.ok || this.cancelled || runtime.stopped || runtime.socket.readyState !== WebSocket.OPEN) {
      const incomplete = incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence)
      runtime.resolveClosure(incomplete)
      return incomplete
    }
    const sendingFinish = new Promise<boolean>((resolve) => {
      try {
        runtime.socket.send(FINISH_MESSAGE, { binary: false }, (error?: Error) => resolve(!error))
      } catch {
        resolve(false)
      }
    })
    const finishResult = await this.untilDeadline(sendingFinish, deadlineAt)
    if (!finishResult.done) return this.stopAtDeadline(runtime)
    const finishSent = finishResult.value
    if (!finishSent) {
      runtime.failureReason = 'unknown'
      const incomplete = incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence)
      runtime.resolveClosure(incomplete)
      void this.client.cancel(this.sessionId, 1_000)
      return incomplete
    }
    const closureResult = await this.untilDeadline(runtime.closure, deadlineAt)
    const observed = closureResult.done ? closureResult.value : await this.stopAtDeadline(runtime)
    if (observed.closeConfirmed) return observed
    const remaining = Math.max(1, deadlineAt - Date.now())
    const statusResult = await this.untilDeadline(this.client.status(this.sessionId, remaining), deadlineAt)
    if (
      statusResult.done &&
      statusResult.value.ok &&
      statusResult.value.value.captureGeneration === this.captureGeneration
    ) {
      const row = statusResult.value.value.tracks.find(
        (item) => item.track === runtime.track && item.streamEpoch === runtime.streamEpoch
      )
      if (row?.closeConfirmed && row.lastSequence === runtime.results.sequence) {
        return {
          track: runtime.track,
          streamEpoch: runtime.streamEpoch,
          closeConfirmed: true,
          tail: row.tail ?? 'incomplete',
          lastSequence: row.lastSequence,
          reason: row.tail === 'complete' ? 'normal' : (runtime.failureReason ?? 'unknown')
        }
      }
    }
    try {
      runtime.socket.terminate()
    } catch {
      /* best-effort teardown after the drain deadline */
    }
    void this.client.cancel(this.sessionId, 1_000)
    return observed
  }

  private async untilDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<DeadlineResult<T>> {
    const timeoutMs = deadlineAt - Date.now()
    if (timeoutMs <= 0) return { done: false }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<DeadlineResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), timeoutMs)
    })
    const result = promise
      .then<DeadlineResult<T>>((value) => ({ done: true, value }))
      .catch((): DeadlineResult<T> => ({ done: false }))
    const outcome = await Promise.race([result, timeout])
    if (timer) clearTimeout(timer)
    return outcome
  }

  private async stopAtDeadline(runtime: TrackRuntime): Promise<RelayTrackClosure> {
    const incomplete = incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence)
    runtime.stopped = true
    runtime.queue.close()
    runtime.resolveClosure(incomplete)
    try {
      runtime.socket.terminate()
    } catch {
      /* keep the finite incomplete result */
    }
    void this.cancel()
    return incomplete
  }

  private async finishAll(deadlineAt: number): Promise<RelaySessionFinish> {
    if (this.cancelled) return { complete: false, tracks: [], reason: 'cancelled' }
    const tracks = await Promise.all([...this.tracks.values()].map((runtime) => this.finishTrack(runtime, deadlineAt)))
    const complete = tracks.length > 0 && tracks.every((track) => track.closeConfirmed && track.tail === 'complete')
    return { complete, tracks, reason: complete ? 'normal' : this.cancelled ? 'cancelled' : 'incomplete' }
  }
}

const BoundedRelayPcmQueueMaxBytes = 64 * 1024
