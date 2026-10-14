import {
  CLOUD_SPEECH_MAX_PENDING_AUDIO_MS,
  CLOUD_SPEECH_MAX_PENDING_BYTES,
  CLOUD_SPEECH_MAX_PENDING_FRAMES,
  CloudSpeechCancelResultSchema,
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
  type CloudSpeechEvent,
  type CloudSpeechFailure,
  type CloudSpeechFinishResult,
  type CloudSpeechFinishRequest
} from '@shared/cloud-speech'
import type { Track } from '@shared/contracts/speech'
import {
  convertFloat32ToPcm16le,
  getFixedFloat32View,
  isSafeNonnegativeInteger,
  parseWorkletPortMessage,
  type FlushAck,
  type WorkletFrame
} from './cloud-speech-audio'
import {
  cloudSpeechFailure as failure,
  cloudSpeechIdentityMatches as identityMatches,
  createCloudSpeechResultTracker,
  MAX_PENDING_RESULT_APPLICATIONS
} from './cloud-speech-results'
import { createCloudSpeechStartupSubscription, selectCloudSpeechStartRoute } from './cloud-speech-startup'

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
  attachTrack(track: Track, port: MessagePort, originSampleOffset: number): boolean
  stop(): Promise<CloudSpeechFinishResult>
  cancel(): Promise<CloudSpeechCancelResult>
  dispose(): void
}

type QueuedFrame = {
  wire: CloudSpeechFrame
  enqueuedAt: number
  audioMs: number
}

type TrackInput = {
  track: Track
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
  sealedFinalAdmitted: boolean
  flushRequestId: string | null
  flush: ReturnType<typeof createDeferred<FlushAck>> | null
  flushed: boolean
}

const DEFAULT_DEADLINE_MS = 12_000
const tracksInOrder: readonly Track[] = ['microphone', 'system']
function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
  const inputs = new Map<Track, TrackInput>()
  const resultTracker = createCloudSpeechResultTracker(request)
  const applyWaiters = new Set<() => void>()

  let startPromise: Promise<CloudSpeechStartResult> | null = null
  let started: Extract<CloudSpeechStartResult, { ok: true }> | null = null
  let startupSubscription: ReturnType<typeof createCloudSpeechStartupSubscription> | null = null
  let eventApplyTail = Promise.resolve()
  let pendingEventApplications = 0
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

  const discardStartupSubscription = (): void => {
    startupSubscription?.close()
    startupSubscription = null
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
    try {
      const pending = options.bridge.cloudSpeechCancel(identity())
      await bounded(pending, deadline, undefined)
    } catch {
      // Cleanup is best effort; never replace the original start failure.
    }
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
    discardStartupSubscription()
    clearUnsent()
    if (notify) reportFailure(code)
    if (started) void cancelBridgeWithin(activeDeadline ?? now() + deadlineMs)
    notifyApplied()
  }

  const validateEvent = (raw: unknown): CloudSpeechEvent | null => {
    return started ? resultTracker.validate(raw, started.engine) : null
  }

  const handleEvent = (raw: unknown): void => {
    if (stopped || disposed || failureCode) return
    if (!started) return
    if (pendingEventApplications >= MAX_PENDING_RESULT_APPLICATIONS) {
      invalidate('QUEUE_LIMIT')
      return
    }
    const event = validateEvent(raw)
    if (!event) {
      invalidate('STALE')
      return
    }
    const stream = event.type === 'segment' ? event.segment.stream : event.stream
    pendingEventApplications += 1
    eventApplyTail = eventApplyTail
      .then(async () => {
        if (stopped || disposed || failureCode) return
        await options.applyEvent(event)
        if (event.type === 'segment') resultTracker.markApplied(stream, event.sequence)
        notifyApplied()
      })
      .catch(() => invalidate('TRANSPORT'))
      .finally(() => {
        pendingEventApplications -= 1
        notifyApplied()
      })
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
    if (input.sealedFinalAdmitted) {
      invalidate('ORDER')
      return
    }
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
      pcm16le = convertFloat32ToPcm16le(view.view, view.length)
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
    if (view.length !== 1_600) input.sealedFinalAdmitted = true
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
    const message = parseWorkletPortMessage(raw)
    if (message.kind === 'frame') {
      queueFrame(input, message.frame)
      return
    }
    if (message.kind === 'flush') {
      const { ack } = message
      if (
        !input.sealing ||
        input.flushed ||
        !input.flush ||
        !ack ||
        ack.requestId !== input.flushRequestId ||
        ack.finalSequence !== input.nextSequence - 1 ||
        ack.finalSampleOffset !== input.sampleOffset
      ) {
        invalidate('ORDER')
        return
      }
      input.flushed = true
      input.flush.resolve(ack)
      return
    }
    invalidate(message.kind === 'order' ? 'ORDER' : 'INVALID_REQUEST')
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
    const complete = (): boolean => resultTracker.appliedThrough(result)
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
          resultTracker.currentEpoch(trackResult.stream.track) !== trackResult.stream.epoch
      )
    )
      return null
    const recovered = CloudSpeechFinishResultSchema.safeParse({
      ok: true,
      captureId: request.captureId,
      captureGeneration: request.capture.generation,
      complete: false,
      tracks: parsed.data.tracks.map((track) => ({
        stream: track.stream,
        lastSequence: track.lastSequence,
        closeConfirmed: track.closeConfirmed,
        tail: 'incomplete' as const,
        reason: 'unknown' as const
      })),
      reason: 'incomplete'
    })
    if (!recovered.success || !recovered.data.ok) return null
    stopped = true
    stopCompleted = true
    discardStartupSubscription()
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
        const route = selectCloudSpeechStartRoute(capabilityResult, request.capture.engine)
        if (!route.ok) {
          if (route.report) reportFailure(route.code)
          return failure(route.code, request)
        }
        const selected = route.selected
        startupSubscription = createCloudSpeechStartupSubscription(
          (callback) => options.bridge.onCloudSpeechEvent(request.captureId, request.capture.generation, callback),
          identity(),
          handleEvent,
          invalidate
        )
        if (disposed || stopped || failureCode) {
          discardStartupSubscription()
          return failure(failureCode ?? 'CLOSED', request)
        }
        startAttempted = true
        const raw = await options.bridge.cloudSpeechStart(request)
        const parsed = CloudSpeechStartResultSchema.safeParse(raw)
        if (!parsed.success) {
          discardStartupSubscription()
          await cancelRequestedIdentity(now() + deadlineMs)
          reportFailure('TRANSPORT')
          return failure('TRANSPORT', request)
        }
        const result = parsed.data
        if (disposed || stopped || failureCode) {
          discardStartupSubscription()
          if (result.ok) await cancelRequestedIdentity(now() + deadlineMs)
          return failure(failureCode ?? 'CLOSED', request)
        }
        if (!result.ok) {
          discardStartupSubscription()
          reportFailure(result.code)
          return result
        }
        if (
          !identityMatches(result, request) ||
          result.engine !== selected.engine ||
          result.streams.length !== request.capture.capturedTracks.length ||
          result.streams.some((stream) => !request.capture.capturedTracks.includes(stream.track))
        ) {
          discardStartupSubscription()
          await cancelRequestedIdentity(now() + deadlineMs)
          reportFailure('STALE')
          return failure('STALE', request)
        }
        started = result
        resultTracker.initialize(result)
        startupSubscription?.activate()
        if (disposed || stopped || failureCode) return failure(failureCode ?? 'CLOSED', request)
        return result
      } catch {
        discardStartupSubscription()
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

  const attachTrack = (track: Track, port: MessagePort, originSampleOffset: number): boolean => {
    if (
      !started ||
      stopped ||
      disposed ||
      !request.capture.capturedTracks.includes(track) ||
      resultTracker.currentEpoch(track) === undefined ||
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
    input.sealedFinalAdmitted = false
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
      detachInput(input, true)
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
          const expected = resultTracker.currentEpoch(trackResult.stream.track)
          return (
            expected !== trackResult.stream.epoch ||
            !inputs.has(trackResult.stream.track) ||
            resultTracker.seenSequence(trackResult.stream) > trackResult.lastSequence
          )
        })
      ) {
        invalidate('STALE')
        return failure('STALE', request)
      }
      if (!resultTracker.prepareFinish(finishResult)) {
        finishResult = { ...finishResult, complete: false, reason: 'incomplete' }
      }
      if (now() >= deadline || !(await waitForAppliedFrontiers(finishResult, deadline))) {
        invalidate('TIMEOUT')
        return failure('TIMEOUT', request)
      }
      while (!failureCode) {
        const currentCallbacks = eventApplyTail
        const appliedCallbacks = await bounded(currentCallbacks, deadline, null)
        if (appliedCallbacks === null) {
          invalidate('TIMEOUT')
          return failure('TIMEOUT', request)
        }
        if (currentCallbacks === eventApplyTail) break
      }
      if (failureCode) return failure(failureCode, request)
      if (disposed || stopped) return failure(failureCode ?? 'CLOSED', request)
      if (finishResult.complete && resultTracker.hasUnfinalizedRevisions()) {
        finishResult = { ...finishResult, complete: false, reason: 'incomplete' }
      }
      stopped = true
      stopCompleted = true
      discardStartupSubscription()
      for (const input of inputs.values()) detachInput(input, true)
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
    discardStartupSubscription()
    failureCode = failureCode ?? 'CLOSED'
    clearUnsent()
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
    discardStartupSubscription()
    clearUnsent()
    notifyApplied()
    if (started && !stopCompleted && !cancelPromise) void cancelBridgeWithin(activeDeadline ?? now() + deadlineMs)
  }

  return { start, attachTrack, stop, cancel, dispose }
}
