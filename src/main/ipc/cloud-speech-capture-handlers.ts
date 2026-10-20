import { CLOUD_SPEECH_CAPTURE_MAX_SAMPLES, CLOUD_SPEECH_HANDOFF_MAX_MS } from '../cloud-stt/capture-session'
import {
  CloudSpeechCaptureCeilingAckResultSchema,
  CloudSpeechCaptureCeilingAckSchema,
  CloudSpeechEpochTransitionAckResultSchema,
  CloudSpeechEpochTransitionAckSchema,
  CloudSpeechFinishRequestSchema,
  CloudSpeechFinishResultSchema,
  CloudSpeechFrameResultSchema,
  CloudSpeechFrameSchema,
  CloudSpeechLanguageRequestSchema,
  CloudSpeechLanguageResultSchema
} from '../../shared/cloud-speech'
import {
  failure,
  getBinding,
  identityOf,
  mapClosureReason,
  sameBinding,
  type LanguageChangeOutcome,
  type Owner,
  type SpeechIpcEvent
} from './cloud-speech-ipc-support'
import type { CaptureHandlersContext, CaptureIpcHandlers } from './cloud-speech-ipc-context'

export function createCaptureHandlers(context: CaptureHandlersContext): CaptureIpcHandlers {
  const { state, now, monotonicNow, ownerFor, currentAuthority, retire, clearCurrentIf, releaseCaptureOwner } = context
  const lifecycle = context.lifecycle
  const frame = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, context.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechFrameSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const frame = parsed.data
    const owner = ownerFor({ captureId: frame.captureId, captureGeneration: frame.captureGeneration })
    const identity = { captureId: frame.captureId, captureGeneration: frame.captureGeneration }
    if (
      !owner ||
      state.current !== owner ||
      (owner.phase !== 'active' && owner.phase !== 'rotating') ||
      owner.finishAfterRotation !== null ||
      owner.ceilingAcked ||
      owner.binding.sender !== binding.sender ||
      owner.binding.frame !== binding.frame
    )
      return failure('STALE')
    if (!state.acceptingInput || !currentAuthority(owner, true)) {
      void retire(owner)
      return failure('CLOSED', identity)
    }
    if (!owner.tracks.includes(frame.track)) return failure('INVALID_REQUEST', identity)
    if (
      owner.ceilingRequested &&
      (owner.ceilingFrameDeadlineAt === null || monotonicNow() > owner.ceilingFrameDeadlineAt)
    ) {
      void retire(owner)
      return failure('TIMEOUT', identity)
    }
    if (owner.sealedTracks.has(frame.track)) return failure('ORDER', identity)
    const frontier = owner.frontier.get(frame.track)
    if (
      !frontier ||
      frame.sequence !== frontier.nextSequence ||
      (frontier.nextSampleOffset !== null && frame.sampleOffset !== frontier.nextSampleOffset)
    )
      return failure('ORDER', identity)
    const nextSequence = frame.sequence + 1
    const nextSampleOffset = frame.sampleOffset + frame.pcm16le.byteLength / 2
    if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextSampleOffset))
      return failure('ORDER', identity)
    if (nextSampleOffset > CLOUD_SPEECH_CAPTURE_MAX_SAMPLES) {
      if (owner.phase === 'active') lifecycle.startCaptureCeiling(owner)
      return failure('ORDER', identity)
    }
    const pcm16le = new Uint8Array(frame.pcm16le.byteLength)
    pcm16le.set(new Uint8Array(frame.pcm16le))
    const activeSession = owner.session
    if (owner.phase === 'active' && activeSession) {
      const cutoffAt =
        activeSession.identity.audioDeadlineAt - Math.min(activeSession.identity.limits.drainWindowMs, 5_000)
      if (now() >= cutoffAt) void lifecycle.rotate(owner)
    }
    if (owner.phase !== 'rotating' && owner.phase !== 'active') return failure('TIMEOUT', identity)
    if (owner.phase === 'rotating') {
      if (!owner.preflightBinding || !owner.captureSession) {
        lifecycle.failRotation(owner)
        return failure('TIMEOUT', identity)
      }
      const deadlineAt = monotonicNow() + CLOUD_SPEECH_HANDOFF_MAX_MS
      owner.rotationDeadlineAt =
        owner.rotationDeadlineAt === null ? deadlineAt : Math.min(owner.rotationDeadlineAt, deadlineAt)
      return await new Promise<unknown>((resolve) => {
        const reserved = owner.captureSession!.reserveFrame(
          frame.track,
          frame,
          deadlineAt,
          resolve,
          failure('TIMEOUT', identity),
          () => lifecycle.failRotation(owner)
        )
        if (!reserved) {
          resolve(failure('QUEUE_LIMIT', identity))
          lifecycle.failRotation(owner)
        }
      })
    }
    const admitted = activeSession?.pushFrame(frame.track, {
      sequence: frame.sequence,
      sampleOffset: frame.sampleOffset,
      pcm16le
    })
    if (!admitted?.ok)
      return failure(
        admitted?.code === 'QUEUE_LIMIT'
          ? 'QUEUE_LIMIT'
          : admitted?.code === 'QUEUE_STALE'
            ? 'QUEUE_STALE'
            : 'TRANSPORT',
        identity
      )
    owner.frontier.set(frame.track, { nextSequence, nextSampleOffset })
    if (frame.kind === 'sealed-final') owner.sealedTracks.add(frame.track)
    if (nextSampleOffset === CLOUD_SPEECH_CAPTURE_MAX_SAMPLES) lifecycle.startCaptureCeiling(owner)
    const response = {
      ok: true as const,
      ...identity,
      track: frame.track,
      sequence: frame.sequence,
      nextSequence,
      nextSampleOffset
    }
    const parsedResponse = CloudSpeechFrameResultSchema.safeParse(response)
    return parsedResponse.success ? parsedResponse.data : failure('TRANSPORT', identity)
  }
  const transitionAck = (event: SpeechIpcEvent, raw: unknown): unknown => {
    const binding = getBinding(event, context.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechEpochTransitionAckSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const ack = parsed.data
    const owner = ownerFor(ack)
    if (
      !owner ||
      state.current !== owner ||
      owner.binding.sender !== binding.sender ||
      owner.binding.frame !== binding.frame
    )
      return failure('STALE')
    if (!currentAuthority(owner, false)) {
      void retire(owner)
      return failure('POLICY', ack)
    }
    if (!owner.captureSession?.acknowledge(ack)) return failure('ORDER', ack)
    const response = {
      ok: true as const,
      captureId: ack.captureId,
      captureGeneration: ack.captureGeneration,
      transitionId: ack.transitionId,
      handoffNonce: ack.handoffNonce,
      stage: ack.stage
    }
    return CloudSpeechEpochTransitionAckResultSchema.safeParse(response).success ? response : failure('TRANSPORT', ack)
  }
  const finishCapture = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, context.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechFinishRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data
    const owner = ownerFor(request)
    const identity = { captureId: request.captureId, captureGeneration: request.captureGeneration }
    if (!owner || owner.binding.sender !== binding.sender || owner.binding.frame !== binding.frame)
      return failure('STALE')
    if (owner.phase === 'rotating') {
      const frontierMatches =
        request.tracks.length === owner.tracks.length &&
        owner.tracks.every((track, index) => {
          const requested = request.tracks[index]
          const frontier = owner.frontier.get(track)
          return (
            requested?.track === track &&
            frontier !== undefined &&
            requested.finalSequence === frontier.nextSequence - 1 &&
            requested.finalSampleOffset === (frontier.nextSampleOffset ?? 0)
          )
        })
      if (!frontierMatches || owner.finishAfterRotation || !owner.rotationPromise) {
        lifecycle.failRotation(owner)
        return failure('ORDER', identity)
      }
      owner.finishAfterRotation = request
      await owner.rotationPromise
      if (state.current !== owner || (owner.phase as Owner['phase']) !== 'active') return failure('TRANSPORT', identity)
      owner.finishAfterRotation = null
      return finishCapture(event, request)
    }
    if (owner.phase === 'starting') return failure('CLOSED', identity)
    const checkpoint = JSON.stringify(request.tracks)
    if (owner.finishPromise) {
      if (owner.finishCheckpoint !== checkpoint) return failure('ORDER', identity)
      return currentAuthority(owner, false) ? owner.finishPromise : failure('POLICY', identity)
    }
    if (state.current !== owner) return failure('STALE', identity)
    if (owner.phase !== 'active' || !currentAuthority(owner, false)) {
      void retire(owner)
      return failure('CLOSED', identity)
    }
    if (
      request.tracks.length !== owner.tracks.length ||
      owner.tracks.some((track, index) => {
        const checkpoint = request.tracks.find((item) => item.track === track)
        const frontier = owner.frontier.get(track)
        return (
          !checkpoint ||
          !frontier ||
          checkpoint.finalSequence !== frontier.nextSequence - 1 ||
          checkpoint.finalSampleOffset !== (frontier.nextSampleOffset ?? 0) ||
          request.tracks[index]?.track !== track
        )
      })
    )
      return failure('ORDER', identity)
    owner.cancelCeilingSchedule?.()
    owner.cancelCeilingSchedule = null
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = null
    owner.phase = 'finishing'
    owner.finishCheckpoint = checkpoint
    const session = owner.session
    if (!session) return failure('CLOSED', identity)
    owner.finishPromise = (async () => {
      const result = await session
        .finish(5_000)
        .catch(() => ({ complete: false, tracks: [], reason: 'incomplete' as const }))
      if (state.current !== owner || !sameBinding(owner.binding)) return failure('STALE', identity)
      if (!currentAuthority(owner, false)) {
        void retire(owner)
        return failure('POLICY', identity)
      }
      const expectedTracks = owner.session?.identity.tracks ?? []
      if (
        result.tracks.length !== owner.tracks.length ||
        owner.tracks.some((track) => {
          const resultTrack = result.tracks.find((candidate) => candidate.track === track)
          const expected = expectedTracks.find((candidate) => candidate.track === track)
          const eventSequence = resultTrack ? (owner.eventFrontier.get(`${track}:${resultTrack.streamEpoch}`) ?? 0) : -1
          return (
            !resultTrack ||
            !expected ||
            resultTrack.streamEpoch !== expected.streamEpoch ||
            resultTrack.lastSequence !== eventSequence
          )
        })
      ) {
        owner.phase = 'closed'
        owner.closureConfirmed = false
        clearCurrentIf(owner)
        return failure('TRANSPORT', identity)
      }
      lifecycle.setTerminal(owner, result.tracks)
      owner.phase = 'closed'
      owner.closureConfirmed =
        result.tracks.length === owner.tracks.length && result.tracks.every((track) => track.closeConfirmed)
      if (owner.closureConfirmed) releaseCaptureOwner(owner)
      clearCurrentIf(owner)
      const response = {
        ok: true,
        ...identity,
        complete: result.complete,
        tracks: result.tracks.map((track) => ({
          stream: { generation: owner.generation, track: track.track, epoch: track.streamEpoch },
          lastSequence: track.lastSequence,
          closeConfirmed: track.closeConfirmed,
          tail: track.tail,
          reason: mapClosureReason(track.reason)
        })),
        reason: result.reason
      }
      const parsedResponse = CloudSpeechFinishResultSchema.safeParse(response)
      return parsedResponse.success ? parsedResponse.data : failure('TRANSPORT', identity)
    })()
    return owner.finishPromise
  }
  const ceilingAck = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, context.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechCaptureCeilingAckSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const ack = parsed.data
    const owner = ownerFor(ack)
    const identity = { captureId: ack.captureId, captureGeneration: ack.captureGeneration }
    if (
      owner &&
      owner.binding.sender === binding.sender &&
      owner.binding.frame === binding.frame &&
      owner.ceilingAcked &&
      owner.captureSession?.acknowledgeCeiling(ack)
    ) {
      const finished = await owner.finishPromise
      if (finished && typeof finished === 'object' && 'complete' in finished && finished.complete === true) {
        const response = {
          ok: true as const,
          captureId: ack.captureId,
          captureGeneration: ack.captureGeneration,
          ceilingId: ack.ceilingId,
          tracks: ack.tracks
        }
        return CloudSpeechCaptureCeilingAckResultSchema.safeParse(response).success
          ? response
          : failure('TRANSPORT', identity)
      }
      return failure('TRANSPORT', identity)
    }
    if (
      owner &&
      owner.binding.sender === binding.sender &&
      owner.binding.frame === binding.frame &&
      owner.phase === 'closed' &&
      owner.ceilingRequested &&
      owner.captureSession &&
      ack.tracks.length === owner.tracks.length &&
      owner.tracks.every((track, index) => {
        const row = ack.tracks[index]
        const frontier = owner.frontier.get(track)
        return (
          row?.track === track &&
          frontier !== undefined &&
          row.finalSequence === frontier.nextSequence - 1 &&
          row.finalSampleOffset === (frontier.nextSampleOffset ?? 0) &&
          row.finalSampleOffset <= CLOUD_SPEECH_CAPTURE_MAX_SAMPLES
        )
      }) &&
      owner.captureSession.acknowledgeCeiling(ack)
    ) {
      if (!owner.ceilingAcked) {
        try {
          owner.captureSession.completeCeiling()
          owner.ceilingAcked = true
        } catch {
          return failure('TRANSPORT', identity)
        }
      }
      const finished = await owner.finishPromise
      if (finished && typeof finished === 'object' && 'complete' in finished && finished.complete === true) {
        const response = {
          ok: true as const,
          captureId: ack.captureId,
          captureGeneration: ack.captureGeneration,
          ceilingId: ack.ceilingId,
          tracks: ack.tracks
        }
        return CloudSpeechCaptureCeilingAckResultSchema.safeParse(response).success
          ? response
          : failure('TRANSPORT', identity)
      }
      return failure('TRANSPORT', identity)
    }
    if (
      !owner ||
      state.current !== owner ||
      (owner.phase !== 'active' && owner.phase !== 'finishing') ||
      !owner.ceilingRequested ||
      owner.ceilingAcked ||
      owner.binding.sender !== binding.sender ||
      owner.binding.frame !== binding.frame ||
      !owner.captureSession ||
      !currentAuthority(owner, false)
    )
      return failure('STALE', identity)
    const exactFrontier =
      ack.tracks.length === owner.tracks.length &&
      owner.tracks.every((track, index) => {
        const row = ack.tracks[index]
        const frontier = owner.frontier.get(track)
        return (
          row?.track === track &&
          frontier !== undefined &&
          row.finalSequence === frontier.nextSequence - 1 &&
          row.finalSampleOffset === (frontier.nextSampleOffset ?? 0) &&
          row.finalSampleOffset <= CLOUD_SPEECH_CAPTURE_MAX_SAMPLES
        )
      })
    if (!exactFrontier || !owner.captureSession.acknowledgeCeiling(ack)) {
      owner.outputIntegrityFailure = true
      void retire(owner)
      return failure('ORDER', identity)
    }
    if (state.current !== owner || !currentAuthority(owner, false)) {
      void retire(owner)
      return failure('TIMEOUT', identity)
    }
    try {
      owner.captureSession.completeCeiling()
    } catch {
      void retire(owner)
      return failure('TRANSPORT', identity)
    }
    owner.ceilingAcked = true
    owner.cancelCeilingSchedule?.()
    owner.cancelCeilingSchedule = null
    const finishRequest = {
      captureId: ack.captureId,
      captureGeneration: ack.captureGeneration,
      tracks: ack.tracks.map(({ track, finalSequence, finalSampleOffset }) => ({
        track,
        finalSequence,
        finalSampleOffset
      }))
    }
    const finished =
      owner.phase === 'finishing' && owner.finishPromise
        ? await owner.finishPromise
        : await finishCapture(event, finishRequest)
    if (
      !finished ||
      typeof finished !== 'object' ||
      !('ok' in finished) ||
      finished.ok !== true ||
      !('complete' in finished) ||
      finished.complete !== true
    )
      return failure('TRANSPORT', identity)
    const result = {
      ok: true as const,
      captureId: ack.captureId,
      captureGeneration: ack.captureGeneration,
      ceilingId: ack.ceilingId,
      tracks: ack.tracks
    }
    return CloudSpeechCaptureCeilingAckResultSchema.safeParse(result).success ? result : failure('TRANSPORT', identity)
  }
  const changeLanguage = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, context.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechLanguageRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data
    const identity = { captureId: request.captureId, captureGeneration: request.captureGeneration }
    const owner = ownerFor(identity)
    if (
      !owner ||
      state.current !== owner ||
      owner.binding.sender !== binding.sender ||
      owner.binding.frame !== binding.frame
    )
      return failure('STALE')
    let onSettled: ((outcome: LanguageChangeOutcome) => void) | undefined
    try {
      onSettled = context.onLanguageChange?.(owner)
    } catch {
      // an observer never changes the result
    }
    const notify = (outcome: LanguageChangeOutcome): void => {
      try {
        onSettled?.(outcome)
      } catch {
        // an observer never changes the result
      }
    }
    if (!state.acceptingInput) {
      notify({ ok: false, code: 'CLOSED' })
      void retire(owner)
      return failure('CLOSED', identity)
    }
    const result = await lifecycle.changeLanguage(owner, request.language)
    const value = result.ok
      ? { ok: true as const, ...identity, language: result.language, changed: result.changed }
      : failure(result.code, identity)
    const settled = CloudSpeechLanguageResultSchema.safeParse(value).success ? value : failure('TRANSPORT', identity)
    notify(settled.ok ? { ok: true, changed: settled.changed } : { ok: false, code: settled.code })
    return settled
  }
  return { frame, transitionAck, finishCapture, ceilingAck, changeLanguage }
}
