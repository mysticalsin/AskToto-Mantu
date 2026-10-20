import {
  CLOUD_SPEECH_CAPTURE_MAX_SAMPLES,
  CLOUD_SPEECH_HANDOFF_MAX_MS,
  MainSpeechCaptureSession
} from '../cloud-stt/capture-session'
import { failure, mapClosureReason, sameBinding, ROUTES, type Owner } from './cloud-speech-ipc-support'
import {
  CLOUD_SPEECH_FULL_FRAME_BYTES,
  CLOUD_SPEECH_IPC,
  CLOUD_SPEECH_MAX_PENDING_AUDIO_MS,
  CLOUD_SPEECH_MAX_PENDING_BYTES,
  CLOUD_SPEECH_MAX_PENDING_FRAMES,
  CloudSpeechEventSchema,
  CloudSpeechFrameResultSchema,
  type CloudSpeechEpochTransitionEvent,
  type CloudSpeechEvent,
  type CloudSpeechFrame
} from '../../shared/cloud-speech'
import type { SpeechBrokerOperation, SpeechTrack } from '../cloud-stt/broker-client'
import type { RelaySpeechSessionOptions, RelayTrackClosure } from '../cloud-stt/relay-session'
import type { CaptureLifecycle, CaptureLifecycleContext } from './cloud-speech-ipc-context'
import { identityOf } from './cloud-speech-ipc-support'

export function createCaptureLifecycle(context: CaptureLifecycleContext): CaptureLifecycle {
  const { now, monotonicNow, schedule, currentAuthority, retire } = context
  const isCurrent = (owner: Owner): boolean => context.state.current === owner
  const notifyDelivered = (owner: Owner, event: CloudSpeechEvent): void => {
    try {
      context.onDelivered?.(owner, event)
    } catch {
      // an observer never affects delivery
    }
  }
  const sendEvent = (owner: Owner, value: unknown): boolean => {
    if (!isCurrent(owner) || owner.phase === 'cancelled' || owner.phase === 'closed') return false
    if (!currentAuthority(owner, false)) {
      void retire(owner)
      return false
    }
    const parsed = CloudSpeechEventSchema.safeParse(value)
    if (!parsed.success) return false
    if (owner.phase === 'starting') {
      let bytes: number
      try {
        bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
      } catch {
        return false
      }
      if (owner.pendingEvents.length >= 128 || owner.pendingEventBytes + bytes > 256 * 1024) {
        owner.eventOverflow = true
        void retire(owner)
        return false
      }
      owner.pendingEvents.push(parsed.data)
      owner.pendingEventBytes += bytes
      return true
    }
    try {
      owner.binding.sender.send(CLOUD_SPEECH_IPC.event, parsed.data)
      if (parsed.data.type === 'segment') notifyDelivered(owner, parsed.data)
      return true
    } catch {
      void retire(owner)
      return false
    }
  }

  const makeRelayTranscript = (
    owner: Owner,
    transcript: Parameters<NonNullable<RelaySpeechSessionOptions['onTranscript']>>[0],
    context: Parameters<NonNullable<RelaySpeechSessionOptions['onTranscript']>>[1]
  ): void => {
    if (!isCurrent(owner)) return
    if (!currentAuthority(owner, false)) {
      void retire(owner)
      return
    }
    const key = `${transcript.track}:${transcript.streamEpoch}`
    const capture = owner.captureSession
    const isCandidate =
      owner.phase === 'rotating' &&
      (capture?.phase === 'opening-next' || capture?.phase === 'awaiting-next-application') &&
      owner.candidateAllocation?.sessionId === context.sessionId
    const currentIdentity = owner.session?.identity
    const isCurrentRelay =
      (owner.phase === 'starting' && owner.primaryAllocation.sessionId === context.sessionId) ||
      (currentIdentity?.sessionId === context.sessionId &&
        capture?.phase !== 'opening-next' &&
        capture?.phase !== 'awaiting-next-application')
    const expectedStreams = isCandidate ? currentIdentity?.tracks : owner.session?.identity.tracks
    const lastSequence = isCandidate
      ? (owner.candidateEventFrontier.get(key) ?? 0)
      : (owner.eventFrontier.get(key) ?? 0)
    if (
      (!isCandidate && !isCurrentRelay) ||
      (expectedStreams &&
        !expectedStreams.some(
          (stream) =>
            stream.track === transcript.track &&
            (isCandidate ? transcript.streamEpoch > stream.streamEpoch : transcript.streamEpoch === stream.streamEpoch)
        )) ||
      transcript.sequence !== lastSequence + 1
    ) {
      owner.outputIntegrityFailure = true
      void retire(owner)
      return
    }
    const startMs = Math.floor(context.firstCaptureSampleOffset / 16 + transcript.startMs)
    const endMs = Math.ceil(context.firstCaptureSampleOffset / 16 + transcript.endMs)
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) {
      owner.outputIntegrityFailure = true
      void retire(owner)
      return
    }
    const event = {
      type: 'segment' as const,
      ...identityOf(owner),
      sequence: transcript.sequence,
      segment: {
        stream: { generation: owner.generation, track: transcript.track, epoch: transcript.streamEpoch },
        engine: owner.engine,
        index: transcript.segmentIndex,
        revision: transcript.revision,
        final: transcript.final,
        text: transcript.text,
        startMs,
        endMs
      },
      ...(transcript.languages ? { languages: transcript.languages } : {}),
      ...(transcript.words
        ? {
            words: transcript.words.map((word) => ({
              ...word,
              startMs: Math.floor(context.firstCaptureSampleOffset / 16 + word.startMs),
              endMs: Math.ceil(context.firstCaptureSampleOffset / 16 + word.endMs)
            }))
          }
        : {})
    }
    if (!CloudSpeechEventSchema.safeParse(event).success) {
      owner.outputIntegrityFailure = true
      void retire(owner)
      return
    }
    if (isCandidate) {
      let bytes: number
      try {
        bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
      } catch {
        owner.outputIntegrityFailure = true
        void retire(owner)
        return
      }
      if (owner.candidatePendingEvents.length >= 128 || owner.candidateEventBytes + bytes > 256 * 1024) {
        owner.outputIntegrityFailure = true
        void retire(owner)
        return
      }
      owner.candidatePendingEvents.push(event as CloudSpeechEvent)
      owner.candidateEventBytes += bytes
      owner.candidateEventFrontier.set(key, transcript.sequence)
    } else if (sendEvent(owner, event)) owner.eventFrontier.set(key, transcript.sequence)
    else owner.outputIntegrityFailure = true
  }

  const setTerminal = (
    owner: Owner,
    tracks: Array<{
      track: SpeechTrack
      streamEpoch: number
      closeConfirmed: boolean
      tail: 'complete' | 'incomplete'
      lastSequence: number
      reason: string
    }>
  ): void => {
    for (const item of tracks) {
      const safe = {
        epoch: item.streamEpoch,
        lastSequence: item.lastSequence,
        closeConfirmed: item.closeConfirmed,
        tail: item.tail,
        reason: mapClosureReason(item.reason)
      }
      sendEvent(owner, {
        type: 'terminal',
        ...identityOf(owner),
        stream: { generation: owner.generation, track: item.track, epoch: item.streamEpoch },
        lastSequence: item.lastSequence,
        closeConfirmed: item.closeConfirmed,
        tail: item.tail,
        reason: safe.reason
      })
    }
  }

  const handoffDeadline = (owner: Owner): number => {
    const proposed = monotonicNow() + CLOUD_SPEECH_HANDOFF_MAX_MS
    owner.rotationDeadlineAt =
      owner.rotationDeadlineAt === null ? proposed : Math.min(owner.rotationDeadlineAt, proposed)
    return owner.rotationDeadlineAt
  }
  const failRotation = (owner: Owner): void => {
    owner.outputIntegrityFailure = true
    owner.rotationAbort?.abort()
    owner.captureSession?.invalidate('cancelled', failure('TRANSPORT', identityOf(owner)))
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = null
    owner.cancelCeilingSchedule?.()
    owner.cancelCeilingSchedule = null
    for (const item of owner.captureSession?.takePendingFrames() ?? [])
      item.resolve(failure('TRANSPORT', identityOf(owner)))
    if (isCurrent(owner)) void retire(owner)
  }

  function publishTransition(
    owner: Owner,
    stage: 'closed',
    streams: Array<{ track: SpeechTrack; previousEpoch: number; lastSequence: number }>
  ): Promise<boolean>
  function publishTransition(
    owner: Owner,
    stage: 'opened',
    streams: Array<{ track: SpeechTrack; previousEpoch: number; nextEpoch: number; lastSequence: number }>
  ): Promise<boolean>
  async function publishTransition(
    owner: Owner,
    stage: 'closed' | 'opened',
    streams:
      | Array<{ track: SpeechTrack; previousEpoch: number; lastSequence: number }>
      | Array<{ track: SpeechTrack; previousEpoch: number; nextEpoch: number; lastSequence: number }>
  ): Promise<boolean> {
    const capture = owner.captureSession
    if (!capture || !isCurrent(owner) || !currentAuthority(owner, false)) return false
    const deadlineAt = handoffDeadline(owner)
    let transition: { event: CloudSpeechEpochTransitionEvent; applied: Promise<boolean> }
    try {
      transition =
        stage === 'closed'
          ? capture.beginTransition(
              'closed',
              streams as Array<{ track: SpeechTrack; previousEpoch: number; lastSequence: number }>,
              deadlineAt
            )
          : capture.beginTransition(
              'opened',
              streams as Array<{ track: SpeechTrack; previousEpoch: number; nextEpoch: number; lastSequence: number }>,
              deadlineAt
            )
    } catch {
      return false
    }
    capture.phase = stage === 'closed' ? 'awaiting-old-application' : 'awaiting-next-application'
    if (!sendEvent(owner, transition.event)) return false
    const applied = await transition.applied
    if (!applied || !isCurrent(owner) || !currentAuthority(owner, false)) return false
    capture.completeTransition()
    return true
  }

  const preflightRotation = async (owner: Owner, cutoffAt: number): Promise<void> => {
    const session = owner.session
    const client = owner.client
    if (!session || !client || !isCurrent(owner) || owner.phase !== 'active' || !currentAuthority(owner, true)) {
      failRotation(owner)
      return
    }
    const remaining = cutoffAt - monotonicNow()
    if (remaining <= 0) {
      void rotate(owner)
      return
    }
    const controller = new AbortController()
    owner.rotationAbort?.abort()
    owner.rotationAbort = controller
    try {
      await context.prepareAuthority?.(owner.event, owner.request)
    } catch {
      failRotation(owner)
      return
    }
    if (controller.signal.aborted || !isCurrent(owner) || owner.phase !== 'active' || !sameBinding(owner.binding))
      return
    if (!currentAuthority(owner, true)) {
      failRotation(owner)
      return
    }
    if (monotonicNow() >= cutoffAt) {
      void rotate(owner)
      return
    }
    const operation: SpeechBrokerOperation = { signal: controller.signal, deadlineAt: cutoffAt }
    const capability = await client
      .capability(operation)
      .catch(() => ({ ok: false as const, code: 'TRANSPORT' as const }))
    if (controller.signal.aborted || !isCurrent(owner) || owner.phase !== 'active') return
    if (!capability.ok || !currentAuthority(owner, true)) {
      failRotation(owner)
      return
    }
    const currentSession = owner.session?.identity
    const broker = capability.value
    const expectedRoute = ROUTES[owner.engine]
    if (
      !currentSession ||
      !broker.ready ||
      broker.routeId !== expectedRoute.routeId ||
      broker.modelId !== expectedRoute.modelId ||
      broker.configVersion !== currentSession.configVersion ||
      broker.policyVersion !== currentSession.policyVersion ||
      broker.languages.includes(currentSession.language) === false ||
      broker.validUntil <= now() ||
      !broker.allowed.some(
        (route) => route.routeId === expectedRoute.routeId && route.modelId === expectedRoute.modelId
      )
    ) {
      failRotation(owner)
      return
    }
    owner.preflightBinding = { configVersion: broker.configVersion, policyVersion: broker.policyVersion }
    owner.rotationAbort = null
    const delay = cutoffAt - monotonicNow()
    owner.cancelRotationSchedule = schedule(() => void rotate(owner), delay)
  }

  const rotate = async (owner: Owner): Promise<void> => {
    if (owner.rotationPromise) return owner.rotationPromise
    const session = owner.session
    const capture = owner.captureSession
    if (
      !session ||
      !capture ||
      !isCurrent(owner) ||
      owner.phase !== 'active' ||
      !owner.preflightBinding ||
      !currentAuthority(owner, true)
    ) {
      failRotation(owner)
      return
    }
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = null
    owner.phase = 'rotating'
    capture.phase = 'closing-old'
    const controller = new AbortController()
    owner.rotationAbort = controller
    owner.rotationPromise = (async () => {
      const previousIdentity = session.identity
      const previous = await session.finish(Math.min(5_000, previousIdentity.limits.drainWindowMs)).catch(() => null)
      if (!previous || !isCurrent(owner) || controller.signal.aborted || !currentAuthority(owner, false)) {
        failRotation(owner)
        return
      }
      const previousTracks = previousIdentity.tracks
      const validClose =
        previous.complete &&
        previous.tracks.length === owner.tracks.length &&
        previousTracks.length === owner.tracks.length &&
        owner.tracks.every((track, index) => {
          const expected = previousTracks[index]
          const closed = previous.tracks[index]
          return (
            expected?.track === track &&
            closed?.track === track &&
            expected.streamEpoch === closed.streamEpoch &&
            closed.closeConfirmed &&
            closed.tail === 'complete' &&
            closed.lastSequence === (owner.eventFrontier.get(`${track}:${closed.streamEpoch}`) ?? 0)
          )
        })
      setTerminal(owner, previous.tracks)
      if (!validClose || owner.outputIntegrityFailure) {
        failRotation(owner)
        return
      }
      const closedStreams = previous.tracks.map((track) => ({
        track: track.track,
        previousEpoch: track.streamEpoch,
        lastSequence: track.lastSequence
      }))
      if (!(await publishTransition(owner, 'closed', closedStreams))) {
        failRotation(owner)
        return
      }
      if (!isCurrent(owner) || controller.signal.aborted || !currentAuthority(owner, false)) {
        failRotation(owner)
        return
      }
      const issuedAt = now()
      // Consent stays a fresh, valid two-minute grant. The independent
      // monotonic capture deadline bounds allocation and tears down every
      // successor; capping this wall-clock timestamp would make the grant
      // fractional or fail to increase during consecutive late renewals.
      const expiresAt = issuedAt + 120_000
      const createRequest = {
        operation: 'create-session' as const,
        captureGeneration: owner.generation,
        tracks: [...owner.tracks],
        language: previousIdentity.language,
        consent: {
          accepted: true as const,
          captureGeneration: owner.generation,
          tracks: [...owner.tracks],
          issuedAt,
          expiresAt
        }
      }
      const latest = currentAuthority(owner, false)
      const preflightBinding = owner.preflightBinding
      if (
        !latest ||
        latest.selectedEngine !== owner.engine ||
        latest.credentialRevision === '' ||
        latest.policyRevision === '' ||
        !preflightBinding ||
        preflightBinding.configVersion !== previousIdentity.configVersion ||
        preflightBinding.policyVersion !== previousIdentity.policyVersion
      ) {
        failRotation(owner)
        return
      }
      capture.phase = 'opening-next'
      owner.candidateAllocation = { attempted: false, sessionId: null }
      owner.candidateSession = null
      owner.candidatePendingEvents = []
      owner.candidateEventBytes = 0
      owner.candidateEventFrontier.clear()
      const operation: SpeechBrokerOperation = {
        signal: controller.signal,
        deadlineAt: handoffDeadline(owner)
      }
      const next = await session.renew(createRequest, operation)
      if (!next.ok || !isCurrent(owner) || controller.signal.aborted || !currentAuthority(owner, false)) {
        failRotation(owner)
        return
      }
      const nextIdentity = next.value.identity
      const exactTracks =
        nextIdentity.tracks.length === previousIdentity.tracks.length &&
        previousIdentity.tracks.every((old, index) => {
          const fresh = nextIdentity.tracks[index]
          return fresh?.track === old.track && fresh.streamEpoch > old.streamEpoch
        })
      if (
        !exactTracks ||
        nextIdentity.captureGeneration !== owner.generation ||
        nextIdentity.routeId !== previousIdentity.routeId ||
        nextIdentity.model !== previousIdentity.model ||
        nextIdentity.language !== previousIdentity.language ||
        nextIdentity.configVersion !== previousIdentity.configVersion ||
        nextIdentity.policyVersion !== previousIdentity.policyVersion ||
        owner.candidateAllocation?.sessionId !== nextIdentity.sessionId
      ) {
        await next.value.cancel().catch(() => undefined)
        failRotation(owner)
        return
      }
      owner.candidateSession = next.value
      const openedStreams = previous.tracks.map((old) => {
        const fresh = nextIdentity.tracks.find((item) => item.track === old.track)!
        return {
          track: old.track,
          previousEpoch: old.streamEpoch,
          nextEpoch: fresh.streamEpoch,
          lastSequence: old.lastSequence
        }
      })
      if (!(await publishTransition(owner, 'opened', openedStreams))) {
        failRotation(owner)
        return
      }
      if (!isCurrent(owner) || controller.signal.aborted || !currentAuthority(owner, false)) {
        failRotation(owner)
        return
      }
      owner.session = next.value
      owner.primaryAllocation = owner.candidateAllocation!
      owner.candidateAllocation = null
      for (const event of owner.candidatePendingEvents) {
        if (!sendEvent(owner, event)) {
          failRotation(owner)
          return
        }
        if (event.type === 'segment')
          owner.eventFrontier.set(`${event.segment.stream.track}:${event.segment.stream.epoch}`, event.sequence)
      }
      owner.candidatePendingEvents = []
      owner.candidateEventBytes = 0
      owner.candidateEventFrontier.clear()
      owner.phase = 'active'
      capture.phase = 'active'
      owner.preflightBinding = null
      owner.rotationDeadlineAt = null
      owner.rotationAbort = null
      const queued = capture.takePendingFrames()
      for (const [index, item] of queued.entries()) {
        const frame = item.frame as CloudSpeechFrame
        if (item.deadlineAt <= monotonicNow()) {
          item.resolve(failure('TIMEOUT', identityOf(owner)))
          for (const waiting of queued.slice(index + 1)) waiting.resolve(failure('TIMEOUT', identityOf(owner)))
          failRotation(owner)
          return
        }
        const accepted = next.value.pushFrame(frame.track, {
          sequence: frame.sequence,
          sampleOffset: frame.sampleOffset,
          pcm16le: new Uint8Array(frame.pcm16le)
        })
        if (!accepted.ok) {
          item.resolve(failure(accepted.code === 'QUEUE_LIMIT' ? 'QUEUE_LIMIT' : 'TRANSPORT', identityOf(owner)))
          for (const waiting of queued.slice(index + 1)) waiting.resolve(failure('TRANSPORT', identityOf(owner)))
          failRotation(owner)
          return
        }
        const frontier = owner.frontier.get(frame.track)
        const nextSequence = frame.sequence + 1
        const nextSampleOffset = frame.sampleOffset + frame.pcm16le.byteLength / 2
        if (!frontier || frame.sequence !== frontier.nextSequence || !Number.isSafeInteger(nextSampleOffset)) {
          item.resolve(failure('ORDER', identityOf(owner)))
          for (const waiting of queued.slice(index + 1)) waiting.resolve(failure('ORDER', identityOf(owner)))
          failRotation(owner)
          return
        }
        owner.frontier.set(frame.track, { nextSequence, nextSampleOffset })
        if (frame.kind === 'sealed-final') owner.sealedTracks.add(frame.track)
        const response = {
          ok: true as const,
          ...identityOf(owner),
          track: frame.track,
          sequence: frame.sequence,
          nextSequence,
          nextSampleOffset
        }
        item.resolve(
          CloudSpeechFrameResultSchema.safeParse(response).success ? response : failure('TRANSPORT', identityOf(owner))
        )
      }
      if (
        [...owner.frontier.values()].some((frontier) => frontier.nextSampleOffset === CLOUD_SPEECH_CAPTURE_MAX_SAMPLES)
      )
        startCaptureCeiling(owner)
      else if (owner.finishAfterRotation === null) armRotation(owner)
    })().finally(() => {
      owner.rotationPromise = null
    })
    return owner.rotationPromise
  }

  function armRotation(owner: Owner): void {
    const session = owner.session
    if (!session || owner.phase !== 'active' || !isCurrent(owner)) return
    const identity = session.identity
    // Broker lease timestamps are wall-clock values. Convert the remaining
    // duration once, then keep coordinator deadlines on the monotonic clock.
    const cutoffAt =
      monotonicNow() + Math.max(0, identity.audioDeadlineAt - Math.min(identity.limits.drainWindowMs, 5_000) - now())
    const prepareAt = cutoffAt - CLOUD_SPEECH_HANDOFF_MAX_MS
    const delay = Math.max(0, prepareAt - monotonicNow())
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = schedule(() => void preflightRotation(owner, cutoffAt), delay)
  }

  const startCaptureCeiling = (owner: Owner): void => {
    const capture = owner.captureSession
    if (owner.ceilingRequested) return
    if (
      !capture ||
      !isCurrent(owner) ||
      (owner.phase !== 'active' && !(owner.phase === 'finishing' && owner.finishPromise)) ||
      !currentAuthority(owner, false)
    ) {
      if (isCurrent(owner)) void retire(owner)
      return
    }
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = null
    owner.ceilingRequested = true
    const deadlineAt = monotonicNow() + 5_000
    owner.ceilingFrameDeadlineAt = Math.min(deadlineAt, monotonicNow() + CLOUD_SPEECH_HANDOFF_MAX_MS)
    let ceiling: ReturnType<MainSpeechCaptureSession['beginCeiling']>
    try {
      ceiling = capture.beginCeiling(CLOUD_SPEECH_CAPTURE_MAX_SAMPLES, deadlineAt)
    } catch {
      void retire(owner)
      return
    }
    if (!sendEvent(owner, ceiling.event)) {
      void retire(owner)
      return
    }
    void ceiling.applied.then((ack) => {
      if (ack !== null || !isCurrent(owner)) return
      owner.outputIntegrityFailure = true
      void retire(owner)
    })
  }

  const armCaptureCeiling = (owner: Owner): void => {
    const capture = owner.captureSession
    if (!capture || !isCurrent(owner) || owner.phase !== 'active') return
    owner.cancelCeilingSchedule?.()
    const delay = Math.max(0, capture.deadlineAt - monotonicNow())
    owner.cancelCeilingSchedule = schedule(() => startCaptureCeiling(owner), delay)
  }

  return {
    sendEvent,
    makeRelayTranscript,
    setTerminal,
    armRotation,
    rotate,
    failRotation,
    startCaptureCeiling,
    armCaptureCeiling
  }
}
