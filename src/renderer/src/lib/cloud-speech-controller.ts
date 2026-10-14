import {
  CLOUD_SPEECH_MAX_PENDING_AUDIO_MS,
  CLOUD_SPEECH_MAX_PENDING_BYTES,
  CLOUD_SPEECH_MAX_PENDING_FRAMES,
  CloudSpeechCapabilitySchema,
  CloudSpeechCancelResultSchema,
  CloudSpeechEventSchema,
  CloudSpeechFinishResultSchema,
  CloudSpeechFrame,
  CloudSpeechFrameResultSchema,
  CloudSpeechStartRequest,
  CloudSpeechStartRequestSchema,
  CloudSpeechStartResult,
  CloudSpeechStartResultSchema,
  CloudSpeechStatusResultSchema,
  type CloudSpeechCancelResult,
  type CloudSpeechCancelRequest,
  type CloudSpeechCapability,
  type CloudSpeechEvent,
  type CloudSpeechFailure,
  type CloudSpeechFinishResult,
  type CloudSpeechFinishRequest
} from '@shared/cloud-speech'
import type { SpeechStreamRef, Track } from '@shared/contracts/speech'

type CloudSpeechTrack = Track

export interface CloudSpeechControllerBridge {
  cloudSpeechCapability(): Promise<unknown>
  cloudSpeechStart(request: CloudSpeechStartRequest): Promise<unknown>
  cloudSpeechFrame(frame: CloudSpeechFrame): Promise<unknown>
  cloudSpeechFinish(request: CloudSpeechFinishRequest): Promise<unknown>
  cloudSpeechCancel(identity: CloudSpeechCancelRequest): Promise<unknown>
  cloudSpeechStatus(identity: CloudSpeechCancelRequest): Promise<unknown>
  onCloudSpeechEvent(
    captureId: string,
    captureGeneration: number,
    callback: (event: CloudSpeechEvent) => void
  ): () => void
}

export interface CloudSpeechControllerOptions {
  bridge: CloudSpeechControllerBridge
  request: CloudSpeechStartRequest
  applyEvent(event: CloudSpeechEvent): void | Promise<void>
  onFailure(code: CloudSpeechFailure['code']): void
  now?: () => number
  deadlineMs?: number
}

export interface CloudSpeechController {
  start(): Promise<CloudSpeechStartResult>
  attachTrack(track: CloudSpeechTrack, port: MessagePort, originSampleOffset: number): boolean
  stop(): Promise<CloudSpeechFinishResult>
  cancel(): Promise<CloudSpeechCancelResult>
  dispose(): void
}

type WorkletFrame = {
  type: 'pcm-frame'
  sequence: number
  sampleOffset: number
  sampleRate: number
  audio: Float32Array
}

type FlushAck = {
  type: 'flush-ack'
  requestId: string
  finalSequence: number
  finalSampleOffset: number
}

type QueuedFrame = {
  wire: CloudSpeechFrame
  enqueuedAt: number
  audioMs: number
}

type TrackInput = {
  track: CloudSpeechTrack
  port: MessagePort
  listener: (event: MessageEvent) => void
  originSampleOffset: number
  nextSequence: number
  sampleOffset: number
  pendingFrames: number
  pendingBytes: number
  pendingAudioMs: number
  queue: QueuedFrame[]
  pumping: Promise<void> | null
  sealing: boolean
  flushRequestId: string | null
  flush: ReturnType<typeof createDeferred<FlushAck>> | null
  flushed: boolean
}

type RevisionState = { revision: number; final: boolean }

const DEFAULT_DEADLINE_MS = 12_000
const tracksInOrder: readonly CloudSpeechTrack[] = ['microphone', 'system']
const typedArrayPrototype = Object.getPrototypeOf(Float32Array.prototype) as object
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function getFixedFloat32View(
  value: unknown
): { view: Float32Array; buffer: ArrayBuffer; byteOffset: number; byteLength: number; length: number } | null {
  if (
    !ArrayBuffer.isView(value) ||
    !typedArrayBufferGetter ||
    !typedArrayByteOffsetGetter ||
    !typedArrayByteLengthGetter ||
    !typedArrayLengthGetter
  )
    return null
  try {
    const buffer = typedArrayBufferGetter.call(value) as unknown
    if (!(buffer instanceof ArrayBuffer) || !arrayBufferByteLengthGetter) return null
    const bufferLength = arrayBufferByteLengthGetter.call(buffer) as number
    if (arrayBufferResizableGetter?.call(buffer) === true) return null
    const byteOffset = typedArrayByteOffsetGetter.call(value) as number
    const byteLength = typedArrayByteLengthGetter.call(value) as number
    const length = typedArrayLengthGetter.call(value) as number
    if (
      Object.getPrototypeOf(value) !== Float32Array.prototype ||
      !Number.isSafeInteger(bufferLength) ||
      !Number.isSafeInteger(byteOffset) ||
      !Number.isSafeInteger(byteLength) ||
      !Number.isSafeInteger(length) ||
      byteLength !== length * Float32Array.BYTES_PER_ELEMENT ||
      byteOffset + byteLength > bufferLength ||
      length <= 0
    )
      return null
    return { view: value as Float32Array, buffer: buffer as ArrayBuffer, byteOffset, byteLength, length }
  } catch {
    return null
  }
}

function failure(code: CloudSpeechFailure['code'], request?: CloudSpeechStartRequest): CloudSpeechFailure {
  if (
    request &&
    typeof request.captureId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.captureId) &&
    Number.isSafeInteger(request.capture?.generation) &&
    request.capture.generation > 0
  ) {
    return { ok: false, code, captureId: request.captureId, captureGeneration: request.capture.generation }
  }
  return { ok: false, code }
}

function identityMatches(
  value: { captureId: string; captureGeneration: number },
  request: CloudSpeechStartRequest
): boolean {
  return value.captureId === request.captureId && value.captureGeneration === request.capture.generation
}

function streamKey(stream: Pick<SpeechStreamRef, 'track' | 'epoch'>): string {
  return `${stream.track}:${stream.epoch}`
}

export function createCloudSpeechController(options: CloudSpeechControllerOptions): CloudSpeechController {
  const now = options.now ?? (() => performance.now())
  const requestedDeadlineMs = options.deadlineMs
  const deadlineMs =
    Number.isFinite(requestedDeadlineMs) && (requestedDeadlineMs ?? 0) > 0
      ? Math.min(requestedDeadlineMs as number, DEFAULT_DEADLINE_MS)
      : DEFAULT_DEADLINE_MS
  const requestParse = CloudSpeechStartRequestSchema.safeParse(options.request)
  const request = requestParse.success ? requestParse.data : options.request
  const inputs = new Map<CloudSpeechTrack, TrackInput>()
  const streams = new Map<CloudSpeechTrack, number>()
  const revisions = new Map<string, RevisionState>()
  const seenEventSequences = new Map<string, number>()
  const appliedEventSequences = new Map<string, number>()
  const terminalStreams = new Set<string>()
  const applyWaiters = new Set<() => void>()

  let startPromise: Promise<CloudSpeechStartResult> | null = null
  let started: Extract<CloudSpeechStartResult, { ok: true }> | null = null
  let unsubscribeEvents: (() => void) | null = null
  let eventApplyTail = Promise.resolve()
  let stopped = false
  let cancelPromise: Promise<CloudSpeechCancelResult> | null = null
  let stopPromise: Promise<CloudSpeechFinishResult> | null = null
  let stopCompleted = false
  let failureCode: CloudSpeechFailure['code'] | null = null
  let disposed = false

  const reportFailure = (code: CloudSpeechFailure['code']): void => {
    try {
      options.onFailure(code)
    } catch {
      // Failure reporting is observational and must not prevent local teardown.
    }
  }

  const notifyApplied = (): void => {
    for (const wake of [...applyWaiters]) wake()
  }

  const detachInput = (input: TrackInput, close: boolean): void => {
    try {
      input.port.removeEventListener('message', input.listener)
    } catch {
      // Continue cleanup of the exact owned port.
    }
    if (close) {
      try {
        input.port.close()
      } catch {
        // The port may already be detached by its owner.
      }
    }
  }

  const clearUnsent = (): void => {
    for (const input of inputs.values()) {
      input.queue.length = 0
      input.pendingFrames = 0
      input.pendingBytes = 0
      input.pendingAudioMs = 0
      detachInput(input, true)
    }
  }

  const identity = () => ({ captureId: request.captureId, captureGeneration: request.capture.generation })

  const cancelRequestedIdentity = async (deadline: number): Promise<void> => {
    if (deadline - now() <= 0) return
    let pending: Promise<unknown>
    try {
      pending = options.bridge.cloudSpeechCancel(identity())
    } catch {
      return
    }
    await bounded(pending, deadline, undefined)
  }

  const cancelBridgeWithin = async (deadline: number): Promise<CloudSpeechCancelResult> => {
    if (cancelPromise) return cancelPromise
    const call = (async () => {
      if (!started) return failure('CLOSED', request)
      const remaining = Math.max(0, deadline - now())
      if (remaining <= 0) return failure('TIMEOUT', request)
      let pending: Promise<unknown>
      try {
        pending = options.bridge.cloudSpeechCancel(identity())
      } catch {
        return failure('TRANSPORT', request)
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<CloudSpeechFailure>((resolve) => {
        timer = setTimeout(() => resolve(failure('TIMEOUT', request)), remaining)
      })
      try {
        const result = await Promise.race([pending, timeout])
        const parsed = CloudSpeechCancelResultSchema.safeParse(result)
        return parsed.success && (!parsed.data.ok || identityMatches(parsed.data, request))
          ? parsed.data
          : failure('TRANSPORT', request)
      } catch {
        return failure('TRANSPORT', request)
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    cancelPromise = call
    return call
  }

  let activeDeadline: number | null = null
  const invalidate = (code: CloudSpeechFailure['code'], notify = true): void => {
    if (failureCode || disposed) return
    failureCode = code
    stopped = true
    clearUnsent()
    unsubscribeEvents?.()
    unsubscribeEvents = null
    if (notify) reportFailure(code)
    if (started) void cancelBridgeWithin(activeDeadline ?? now() + deadlineMs)
    notifyApplied()
  }

  const validateEvent = (raw: unknown): CloudSpeechEvent | null => {
    const parsed = CloudSpeechEventSchema.safeParse(raw)
    if (!parsed.success || !identityMatches(parsed.data, request) || !started) return null
    const event = parsed.data
    const stream = event.type === 'terminal' ? event.stream : event.segment.stream
    const currentEpoch = streams.get(stream.track)
    if (currentEpoch === undefined || stream.epoch < currentEpoch) return null
    if (stream.epoch > currentEpoch) {
      const priorKey = `${stream.track}:${currentEpoch}`
      if (stream.epoch !== currentEpoch + 1 || !terminalStreams.has(priorKey)) return null
      streams.set(stream.track, stream.epoch)
    }
    if (event.type === 'terminal') {
      const key = streamKey(event.stream)
      if (terminalStreams.has(key) || event.lastSequence !== (seenEventSequences.get(key) ?? 0)) return null
      terminalStreams.add(key)
      return event
    }

    if (!request.capture.capturedTracks.includes(stream.track) || event.segment.engine !== started.engine) return null
    const key = streamKey(stream)
    if (terminalStreams.has(key)) return null
    const previousSequence = seenEventSequences.get(key) ?? 0
    if (event.sequence !== previousSequence + 1) return null
    const revisionKey = `${request.captureId}:${request.capture.generation}:${stream.track}:${stream.epoch}:${event.segment.index}`
    const previousRevision = revisions.get(revisionKey)
    if (
      (previousRevision && previousRevision.final) ||
      (previousRevision && event.segment.revision !== previousRevision.revision + 1) ||
      (!previousRevision && event.segment.revision !== 1)
    )
      return null
    seenEventSequences.set(key, event.sequence)
    revisions.set(revisionKey, { revision: event.segment.revision, final: event.segment.final })
    return event
  }

  const handleEvent = (raw: unknown): void => {
    if (stopped || disposed || failureCode) return
    const event = validateEvent(raw)
    if (!event) {
      invalidate('STALE')
      return
    }
    const stream = event.type === 'segment' ? event.segment.stream : event.stream
    const key = streamKey(stream)
    eventApplyTail = eventApplyTail
      .then(async () => {
        if (stopped || disposed || failureCode) return
        await options.applyEvent(event)
        if (event.type === 'segment') appliedEventSequences.set(key, event.sequence)
        notifyApplied()
      })
      .catch(() => invalidate('TRANSPORT'))
  }

  const ackMatches = (raw: unknown, frame: CloudSpeechFrame): boolean => {
    const parsed = CloudSpeechFrameResultSchema.safeParse(raw)
    if (!parsed.success) {
      invalidate('TRANSPORT')
      return false
    }
    if (!parsed.data.ok) {
      invalidate(parsed.data.code)
      return false
    }
    const byteLength = frame.pcm16le.byteLength
    const ack = parsed.data
    if (
      !identityMatches(ack, request) ||
      ack.track !== frame.track ||
      ack.sequence !== frame.sequence ||
      ack.nextSequence !== frame.sequence + 1 ||
      ack.nextSampleOffset !== frame.sampleOffset + byteLength / 2
    ) {
      invalidate('ORDER')
      return false
    }
    return true
  }

  const releaseReservation = (input: TrackInput, frame: QueuedFrame): void => {
    input.pendingFrames = Math.max(0, input.pendingFrames - 1)
    input.pendingBytes = Math.max(0, input.pendingBytes - frame.wire.pcm16le.byteLength)
    input.pendingAudioMs = Math.max(0, input.pendingAudioMs - frame.audioMs)
  }

  const pumpTrack = async (input: TrackInput): Promise<void> => {
    while (!stopped && !failureCode && input.queue.length > 0) {
      const frame = input.queue.shift()!
      const age = now() - frame.enqueuedAt
      if (!Number.isFinite(age) || age < 0 || age > CLOUD_SPEECH_MAX_PENDING_AUDIO_MS) {
        releaseReservation(input, frame)
        invalidate('QUEUE_STALE')
        return
      }
      try {
        const raw = await options.bridge.cloudSpeechFrame(frame.wire)
        if (!ackMatches(raw, frame.wire)) return
        releaseReservation(input, frame)
      } catch {
        releaseReservation(input, frame)
        invalidate('TRANSPORT')
        return
      }
    }
  }

  const queueFrame = (input: TrackInput, frame: WorkletFrame): void => {
    if (stopped || failureCode || disposed) return
    const view = getFixedFloat32View(frame.audio)
    if (
      !view ||
      input.flushed ||
      (!input.sealing && view.length !== 1_600) ||
      frame.sampleRate !== 16_000 ||
      frame.sequence !== input.nextSequence ||
      frame.sampleOffset !== input.sampleOffset ||
      !Number.isSafeInteger(frame.sequence + 1) ||
      !Number.isSafeInteger(input.sampleOffset + view.length) ||
      !Number.isSafeInteger(input.originSampleOffset + input.sampleOffset + view.length) ||
      (view.length !== 1_600 && (!input.sealing || view.length > 1_599))
    ) {
      invalidate('INVALID_REQUEST')
      return
    }
    for (let index = 0; index < view.length; index += 1) {
      if (!Number.isFinite(view.view[index])) {
        invalidate('INVALID_REQUEST')
        return
      }
    }
    const pcmBytes = view.length * 2
    const audioMs = (view.length / 16_000) * 1_000
    if (
      input.pendingFrames + 1 > CLOUD_SPEECH_MAX_PENDING_FRAMES ||
      input.pendingBytes + pcmBytes > CLOUD_SPEECH_MAX_PENDING_BYTES ||
      input.pendingAudioMs + audioMs > CLOUD_SPEECH_MAX_PENDING_AUDIO_MS
    ) {
      invalidate('QUEUE_LIMIT')
      return
    }

    input.pendingFrames += 1
    input.pendingBytes += pcmBytes
    input.pendingAudioMs += audioMs
    let pcm16le: ArrayBuffer
    try {
      pcm16le = new ArrayBuffer(pcmBytes)
      const data = new DataView(pcm16le)
      for (let index = 0; index < view.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, view.view[index]))
        const pcm = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767)
        data.setInt16(index * 2, pcm, true)
      }
    } catch {
      input.pendingFrames -= 1
      input.pendingBytes -= pcmBytes
      input.pendingAudioMs -= audioMs
      invalidate('TRANSPORT')
      return
    }
    const wire: CloudSpeechFrame = {
      captureId: request.captureId,
      captureGeneration: request.capture.generation,
      track: input.track,
      sequence: frame.sequence,
      sampleOffset: input.originSampleOffset + frame.sampleOffset,
      kind: view.length === 1_600 ? 'full' : 'sealed-final',
      pcm16le
    }
    input.queue.push({ wire, enqueuedAt: now(), audioMs })
    input.nextSequence += 1
    input.sampleOffset += view.length
    startPump(input)
  }

  const startPump = (input: TrackInput): void => {
    if (input.pumping || input.queue.length === 0 || stopped || failureCode) return
    const running = pumpTrack(input)
    input.pumping = running.finally(() => {
      input.pumping = null
      if (input.queue.length > 0 && !stopped && !failureCode) startPump(input)
    })
  }

  const receivePortMessage = (input: TrackInput, raw: unknown): void => {
    if (!isPlainRecord(raw) || typeof raw.type !== 'string') {
      invalidate('INVALID_REQUEST')
      return
    }
    if (raw.type === 'pcm-frame') {
      if (!exactKeys(raw, ['type', 'sequence', 'sampleOffset', 'sampleRate', 'audio'])) {
        invalidate('INVALID_REQUEST')
        return
      }
      if (
        !Number.isSafeInteger(raw.sequence) ||
        !isSafeNonnegativeInteger(raw.sampleOffset) ||
        typeof raw.sampleRate !== 'number' ||
        !Number.isFinite(raw.sampleRate)
      ) {
        invalidate('INVALID_REQUEST')
        return
      }
      queueFrame(input, raw as unknown as WorkletFrame)
      return
    }
    if (raw.type === 'flush-ack') {
      if (
        !input.sealing ||
        input.flushed ||
        !input.flush ||
        !exactKeys(raw, ['type', 'requestId', 'finalSequence', 'finalSampleOffset']) ||
        raw.requestId !== input.flushRequestId ||
        !isSafeNonnegativeInteger(raw.finalSequence) ||
        !isSafeNonnegativeInteger(raw.finalSampleOffset) ||
        raw.finalSequence !== input.nextSequence - 1 ||
        raw.finalSampleOffset !== input.sampleOffset
      ) {
        invalidate('ORDER')
        return
      }
      input.flushed = true
      input.flush.resolve(raw as unknown as FlushAck)
      return
    }
    invalidate('INVALID_REQUEST')
  }

  const parseFinishResult = (raw: unknown): CloudSpeechFinishResult => {
    const parsed = CloudSpeechFinishResultSchema.safeParse(raw)
    if (!parsed.success || (parsed.data.ok && !identityMatches(parsed.data, request)))
      return failure('TRANSPORT', request)
    return parsed.data
  }

  const waitForAppliedFrontiers = async (
    result: Extract<CloudSpeechFinishResult, { ok: true }>,
    deadline: number
  ): Promise<boolean> => {
    const complete = (): boolean =>
      result.tracks.every((trackResult) => {
        const key = streamKey(trackResult.stream)
        return (appliedEventSequences.get(key) ?? 0) >= trackResult.lastSequence
      })
    while (!complete()) {
      const remaining = deadline - now()
      if (remaining <= 0) return false
      const waiter = createDeferred<void>()
      const wake = () => waiter.resolve()
      applyWaiters.add(wake)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining)
      })
      await Promise.race([waiter.promise, timeout])
      applyWaiters.delete(wake)
      if (timer) clearTimeout(timer)
      if (failureCode || disposed) return false
    }
    return true
  }

  const bounded = async <T>(operation: Promise<T>, deadline: number, timeoutValue: T): Promise<T> => {
    const remaining = deadline - now()
    if (remaining <= 0) return timeoutValue
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(timeoutValue), remaining)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const boundedCall = async <T>(operation: () => Promise<T>, deadline: number, timeoutValue: T): Promise<T> => {
    if (deadline - now() <= 0) return timeoutValue
    return bounded(operation(), deadline, timeoutValue)
  }

  const recoverClosedButIncomplete = async (deadline: number): Promise<CloudSpeechFinishResult | null> => {
    let raw: unknown
    try {
      raw = await boundedCall(() => options.bridge.cloudSpeechStatus(identity()), deadline, null)
    } catch {
      return null
    }
    const parsed = CloudSpeechStatusResultSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.ok || !identityMatches(parsed.data, request) || parsed.data.state !== 'closed')
      return null
    const tracks = new Set(parsed.data.tracks.map((trackResult) => trackResult.stream.track))
    if (
      parsed.data.tracks.length !== request.capture.capturedTracks.length ||
      tracks.size !== parsed.data.tracks.length ||
      request.capture.capturedTracks.some((track) => !tracks.has(track)) ||
      parsed.data.tracks.some(
        (trackResult) =>
          !request.capture.capturedTracks.includes(trackResult.stream.track) ||
          streams.get(trackResult.stream.track) !== trackResult.stream.epoch
      )
    )
      return null
    const recovered = CloudSpeechFinishResultSchema.safeParse({
      ok: true,
      captureId: request.captureId,
      captureGeneration: request.capture.generation,
      complete: false,
      tracks: parsed.data.tracks,
      reason: 'incomplete'
    })
    if (!recovered.success || !recovered.data.ok) return null
    stopped = true
    stopCompleted = true
    unsubscribeEvents?.()
    unsubscribeEvents = null
    for (const input of inputs.values()) detachInput(input, true)
    return recovered.data
  }

  const start = (): Promise<CloudSpeechStartResult> => {
    if (startPromise) return startPromise
    startPromise = (async () => {
      if (disposed || stopped) return failure(failureCode ?? 'CLOSED', request)
      if (!requestParse.success) {
        reportFailure('INVALID_REQUEST')
        return failure('INVALID_REQUEST', request)
      }
      let startAttempted = false
      try {
        const capabilityResult = await options.bridge.cloudSpeechCapability()
        if (disposed || stopped || failureCode) return failure(failureCode ?? 'CLOSED', request)
        const parsedCapability = CloudSpeechCapabilitySchema.safeParse(capabilityResult)
        if (!parsedCapability.success) return failure('TRANSPORT', request)
        const capability = parsedCapability.data as CloudSpeechCapability
        const selected = capability.selected
        if (
          !capability.ready ||
          !selected ||
          selected.engine !== request.capture.engine ||
          !capability.allowed.some(
            (route) =>
              route.engine === selected.engine &&
              route.routeId === selected.routeId &&
              route.modelId === selected.modelId
          )
        ) {
          const rejected = failure(capability.refusal ?? 'NOT_READY', request)
          reportFailure(rejected.code)
          return rejected
        }
        startAttempted = true
        const raw = await options.bridge.cloudSpeechStart(request)
        const parsed = CloudSpeechStartResultSchema.safeParse(raw)
        if (!parsed.success) {
          await cancelRequestedIdentity(now() + deadlineMs)
          reportFailure('TRANSPORT')
          return failure('TRANSPORT', request)
        }
        const result = parsed.data
        if (!result.ok) {
          reportFailure(result.code)
          return result
        }
        if (disposed || stopped || failureCode) {
          await cancelRequestedIdentity(now() + deadlineMs)
          return failure(failureCode ?? 'CLOSED', request)
        }
        if (
          !identityMatches(result, request) ||
          result.engine !== selected.engine ||
          result.streams.length !== request.capture.capturedTracks.length ||
          result.streams.some((stream) => !request.capture.capturedTracks.includes(stream.track))
        ) {
          await cancelRequestedIdentity(now() + deadlineMs)
          reportFailure('STALE')
          return failure('STALE', request)
        }
        started = result
        for (const stream of result.streams) streams.set(stream.track, stream.streamEpoch)
        unsubscribeEvents = options.bridge.onCloudSpeechEvent(
          request.captureId,
          request.capture.generation,
          handleEvent
        )
        return result
      } catch {
        if (started) {
          invalidate('TRANSPORT')
          return failure('TRANSPORT', request)
        }
        if (startAttempted) await cancelRequestedIdentity(now() + deadlineMs)
        if (disposed || failureCode === 'CLOSED') return failure(failureCode ?? 'CLOSED', request)
        reportFailure('TRANSPORT')
        return failure('TRANSPORT', request)
      }
    })()
    return startPromise
  }

  const attachTrack = (track: CloudSpeechTrack, port: MessagePort, originSampleOffset: number): boolean => {
    if (
      !started ||
      stopped ||
      disposed ||
      !request.capture.capturedTracks.includes(track) ||
      !streams.has(track) ||
      inputs.has(track) ||
      !isSafeNonnegativeInteger(originSampleOffset)
    ) {
      return false
    }
    const input = {} as TrackInput
    input.track = track
    input.port = port
    input.originSampleOffset = originSampleOffset
    input.nextSequence = 1
    input.sampleOffset = 0
    input.pendingFrames = 0
    input.pendingBytes = 0
    input.pendingAudioMs = 0
    input.queue = []
    input.pumping = null
    input.sealing = false
    input.flushRequestId = null
    input.flush = null
    input.flushed = false
    input.listener = (event) => receivePortMessage(input, event.data)
    inputs.set(track, input)
    try {
      port.addEventListener('message', input.listener)
      port.start()
      return true
    } catch {
      inputs.delete(track)
      invalidate('TRANSPORT')
      return false
    }
  }

  const stop = (): Promise<CloudSpeechFinishResult> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      const deadline = now() + deadlineMs
      if (!started || stopped || disposed || failureCode) return failure(failureCode ?? 'CLOSED', request)
      if (inputs.size !== request.capture.capturedTracks.length) {
        invalidate('CLOSED')
        return failure('CLOSED', request)
      }
      activeDeadline = deadline
      const flushes: Array<Promise<FlushAck>> = []
      for (const track of tracksInOrder) {
        const input = inputs.get(track)
        if (!input) continue
        input.sealing = true
        input.flushRequestId = globalThis.crypto?.randomUUID?.() ?? ''
        if (!input.flushRequestId) {
          invalidate('TRANSPORT')
          return failure('TRANSPORT', request)
        }
        input.flush = createDeferred<FlushAck>()
        flushes.push(input.flush.promise)
        try {
          input.port.postMessage({ type: 'seal-and-flush', requestId: input.flushRequestId })
        } catch {
          invalidate('TRANSPORT')
          return failure('TRANSPORT', request)
        }
      }

      const flushResult = await bounded(Promise.all(flushes), deadline, null)
      if (failureCode) return failure(failureCode, request)
      if (flushResult === null) {
        invalidate('TIMEOUT')
        return failure('TIMEOUT', request)
      }
      const drained = await bounded(
        Promise.all([...inputs.values()].map((input) => input.pumping ?? Promise.resolve())),
        deadline,
        null
      )
      if (drained === null) {
        invalidate('TIMEOUT')
        return failure('TIMEOUT', request)
      }
      if (disposed || stopped) return failure(failureCode ?? 'CLOSED', request)
      if (failureCode) return failure(failureCode, request)

      const tracks = tracksInOrder.flatMap((track) => {
        const input = inputs.get(track)
        return input
          ? [
              {
                track,
                finalSequence: input.nextSequence - 1,
                finalSampleOffset: input.nextSequence === 1 ? 0 : input.originSampleOffset + input.sampleOffset
              }
            ]
          : []
      })
      const finishRequest: CloudSpeechFinishRequest = {
        captureId: request.captureId,
        captureGeneration: request.capture.generation,
        tracks
      }
      let finishResult: CloudSpeechFinishResult
      try {
        const raw = await boundedCall(
          () => options.bridge.cloudSpeechFinish(finishRequest),
          deadline,
          failure('TIMEOUT', request)
        )
        finishResult = parseFinishResult(raw)
      } catch {
        finishResult = failure('TRANSPORT', request)
      }
      if (!finishResult.ok) {
        if (
          finishResult.code === 'TIMEOUT' ||
          finishResult.code === 'TRANSPORT' ||
          finishResult.code === 'CLOSURE_UNCONFIRMED'
        ) {
          const recovered = await recoverClosedButIncomplete(deadline)
          if (recovered) return recovered
        }
        invalidate(finishResult.code)
        return finishResult
      }
      if (disposed || stopped || failureCode) return failure(failureCode ?? 'CLOSED', request)
      if (
        finishResult.tracks.length !== tracks.length ||
        finishResult.tracks.some((trackResult) => {
          const expected = streams.get(trackResult.stream.track)
          return (
            expected !== trackResult.stream.epoch ||
            !inputs.has(trackResult.stream.track) ||
            (seenEventSequences.get(streamKey(trackResult.stream)) ?? 0) > trackResult.lastSequence
          )
        })
      ) {
        invalidate('STALE')
        return failure('STALE', request)
      }
      if (finishResult.complete && [...revisions.values()].some((revision) => !revision.final)) {
        finishResult = { ...finishResult, complete: false, reason: 'incomplete' }
      }
      if (now() >= deadline || !(await waitForAppliedFrontiers(finishResult, deadline))) {
        invalidate('TIMEOUT')
        return failure('TIMEOUT', request)
      }
      stopped = true
      stopCompleted = true
      unsubscribeEvents?.()
      unsubscribeEvents = null
      for (const input of inputs.values()) detachInput(input, true)
      if (finishResult.complete) return finishResult
      return finishResult
    })().catch(() => {
      invalidate('TRANSPORT')
      return failure('TRANSPORT', request)
    })
    return stopPromise
  }

  const cancel = (): Promise<CloudSpeechCancelResult> => {
    if (cancelPromise) return cancelPromise
    if (stopped && stopPromise && !failureCode) return Promise.resolve(failure('CLOSED', request))
    const deadline = now() + deadlineMs
    stopped = true
    failureCode = failureCode ?? 'CLOSED'
    clearUnsent()
    unsubscribeEvents?.()
    unsubscribeEvents = null
    notifyApplied()
    if (!started) {
      cancelPromise = Promise.resolve(failure('CLOSED', request))
      return cancelPromise
    }
    cancelPromise = bounded(cancelBridgeWithin(deadline), deadline, failure('TIMEOUT', request))
      .then((result) => result)
      .catch(() => failure('TRANSPORT', request))
    return cancelPromise
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopped = true
    clearUnsent()
    unsubscribeEvents?.()
    unsubscribeEvents = null
    notifyApplied()
    if (started && !stopCompleted && !cancelPromise) void cancelBridgeWithin(activeDeadline ?? now() + deadlineMs)
  }

  return { start, attachTrack, stop, cancel, dispose }
}
