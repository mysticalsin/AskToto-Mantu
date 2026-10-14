import WebSocket from 'ws'
import {
  SPEECH_BROKER_WS_MAX_PAYLOAD,
  SpeechBrokerClient,
  type BrokerFailureCode,
  type CreatedSpeechSession,
  type SpeechBrokerOperation,
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

export type RelaySessionFailureCode =
  | BrokerFailureCode
  | 'TRACK_OPEN'
  | 'CANCELLED'
  | 'LEASE_DRAINING'
  | 'CLOSURE_UNCONFIRMED'
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
  expectedCapability: {
    configVersion: string
    policyVersion: string
  }
  operation?: SpeechBrokerOperation
  expectedContinuation?: {
    configVersion: string
    policyVersion: string
    epochs: Partial<Record<SpeechTrack, number>>
  }
  onAllocated?: (sessionId: string) => void
  initialFrontiers?: Partial<Record<SpeechTrack, { sequence: number; sampleOffset?: number }>>
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
  captureNextSampleOffset: number | null
  streamNextSequence: number
  streamNextSampleOffset: number
  terminal: RelayTerminal | null
  closure: Promise<RelayTrackClosure>
  resolveClosure: (value: RelayTrackClosure) => void
  finishPromise: Promise<RelayTrackClosure> | null
  failureReason: RelayTerminal['reason'] | null
  deliveryFailed: boolean
  terminalUnexpected: boolean
  stopped: boolean
}

const MAX_CLOUD_FRAME_BYTES = 3_200
const MAX_FINISH_WAIT_MS = 5_000
const MAX_STREAM_MS = 60_000
const MAX_INPUT_BYTES = 1_920_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const FINISH_MESSAGE = '{"type":"finish"}'
type DeadlineResult<T> = { done: true; value: T } | { done: false }

function toUtf8Text(data: WebSocket.RawData): string | null {
  try {
    if (typeof data === 'string') return data
    const decoder = new TextDecoder('utf-8', { fatal: true })
    if (Buffer.isBuffer(data)) return decoder.decode(data)
    if (Array.isArray(data)) return decoder.decode(Buffer.concat(data))
    if (data instanceof ArrayBuffer) return decoder.decode(data)
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
  private startupComplete = false
  private startupFailed = false
  private finishIncomplete = false
  private finishPromise: Promise<RelaySessionFinish> | null = null
  private cancelPromise: Promise<void> | null = null
  private renewPromise: Promise<RelaySessionStartResult> | null = null

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
    private readonly consentIssuedAt: number,
    private readonly consentExpiresAt: number,
    private readonly isCurrent: () => boolean,
    private readonly onAllocated: RelaySpeechSessionOptions['onAllocated'],
    private readonly onTranscript?: RelaySpeechSessionOptions['onTranscript']
  ) {}

  static async create(options: RelaySpeechSessionOptions): Promise<RelaySessionStartResult> {
    const isCurrent = (): boolean => {
      try {
        return options.isCurrent?.() ?? true
      } catch {
        return false
      }
    }
    if (!isCurrent()) return { ok: false, code: 'CANCELLED' }
    const operationFailure = options.client.operationFailure(options.operation)
    if (operationFailure) return { ok: false, code: operationFailure }
    for (const track of options.createRequest.tracks) {
      const frontier = options.initialFrontiers?.[track]
      if (
        frontier &&
        (!Number.isSafeInteger(frontier.sequence) ||
          frontier.sequence < 1 ||
          (frontier.sequence !== 1 && frontier.sampleOffset === undefined) ||
          (frontier.sampleOffset !== undefined &&
            (!Number.isSafeInteger(frontier.sampleOffset) || frontier.sampleOffset < 0)))
      )
        return { ok: false, code: 'SCHEMA' }
    }
    const created = await options.client.createSession(options.createRequest, options.operation)
    if (!created.ok) return created
    const allocationAt = Date.now()
    try {
      options.onAllocated?.(created.value.sessionId)
    } catch {
      await options.client.cancel(created.value.sessionId, 1_000)
      return { ok: false, code: 'TRACK_OPEN' }
    }
    const lateOperationFailure = options.client.operationFailure(options.operation)
    if (!isCurrent() || lateOperationFailure) {
      await options.client.cancel(created.value.sessionId, 1_000)
      return { ok: false, code: lateOperationFailure ?? 'CANCELLED' }
    }
    if (
      created.value.routeId !== options.expectedSelection.routeId ||
      created.value.model !== options.expectedSelection.modelId ||
      created.value.language !== options.expectedSelection.language ||
      created.value.configVersion !== options.expectedCapability.configVersion ||
      created.value.policyVersion !== options.expectedCapability.policyVersion ||
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
    const now = Date.now()
    const effectiveMaxStreamMs = Math.min(created.value.limits.maxStreamMs, MAX_STREAM_MS)
    const effectiveAudioDeadlineAt = Math.min(
      created.value.limits.audioDeadlineAt,
      created.value.leaseExpiresAt,
      allocationAt + effectiveMaxStreamMs
    )
    if (
      now >= created.value.grantExpiresAt ||
      now >= effectiveAudioDeadlineAt ||
      created.value.limits.maxStreamMs < 100 ||
      created.value.limits.maxInputBytesPerTrack < MAX_CLOUD_FRAME_BYTES ||
      created.value.limits.maxClientFrameBytes < MAX_CLOUD_FRAME_BYTES
    ) {
      await options.client.cancel(created.value.sessionId, 1_000)
      return { ok: false, code: 'SCHEMA' }
    }
    const session = new RelaySpeechSession(
      options.client,
      created.value.sessionId,
      created.value.captureGeneration,
      effectiveMaxStreamMs,
      effectiveAudioDeadlineAt,
      Math.min(created.value.limits.maxInputBytesPerTrack, MAX_INPUT_BYTES),
      Math.min(created.value.limits.maxClientFrameBytes, MAX_CLOUD_FRAME_BYTES),
      Math.min(created.value.limits.maxOutputBytesPerTrack, MAX_OUTPUT_BYTES),
      Math.min(created.value.limits.drainWindowMs, MAX_FINISH_WAIT_MS),
      created.value.routeId,
      created.value.model,
      created.value.language,
      created.value.configVersion,
      created.value.policyVersion,
      [...options.createRequest.tracks],
      options.initialFrontiers,
      options.createRequest.consent.issuedAt,
      options.createRequest.consent.expiresAt,
      isCurrent,
      options.onAllocated,
      options.onTranscript
    )
    for (const grant of created.value.grants) {
      if (!isCurrent() || session.startupFailed) {
        await session.cancel()
        return { ok: false, code: isCurrent() ? 'TRACK_OPEN' : 'CANCELLED' }
      }
      let runtime: TrackRuntime | null = null
      const opened = await options.client.openTrack(
        created.value,
        grant.track,
        (socket) => {
          if (!isCurrent() || session.cancelled || session.startupFailed || session.finishing)
            throw new Error('stale session')
          runtime = session.makeTrackRuntime(grant.track, grant.streamEpoch, socket)
          session.tracks.set(grant.track, runtime)
          session.attachTrack(runtime)
        },
        options.operation
      )
      const activeRuntime = runtime as TrackRuntime | null
      const trackOperationFailure = options.client.operationFailure(options.operation)
      if (!opened.ok || trackOperationFailure) {
        if (opened.ok) opened.value.terminate()
        await session.cancel()
        return {
          ok: false,
          code:
            trackOperationFailure ?? (opened.ok ? 'TIMEOUT' : opened.code === 'WS_CONNECT' ? 'TRACK_OPEN' : opened.code)
        }
      }
      if (
        !activeRuntime ||
        opened.value.readyState !== WebSocket.OPEN ||
        activeRuntime.stopped ||
        session.startupFailed ||
        session.cancelled ||
        session.finishing
      ) {
        opened.value.terminate()
        await session.cancel()
        return { ok: false, code: isCurrent() ? 'TRACK_OPEN' : 'CANCELLED' }
      }
    }
    const finalOperationFailure = options.client.operationFailure(options.operation)
    if (
      !isCurrent() ||
      finalOperationFailure !== null ||
      session.startupFailed ||
      Date.now() >= session.audioDeadlineAt ||
      session.tracks.size !== options.createRequest.tracks.length ||
      [...session.tracks.values()].some((runtime) => runtime.stopped || runtime.socket.readyState !== WebSocket.OPEN)
    ) {
      await session.cancel()
      return {
        ok: false,
        code:
          finalOperationFailure ??
          (isCurrent() ? (Date.now() >= session.audioDeadlineAt ? 'LEASE_DRAINING' : 'TRACK_OPEN') : 'CANCELLED')
      }
    }
    session.startupComplete = true
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
  renew(createRequest: SpeechCreateRequest, operation?: SpeechBrokerOperation): Promise<RelaySessionStartResult> {
    if (this.renewPromise) return this.renewPromise
    if (
      createRequest.operation !== 'create-session' ||
      createRequest.captureGeneration !== this.captureGeneration ||
      createRequest.consent.accepted !== true ||
      createRequest.consent.captureGeneration !== this.captureGeneration ||
      createRequest.tracks.length !== this.tracksOrder.length ||
      createRequest.tracks.some((track, index) => track !== this.tracksOrder[index]) ||
      createRequest.consent.tracks.length !== this.tracksOrder.length ||
      createRequest.consent.tracks.some((track, index) => track !== this.tracksOrder[index]) ||
      (createRequest.language ?? this.language) !== this.language ||
      !Number.isSafeInteger(createRequest.consent.issuedAt) ||
      !Number.isSafeInteger(createRequest.consent.expiresAt) ||
      createRequest.consent.issuedAt <= this.consentIssuedAt ||
      createRequest.consent.expiresAt <= this.consentExpiresAt ||
      createRequest.consent.expiresAt <= createRequest.consent.issuedAt ||
      createRequest.consent.expiresAt - createRequest.consent.issuedAt > 120_000
    )
      return Promise.resolve({ ok: false, code: 'SCHEMA' })
    this.renewPromise = this.renewOnce(createRequest, operation)
    return this.renewPromise
  }

  private async renewOnce(
    createRequest: SpeechCreateRequest,
    operation?: SpeechBrokerOperation
  ): Promise<RelaySessionStartResult> {
    const operationFailure = this.client.operationFailure(operation)
    if (operationFailure) return { ok: false, code: operationFailure }
    const finishBudget = this.client.operationBudgetMs(operation, MAX_FINISH_WAIT_MS)
    const finish = this.finish(finishBudget)
    const previous = await this.waitForOwnerFinish(finish, operation, finishBudget)
    if (!previous) {
      const failure = this.client.operationFailure(operation)
      return {
        ok: false,
        code: failure ?? (operation?.deadlineAt === undefined ? 'CLOSURE_UNCONFIRMED' : 'TIMEOUT')
      }
    }
    if (!previous.complete || this.cancelled)
      return { ok: false, code: this.client.operationFailure(operation) ?? 'CLOSURE_UNCONFIRMED' }
    const initialFrontiers: Partial<Record<SpeechTrack, { sequence: number; sampleOffset?: number }>> = {}
    for (const [track, runtime] of this.tracks) {
      initialFrontiers[track] = {
        sequence: runtime.captureNextSequence,
        ...(runtime.captureNextSampleOffset === null ? {} : { sampleOffset: runtime.captureNextSampleOffset })
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
      expectedCapability: { configVersion: this.configVersion, policyVersion: this.policyVersion },
      initialFrontiers,
      operation,
      isCurrent: this.isCurrent,
      onAllocated: this.onAllocated,
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

  private waitForOwnerFinish(
    finish: Promise<RelaySessionFinish>,
    operation: SpeechBrokerOperation | undefined,
    timeoutMs: number
  ): Promise<RelaySessionFinish | null> {
    const remaining = Math.max(0, Math.min(timeoutMs, this.client.operationBudgetMs(operation, timeoutMs)))
    if (remaining <= 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: RelaySessionFinish | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        operation?.signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => settle(null), remaining)
      const onAbort = (): void => settle(null)
      operation?.signal?.addEventListener('abort', onAbort, { once: true })
      if (operation?.signal?.aborted) {
        settle(null)
        return
      }
      finish.then(settle, () => settle(null))
    })
  }

  pushFrame(
    track: SpeechTrack,
    frame: RelayPcmFrame
  ): { ok: true } | { ok: false; code: RelayQueueFailureCode | 'LEASE_DRAINING' } {
    const runtime = this.tracks.get(track)
    if (!runtime || this.finishing || this.cancelled || runtime.stopped) return { ok: false, code: 'CLOSED' }
    if (!this.isCurrent()) {
      void this.cancel()
      return { ok: false, code: 'CLOSED' }
    }
    if (Date.now() >= this.audioDeadlineAt) return { ok: false, code: 'LEASE_DRAINING' }
    if (
      !Number.isSafeInteger(frame.sequence) ||
      !Number.isSafeInteger(frame.sampleOffset) ||
      frame.sampleOffset < 0 ||
      frame.sequence !== runtime.captureNextSequence ||
      (runtime.captureNextSampleOffset !== null && frame.sampleOffset !== runtime.captureNextSampleOffset)
    )
      return { ok: false, code: 'ORDER' }
    if (
      !(frame.pcm16le instanceof Uint8Array) ||
      frame.pcm16le.byteLength < 2 ||
      frame.pcm16le.byteLength % 2 !== 0 ||
      frame.pcm16le.byteLength > Math.min(MAX_CLOUD_FRAME_BYTES, this.maxClientFrameBytes)
    )
      return { ok: false, code: 'FRAME' }
    const nextCaptureSequence = frame.sequence + 1
    const nextCaptureSampleOffset = frame.sampleOffset + frame.pcm16le.byteLength / 2
    if (!Number.isSafeInteger(nextCaptureSequence) || !Number.isSafeInteger(nextCaptureSampleOffset))
      return { ok: false, code: 'ORDER' }
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
    runtime.captureNextSequence = nextCaptureSequence
    runtime.captureNextSampleOffset = nextCaptureSampleOffset
    runtime.streamNextSequence += 1
    runtime.streamNextSampleOffset += frame.pcm16le.byteLength / 2
    void this.drain(runtime)
    return { ok: true }
  }

  finish(timeoutMs = MAX_FINISH_WAIT_MS): Promise<RelaySessionFinish> {
    if (this.finishPromise) return this.finishPromise
    this.finishing = true
    if (!this.isCurrent()) {
      this.finishPromise = this.cancel().then(() => ({
        complete: false,
        tracks: [...this.tracks.values()].map((runtime) => this.currentClosure(runtime)),
        reason: 'cancelled'
      }))
      return this.finishPromise
    }
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
      captureNextSampleOffset: this.initialFrontiers?.[track]?.sampleOffset ?? null,
      streamNextSequence: 1,
      streamNextSampleOffset: 0,
      terminal: null,
      closure,
      resolveClosure,
      finishPromise: null,
      failureReason: null,
      deliveryFailed: false,
      terminalUnexpected: false,
      stopped: false
    }
  }

  private currentClosure(runtime: TrackRuntime): RelayTrackClosure {
    if (runtime.terminal) {
      const closure = closureFromTerminal(runtime.track, runtime.streamEpoch, runtime.terminal)
      if (
        closure.tail === 'complete' &&
        (runtime.results.hasUnfinalizedSegments || runtime.deliveryFailed || runtime.terminalUnexpected)
      ) {
        closure.tail = 'incomplete'
        closure.reason = 'unknown'
      }
      return closure
    }
    return incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence)
  }

  private attachTrack(runtime: TrackRuntime): void {
    runtime.socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (runtime.stopped) return
      if (isBinary) {
        this.failTrack(runtime, 'unknown')
        return
      }
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
      const accepted = runtime.results.accept(value, Buffer.byteLength(text, 'utf8'))
      if (!accepted.ok) {
        this.failTrack(runtime, 'unknown')
        return
      }
      if (accepted.event.type === 'transcript') {
        if (!this.startupComplete) {
          this.startupFailed = true
          this.failTrack(runtime, 'unknown')
          return
        }
        if (!this.isCurrent()) {
          void this.cancel()
          return
        }
        try {
          this.onTranscript?.(accepted.event, {
            timeBase: 'stream',
            firstCaptureSampleOffset: runtime.firstCaptureSampleOffset ?? 0
          })
        } catch {
          runtime.deliveryFailed = true
          runtime.failureReason = 'unknown'
        }
      } else if (accepted.event.type === 'terminal') {
        if (!this.startupComplete) {
          this.startupFailed = true
          this.failTrack(runtime, 'unknown')
          return
        }
        runtime.terminal = accepted.event
        runtime.terminalUnexpected = !this.finishing || !runtime.queue.isDrained
        runtime.queue.close()
        runtime.stopped = true
        const terminalClosure = closureFromTerminal(runtime.track, runtime.streamEpoch, accepted.event)
        if (
          accepted.event.tail === 'complete' &&
          (runtime.results.hasUnfinalizedSegments || runtime.deliveryFailed || runtime.terminalUnexpected)
        ) {
          terminalClosure.tail = 'incomplete'
          terminalClosure.reason = 'unknown'
        }
        runtime.resolveClosure(terminalClosure)
        try {
          runtime.socket.close()
        } catch {
          /* closure is already confirmed by the relay event */
        }
      } else {
        this.failTrack(runtime, 'upstream-error')
      }
    })
    runtime.socket.once('close', () => {
      if (runtime.terminal || runtime.stopped) return
      if (!this.startupComplete) this.startupFailed = true
      runtime.stopped = true
      runtime.resolveClosure(incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence))
      void this.cancel()
    })
    runtime.socket.once('error', () => {
      if (runtime.terminal) return
      runtime.failureReason = 'unknown'
      this.failTrack(runtime, 'unknown')
    })
  }

  private failTrack(runtime: TrackRuntime, reason: RelayTerminal['reason']): void {
    if (!this.startupComplete) this.startupFailed = true
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
      if (!this.isCurrent()) {
        runtime.failureReason = 'revoked'
        throw new Error('capture owner is stale')
      }
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
    if (runtime.terminal) return this.currentClosure(runtime)
    runtime.queue.seal()
    const draining = runtime.queue.drain((pcm) => {
      if (!this.isCurrent()) {
        runtime.failureReason = 'revoked'
        throw new Error('capture owner is stale')
      }
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
    if (runtime.terminal) return this.currentClosure(runtime)
    if (!drainResult.value.ok || this.cancelled || runtime.stopped || runtime.socket.readyState !== WebSocket.OPEN) {
      const incomplete = incompleteClosure(runtime.track, runtime.streamEpoch, runtime.results.sequence)
      runtime.resolveClosure(incomplete)
      return incomplete
    }
    if (!this.isCurrent()) return this.stopAtDeadline(runtime)
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
      return this.stopAtDeadline(runtime)
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
        const tail =
          runtime.results.hasUnfinalizedSegments || runtime.deliveryFailed || runtime.terminalUnexpected
            ? 'incomplete'
            : (row.tail ?? 'incomplete')
        return {
          track: runtime.track,
          streamEpoch: runtime.streamEpoch,
          closeConfirmed: true,
          tail,
          lastSequence: row.lastSequence,
          reason: tail === 'complete' ? 'normal' : (runtime.failureReason ?? 'unknown')
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
    this.finishIncomplete = true
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
    if (this.cancelled)
      return {
        complete: false,
        tracks: [...this.tracks.values()].map((runtime) => this.currentClosure(runtime)),
        reason: 'cancelled'
      }
    const tracks = await Promise.all([...this.tracks.values()].map((runtime) => this.finishTrack(runtime, deadlineAt)))
    const complete = tracks.length > 0 && tracks.every((track) => track.closeConfirmed && track.tail === 'complete')
    return {
      complete,
      tracks,
      reason: complete ? 'normal' : this.finishIncomplete ? 'incomplete' : this.cancelled ? 'cancelled' : 'incomplete'
    }
  }
}

const BoundedRelayPcmQueueMaxBytes = 64 * 1024
