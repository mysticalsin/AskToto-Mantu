import {
  CLOUD_SPEECH_DISCLOSURE_VERSION,
  CLOUD_SPEECH_FULL_FRAME_BYTES,
  CLOUD_SPEECH_IPC,
  CLOUD_SPEECH_MAX_PENDING_AUDIO_MS,
  CLOUD_SPEECH_MAX_PENDING_BYTES,
  CLOUD_SPEECH_MAX_PENDING_FRAMES,
  CloudSpeechCancelResultSchema,
  CloudSpeechCancelRequestSchema,
  CloudSpeechCaptureCeilingAckResultSchema,
  CloudSpeechCaptureCeilingAckSchema,
  CloudSpeechCapabilitySchema,
  CloudSpeechEventSchema,
  CloudSpeechEpochTransitionAckSchema,
  CloudSpeechEpochTransitionAckResultSchema,
  CloudSpeechFinishRequestSchema,
  CloudSpeechFrameSchema,
  CloudSpeechFrameResultSchema,
  CloudSpeechFinishResultSchema,
  CloudSpeechStartRequestSchema,
  CloudSpeechStartResultSchema,
  CloudSpeechStatusRequestSchema,
  CloudSpeechStatusResultSchema,
  type CloudSpeechEngine,
  type CloudSpeechEvent,
  type CloudSpeechFrame,
  type CloudSpeechFailure,
  type CloudSpeechStartRequest,
  type CloudSpeechEpochTransitionEvent
} from '@shared/cloud-speech'
import {
  SpeechBrokerClient,
  type SpeechBrokerClientOptions,
  type SpeechBrokerOperation,
  type SpeechTrack
} from '../cloud-stt/broker-client'
import { RelaySpeechSession, type RelaySpeechSessionOptions } from '../cloud-stt/relay-session'
import {
  CLOUD_SPEECH_CAPTURE_MAX_MS,
  CLOUD_SPEECH_CAPTURE_MAX_SAMPLES,
  CLOUD_SPEECH_HANDOFF_MAX_MS,
  MainSpeechCaptureSession
} from '../cloud-stt/capture-session'
import { scheduleCaptureDeadline } from '../infra/scheduler/capture-deadline'
import {
  IPC_CHANNELS,
  ROUTES,
  TRACKS,
  authorityRevision,
  bindCreateToCapability,
  capabilityBinding,
  createIpcHandlerRegistrar,
  failure,
  getBinding,
  identityKey,
  mapBrokerFailure,
  mapClosureReason,
  refusedCapability,
  routeFor,
  sameBinding,
  toSafeCapability,
  validTrackList,
  type Authority,
  type CloudSpeechIpcOptions,
  type Owner,
  type SpeechIpcEvent
} from './cloud-speech-ipc-support'

export type { CloudSpeechMainAuthority, CloudSpeechIpcOptions } from './cloud-speech-ipc-support'
export type CloudSpeechIpcRegistration = {
  closeInput: () => void
  invalidateCurrent: () => void
  shutdown: (timeoutMs?: number) => Promise<void>
  dispose: () => Promise<void>
}

export function registerCloudSpeechIpc(options: CloudSpeechIpcOptions): CloudSpeechIpcRegistration {
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const makeClient =
    options.clientFactory ?? ((credentials: SpeechBrokerClientOptions) => new SpeechBrokerClient(credentials))
  let current: Owner | null = null
  const owners = new Map<string, Owner>()
  let acceptingInput = true
  let shuttingDown = false
  let authorityPreparationGeneration = 0
  let capabilityPreparationGeneration = 0

  const currentAuthority = (owner: Owner, requireCapture: boolean): Authority | null => {
    if (!sameBinding(owner.binding) || shuttingDown || (requireCapture && !acceptingInput)) return null
    try {
      const latest = options.readAuthority(owner.event, owner.request, owner)
      if (
        owner.captureContext &&
        (!latest.captureContext ||
          latest.captureContext.webContents !== owner.captureContext.webContents ||
          latest.captureContext.frame !== owner.captureContext.frame ||
          latest.captureContext.navigationEpoch !== owner.captureContext.navigationEpoch ||
          latest.captureContext.listenStartedAt !== owner.captureContext.listenStartedAt ||
          (!requireCapture && latest.finishAllowed !== true))
      )
        return null
      if (
        !latest.enabled ||
        !latest.authenticated ||
        !latest.policyReady ||
        authorityRevision(latest) !== owner.authorityRevision ||
        (requireCapture && !latest.captureAllowed)
      )
        return null
      return latest
    } catch {
      return null
    }
  }

  const identityOf = (owner: Owner): { captureId: string; captureGeneration: number } => ({
    captureId: owner.captureId,
    captureGeneration: owner.generation
  })
  const ownerFor = (identity: { captureId: string; captureGeneration: number }): Owner | null =>
    owners.get(identityKey(identity.captureId, identity.captureGeneration)) ?? null
  const releaseCaptureOwner = (owner: Owner): void => {
    if (owner.finishContextReleased || owner.closureConfirmed !== true) return
    owner.finishContextReleased = true
    try {
      options.releaseCaptureOwner?.(owner)
    } catch {
      /* A failed release cannot restore capture or invalidate a completed main-owned closure. */
    }
  }

  const sendEvent = (owner: Owner, value: unknown): boolean => {
    if (current !== owner || owner.phase === 'cancelled' || owner.phase === 'closed') return false
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
    if (current !== owner) return
    if (!currentAuthority(owner, false)) {
      void retire(owner)
      return
    }
    const key = `${transcript.track}:${transcript.streamEpoch}`
    const capture = owner.captureSession
    const isCandidate =
      owner.phase === 'rotating' &&
      capture?.phase === 'opening-next' &&
      owner.candidateAllocationId === context.sessionId
    const currentIdentity = owner.session?.identity
    const isCurrentRelay =
      (owner.phase === 'starting' && owner.allocationId === context.sessionId) ||
      (currentIdentity?.sessionId === context.sessionId && capture?.phase !== 'opening-next')
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

  const schedule = options.scheduleCaptureDeadline ?? scheduleCaptureDeadline
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
    if (current === owner) void retire(owner)
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
    if (!capture || current !== owner || !currentAuthority(owner, false)) return false
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
    if (!applied || current !== owner || !currentAuthority(owner, false)) return false
    capture.completeTransition()
    return true
  }

  const preflightRotation = async (owner: Owner, cutoffAt: number): Promise<void> => {
    const session = owner.session
    const client = owner.client
    if (!session || !client || current !== owner || owner.phase !== 'active' || !currentAuthority(owner, true)) {
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
      await options.prepareAuthority?.(owner.event, owner.request)
    } catch {
      failRotation(owner)
      return
    }
    if (controller.signal.aborted || current !== owner || owner.phase !== 'active' || !sameBinding(owner.binding))
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
    if (controller.signal.aborted || current !== owner || owner.phase !== 'active') return
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
      current !== owner ||
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
      if (!previous || current !== owner || controller.signal.aborted || !currentAuthority(owner, false)) {
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
      if (current !== owner || controller.signal.aborted || !currentAuthority(owner, false)) {
        failRotation(owner)
        return
      }
      const issuedAt = now()
      const captureRemaining = Math.max(0, capture.deadlineAt - monotonicNow())
      const expiresAt = Math.min(issuedAt + 120_000, issuedAt + captureRemaining)
      if (expiresAt <= issuedAt) {
        failRotation(owner)
        return
      }
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
      owner.candidateAllocationId = null
      owner.candidateSession = null
      owner.candidatePendingEvents = []
      owner.candidateEventBytes = 0
      owner.candidateEventFrontier.clear()
      const operation: SpeechBrokerOperation = {
        signal: controller.signal,
        deadlineAt: handoffDeadline(owner)
      }
      const next = await session.renew(createRequest, operation)
      if (!next.ok || current !== owner || controller.signal.aborted || !currentAuthority(owner, false)) {
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
        owner.candidateAllocationId !== nextIdentity.sessionId
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
      if (current !== owner || controller.signal.aborted || !currentAuthority(owner, false)) {
        failRotation(owner)
        return
      }
      owner.session = next.value
      owner.allocationId = nextIdentity.sessionId
      owner.candidateAllocationId = null
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
    if (!session || owner.phase !== 'active' || current !== owner) return
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
      current !== owner ||
      (owner.phase !== 'active' && !(owner.phase === 'finishing' && owner.finishPromise)) ||
      !currentAuthority(owner, false)
    ) {
      if (current === owner) void retire(owner)
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
      if (ack !== null || current !== owner) return
      owner.outputIntegrityFailure = true
      void retire(owner)
    })
  }

  const armCaptureCeiling = (owner: Owner): void => {
    const capture = owner.captureSession
    if (!capture || current !== owner || owner.phase !== 'active') return
    owner.cancelCeilingSchedule?.()
    const delay = Math.max(0, capture.deadlineAt - monotonicNow())
    owner.cancelCeilingSchedule = schedule(() => startCaptureCeiling(owner), delay)
  }

  const queryClosure = async (owner: Owner): Promise<'confirmed' | 'unknown'> => {
    if (!owner.allocationId) return owner.allocationAttempted ? 'unknown' : owner.startSettled ? 'confirmed' : 'unknown'
    if (!owner.client) return 'unknown'
    const status = await owner.client
      .status(owner.allocationId, 1_000)
      .catch(() => ({ ok: false as const, code: 'TRANSPORT' as const }))
    if (!status.ok || status.value.captureGeneration !== owner.generation) return 'unknown'
    const tracks = status.value.tracks
    if (
      !validTrackList(tracks.map((track) => track.track)) ||
      tracks.length !== owner.tracks.length ||
      owner.tracks.some((track) => !tracks.some((item) => item.track === track)) ||
      tracks.some((track) => !track.closeConfirmed)
    )
      return 'unknown'
    const confirmed = status.value.status === 'cancelled' || status.value.status === 'expired'
    if (confirmed) {
      owner.closureConfirmed = true
      owner.phase = 'closed'
      setTerminal(
        owner,
        tracks.map((track) => ({
          track: track.track,
          streamEpoch: track.streamEpoch,
          closeConfirmed: track.closeConfirmed,
          tail: track.tail ?? 'incomplete',
          lastSequence: track.lastSequence,
          reason: status.value.status === 'expired' ? 'lease-expired' : 'cancelled'
        }))
      )
      releaseCaptureOwner(owner)
    }
    return confirmed ? 'confirmed' : 'unknown'
  }

  const retire = async (owner: Owner): Promise<'confirmed' | 'unknown'> => {
    if (owner.phase === 'closed') {
      if (owner.closureConfirmed === true) releaseCaptureOwner(owner)
      return owner.closureConfirmed === true ? 'confirmed' : queryClosure(owner)
    }
    if (current === owner) authorityPreparationGeneration += 1
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = null
    owner.cancelCeilingSchedule?.()
    owner.cancelCeilingSchedule = null
    owner.rotationAbort?.abort()
    owner.captureSession?.invalidate('cancelled', failure('CLOSED', identityOf(owner)))
    owner.phase = 'cancelled'
    if (current === owner) current = null
    if (owner.candidateSession) await owner.candidateSession.cancel().catch(() => undefined)
    if (owner.session) {
      await owner.session.cancel().catch(() => undefined)
      return queryClosure(owner)
    }
    if (!owner.allocationAttempted) {
      const confirmed = owner.startSettled
      if (confirmed) {
        owner.closureConfirmed = true
        owner.phase = 'closed'
        releaseCaptureOwner(owner)
      }
      return confirmed ? 'confirmed' : 'unknown'
    }
    if (!owner.startSettled) return 'unknown'
    return queryClosure(owner)
  }

  const safeStart = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechStartRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data
    const identity = { captureId: request.captureId, captureGeneration: request.capture.generation }
    if (owners.has(identityKey(identity.captureId, identity.captureGeneration))) return failure('STALE', identity)
    if (shuttingDown) return failure('CLOSED', identity)
    // A new explicit, currently authorized Start reopens admission after a prior normal Stop.
    acceptingInput = true
    if (request.consent.disclosureVersion !== CLOUD_SPEECH_DISCLOSURE_VERSION) return failure('CONSENT', identity)
    const engine = request.capture.engine as CloudSpeechEngine
    if (!validTrackList(request.capture.capturedTracks as SpeechTrack[])) return failure('INVALID_REQUEST', identity)

    for (const [key, candidate] of owners) {
      if (candidate.phase === 'closed' && candidate.closureConfirmed === true && candidate.startSettled)
        owners.delete(key)
    }
    if (owners.size >= 2) return failure('CLOSURE_UNCONFIRMED', identity)
    const prior = current
    const captureStartedAt = monotonicNow()
    const owner: Owner = {
      binding,
      captureId: request.captureId,
      generation: request.capture.generation,
      engine,
      tracks: [...request.capture.capturedTracks] as SpeechTrack[],
      authorityRevision: '',
      captureContext: null,
      client: null,
      captureSession: new MainSpeechCaptureSession({
        captureId: request.captureId,
        captureGeneration: request.capture.generation,
        tracks: request.capture.capturedTracks as SpeechTrack[],
        startedAt: captureStartedAt,
        maxDurationMs: CLOUD_SPEECH_CAPTURE_MAX_MS,
        monotonicNow,
        ...(options.scheduleCaptureDeadline ? { schedule: options.scheduleCaptureDeadline } : {})
      }),
      phase: 'starting',
      allocationAttempted: false,
      allocationId: null,
      session: null,
      candidateSession: null,
      finishPromise: null,
      finishCheckpoint: null,
      frontier: new Map(),
      sealedTracks: new Set(),
      eventFrontier: new Map(),
      outputIntegrityFailure: false,
      startSettled: false,
      pendingEvents: [],
      pendingEventBytes: 0,
      eventOverflow: false,
      closureConfirmed: null,
      finishContextReleased: false,
      rotationPromise: null,
      rotationAbort: null,
      cancelRotationSchedule: null,
      cancelCeilingSchedule: null,
      ceilingRequested: false,
      ceilingAcked: false,
      ceilingFrameDeadlineAt: null,
      preflightBinding: null,
      rotationDeadlineAt: null,
      candidateAllocationId: null,
      candidatePendingEvents: [],
      candidateEventBytes: 0,
      candidateEventFrontier: new Map(),
      finishAfterRotation: null,
      event,
      request
    }
    // Synchronous ownership precedes retirement/capability awaits so stop and replacement can tombstone this start.
    current = owner
    owners.set(identityKey(owner.captureId, owner.generation), owner)
    let preparationGeneration = authorityPreparationGeneration
    const predecessors = [...owners.values()].filter(
      (candidate) =>
        candidate !== owner &&
        (candidate === prior || candidate.phase !== 'closed' || candidate.closureConfirmed !== true)
    )
    for (const predecessor of predecessors) {
      const retired = await retire(predecessor)
      if (retired !== 'confirmed') {
        owner.startSettled = true
        owner.closureConfirmed = true
        owner.phase = 'closed'
        if (current === owner) current = null
        return failure('CLOSURE_UNCONFIRMED', identity)
      }
    }
    preparationGeneration = ++authorityPreparationGeneration
    try {
      try {
        await options.prepareAuthority?.(event, request)
      } catch {
        return failure('POLICY', identity)
      }
      if (
        authorityPreparationGeneration !== preparationGeneration ||
        current !== owner ||
        owner.phase !== 'starting' ||
        !sameBinding(owner.binding)
      )
        return failure('CLOSED', identity)
      let authority: Authority
      try {
        authority = options.readAuthority(event, request, owner)
      } catch {
        return failure('POLICY', identity)
      }
      if (!authority.enabled) return failure('DISABLED', identity)
      if (!authority.authenticated) return failure('AUTH', identity)
      if (!authority.policyReady) return failure('POLICY', identity)
      if (!authority.captureAllowed) return failure('CLOSED', identity)
      const stableRevision = authorityRevision(authority)
      if (!stableRevision) return failure('POLICY', identity)
      owner.authorityRevision = stableRevision
      owner.captureContext = authority.captureContext ?? null
      if (authority.selectedEngine !== engine || !authority.allowedEngines.includes(engine))
        return failure('POLICY', identity)
      const selected = routeFor(engine)
      if (request.language !== 'auto' && !authority.allowedLanguages.includes(request.language))
        return failure('POLICY', identity)
      if (!authority.credentials) return failure('NOT_CONFIGURED', identity)
      let client: SpeechBrokerClient
      try {
        client = makeClient(authority.credentials)
        owner.client = client
      } catch {
        return failure('NOT_CONFIGURED', identity)
      }
      if (current !== owner || !currentAuthority(owner, true)) return failure('CLOSED', identity)
      const capability = await client.capability()
      if (current !== owner || !currentAuthority(owner, true)) return failure('CLOSED', identity)
      if (!capability.ok) return failure(mapBrokerFailure(capability.code), identity)
      const route = ROUTES[engine]
      const broker = capability.value
      if (
        !broker.ready ||
        broker.routeId !== route.routeId ||
        broker.modelId !== route.modelId ||
        broker.selected.routeId !== route.routeId ||
        broker.selected.modelId !== route.modelId ||
        !broker.allowed.some((item) => item.routeId === route.routeId && item.modelId === route.modelId) ||
        !Number.isSafeInteger(broker.validUntil) ||
        broker.validUntil <= now()
      )
        return failure('NOT_READY', identity)
      const language =
        request.language === 'auto' && engine === 'deepgram-nova3' && broker.languages.includes('multi')
          ? 'multi'
          : request.language
      if (!broker.languages.includes(language) || !authority.allowedLanguages.includes(language))
        return failure('POLICY', identity)
      const binding = capabilityBinding(broker, language)
      if (!binding || binding.routeId !== route.routeId || binding.modelId !== route.modelId)
        return failure('NOT_READY', identity)
      const latestBeforeAllocate = currentAuthority(owner, true)
      if (!latestBeforeAllocate) return failure('POLICY', identity)
      const issuedAt = now()
      owner.allocationAttempted = true
      const createRequest = {
        operation: 'create-session' as const,
        captureGeneration: owner.generation,
        tracks: owner.tracks,
        language,
        consent: {
          accepted: true as const,
          captureGeneration: owner.generation,
          tracks: owner.tracks,
          issuedAt,
          expiresAt: issuedAt + 120_000
        }
      }
      const relayOptions: RelaySpeechSessionOptions & {
        expectedCapability: { configVersion: string; policyVersion: string }
      } = {
        expectedCapability: { configVersion: binding.configVersion, policyVersion: binding.policyVersion },
        client: bindCreateToCapability(client, binding, (id) => {
          if (owner.phase === 'rotating') owner.candidateAllocationId = id
          else owner.allocationId = id
        }),
        createRequest,
        expectedSelection: { routeId: route.routeId, modelId: route.modelId, language },
        isCurrent: () => {
          if (current !== owner) return false
          if (owner.phase === 'starting') return currentAuthority(owner, true) !== null
          return (
            (owner.phase === 'active' || owner.phase === 'rotating' || owner.phase === 'finishing') &&
            currentAuthority(owner, false) !== null
          )
        },
        onAllocated: (id) => {
          if (owner.phase === 'rotating') owner.candidateAllocationId = id
          else owner.allocationId = id
        },
        onTranscript: (transcript, context) => makeRelayTranscript(owner, transcript, context)
      }
      const created = await RelaySpeechSession.create(relayOptions)
      if (!created.ok) {
        return failure(
          created.code === 'CANCELLED'
            ? 'CLOSED'
            : created.code === 'SCHEMA'
              ? 'POLICY'
              : mapBrokerFailure(created.code),
          identity
        )
      }
      owner.session = created.value
      if (current !== owner || !currentAuthority(owner, true)) {
        await owner.session.cancel()
        return failure('CLOSED', identity)
      }
      if (owner.eventOverflow) {
        await owner.session.cancel()
        return failure('QUEUE_LIMIT', identity)
      }
      const sessionTracks = owner.session.identity.tracks
      if (
        owner.session.identity.captureGeneration !== owner.generation ||
        owner.session.identity.routeId !== route.routeId ||
        owner.session.identity.model !== route.modelId ||
        owner.session.identity.language !== language ||
        sessionTracks.length !== owner.tracks.length ||
        owner.tracks.some((track, index) => sessionTracks[index]?.track !== track)
      ) {
        await owner.session.cancel()
        return failure('POLICY', identity)
      }
      const streamKeys = new Set(sessionTracks.map(({ track, streamEpoch }) => `${track}:${streamEpoch}`))
      if (
        owner.outputIntegrityFailure ||
        owner.pendingEvents.some(
          (item) =>
            item.type !== 'segment' || !streamKeys.has(`${item.segment.stream.track}:${item.segment.stream.epoch}`)
        )
      ) {
        await owner.session.cancel()
        return failure('TRANSPORT', identity)
      }
      for (const track of owner.tracks) owner.frontier.set(track, { nextSequence: 1, nextSampleOffset: null })
      owner.phase = 'active'
      const startResult = {
        ok: true,
        ...identity,
        engine,
        streams: sessionTracks.map(({ track, streamEpoch }) => ({ track, streamEpoch })),
        limits: {
          frameBytes: CLOUD_SPEECH_FULL_FRAME_BYTES,
          maxPendingFrames: CLOUD_SPEECH_MAX_PENDING_FRAMES,
          maxPendingBytes: CLOUD_SPEECH_MAX_PENDING_BYTES,
          maxPendingAudioMs: CLOUD_SPEECH_MAX_PENDING_AUDIO_MS
        }
      }
      const buffered = owner.pendingEvents
      owner.pendingEvents = []
      owner.pendingEventBytes = 0
      for (const item of buffered) sendEvent(owner, item)
      if (current !== owner || owner.phase !== 'active') return failure('CLOSED', identity)
      armCaptureCeiling(owner)
      if (owner.finishAfterRotation === null) armRotation(owner)
      const parsedStart = CloudSpeechStartResultSchema.safeParse(startResult)
      return parsedStart.success ? parsedStart.data : failure('TRANSPORT', identity)
    } catch {
      return failure('TRANSPORT', identity)
    } finally {
      owner.startSettled = true
      if (!owner.allocationAttempted) owner.closureConfirmed = true
      if (owner.phase !== 'active' && owner.phase !== 'finishing') {
        owner.pendingEvents = []
        owner.pendingEventBytes = 0
      }
      if (owner.phase === 'starting' && current === owner) {
        owner.phase = 'closed'
        if (!owner.allocationAttempted) owner.closureConfirmed = true
        current = null
      }
      if (owner.phase === 'cancelled' && !owner.allocationAttempted) {
        owner.phase = 'closed'
        owner.closureConfirmed = true
      }
      if (owner.phase === 'closed' && owner.closureConfirmed === true) releaseCaptureOwner(owner)
    }
  }

  const handle = createIpcHandlerRegistrar(options.ipcMain)

  handle(CLOUD_SPEECH_IPC.capability, async (event) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return refusedCapability('AUTH')
    const preparationGeneration = ++capabilityPreparationGeneration
    try {
      await options.prepareAuthority?.(event)
    } catch {
      return refusedCapability('POLICY')
    }
    if (preparationGeneration !== capabilityPreparationGeneration || !sameBinding(binding))
      return refusedCapability('STALE')
    let authority: Authority
    try {
      authority = options.readAuthority(event)
    } catch {
      return refusedCapability('POLICY')
    }
    if (!authority.enabled || !authority.authenticated || !authority.policyReady || !authorityRevision(authority))
      return toSafeCapability(authority, null)
    try {
      const client = makeClient(authority.credentials!)
      const result = await client.capability()
      if (!sameBinding(binding)) return refusedCapability('STALE')
      const latest = options.readAuthority(event)
      if (authorityRevision(latest) !== authorityRevision(authority)) return refusedCapability('POLICY')
      const capability = toSafeCapability(latest, result, now())
      const parsed = CloudSpeechCapabilitySchema.safeParse(capability)
      return parsed.success ? parsed.data : refusedCapability('TRANSPORT')
    } catch {
      return refusedCapability('TRANSPORT')
    }
  })
  handle(CLOUD_SPEECH_IPC.start, safeStart)
  handle(CLOUD_SPEECH_IPC.frame, async (event, raw) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechFrameSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const frame = parsed.data
    const owner = ownerFor({ captureId: frame.captureId, captureGeneration: frame.captureGeneration })
    const identity = { captureId: frame.captureId, captureGeneration: frame.captureGeneration }
    if (
      !owner ||
      current !== owner ||
      (owner.phase !== 'active' && owner.phase !== 'rotating') ||
      owner.finishAfterRotation !== null ||
      owner.ceilingAcked ||
      owner.binding.sender !== binding.sender ||
      owner.binding.frame !== binding.frame
    )
      return failure('STALE')
    if (!acceptingInput || !currentAuthority(owner, true)) {
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
      if (owner.phase === 'active') startCaptureCeiling(owner)
      return failure('ORDER', identity)
    }
    const pcm16le = new Uint8Array(frame.pcm16le.byteLength)
    pcm16le.set(new Uint8Array(frame.pcm16le))
    const activeSession = owner.session
    if (owner.phase === 'active' && activeSession) {
      const cutoffAt =
        activeSession.identity.audioDeadlineAt - Math.min(activeSession.identity.limits.drainWindowMs, 5_000)
      if (now() >= cutoffAt) void rotate(owner)
    }
    if (owner.phase !== 'rotating' && owner.phase !== 'active') return failure('TIMEOUT', identity)
    if (owner.phase === 'rotating') {
      if (!owner.preflightBinding || !owner.captureSession) {
        failRotation(owner)
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
          () => failRotation(owner)
        )
        if (!reserved) {
          resolve(failure('QUEUE_LIMIT', identity))
          failRotation(owner)
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
    if (nextSampleOffset === CLOUD_SPEECH_CAPTURE_MAX_SAMPLES) startCaptureCeiling(owner)
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
  })
  handle(CLOUD_SPEECH_IPC.transitionAck, (event, raw) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechEpochTransitionAckSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const ack = parsed.data
    const owner = ownerFor(ack)
    if (!owner || current !== owner || owner.binding.sender !== binding.sender || owner.binding.frame !== binding.frame)
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
  })
  const finishCapture = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, options.assertMainWindow)
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
        failRotation(owner)
        return failure('ORDER', identity)
      }
      owner.finishAfterRotation = request
      await owner.rotationPromise
      if (current !== owner || (owner.phase as Owner['phase']) !== 'active') return failure('TRANSPORT', identity)
      owner.finishAfterRotation = null
      return finishCapture(event, request)
    }
    if (owner.phase === 'starting') return failure('CLOSED', identity)
    const checkpoint = JSON.stringify(request.tracks)
    if (owner.finishPromise) {
      if (owner.finishCheckpoint !== checkpoint) return failure('ORDER', identity)
      return currentAuthority(owner, false) ? owner.finishPromise : failure('POLICY', identity)
    }
    if (current !== owner) return failure('STALE', identity)
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
      if (current !== owner || !sameBinding(owner.binding)) return failure('STALE', identity)
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
        if (current === owner) current = null
        return failure('TRANSPORT', identity)
      }
      setTerminal(owner, result.tracks)
      owner.phase = 'closed'
      owner.closureConfirmed =
        result.tracks.length === owner.tracks.length && result.tracks.every((track) => track.closeConfirmed)
      if (owner.closureConfirmed) releaseCaptureOwner(owner)
      if (current === owner) current = null
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
  handle(CLOUD_SPEECH_IPC.finish, finishCapture)
  handle(CLOUD_SPEECH_IPC.ceilingAck, async (event, raw) => {
    const binding = getBinding(event, options.assertMainWindow)
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
      current !== owner ||
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
    if (current !== owner || !currentAuthority(owner, false)) {
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
  })
  handle(CLOUD_SPEECH_IPC.cancel, async (event, raw) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechCancelRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const owner = ownerFor(parsed.data)
    if (!owner || owner.binding.sender !== binding.sender || owner.binding.frame !== binding.frame)
      return failure('STALE')
    const identity = identityOf(owner)
    const closure = await retire(owner)
    if (!sameBinding(binding) || ownerFor(identity) !== owner) return failure('STALE')
    const response = { ok: true as const, ...identity, closure }
    return CloudSpeechCancelResultSchema.safeParse(response).success ? response : failure('TRANSPORT', identity)
  })
  handle(CLOUD_SPEECH_IPC.status, async (event, raw) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechStatusRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const owner = ownerFor(parsed.data)
    if (!owner || owner.binding.sender !== binding.sender || owner.binding.frame !== binding.frame)
      return failure('STALE')
    const identity = identityOf(owner)
    if (!owner.allocationId || !owner.client) return { ok: true, ...identity, state: 'unknown', tracks: [] }
    const result = await owner.client
      .status(owner.allocationId, 1_000)
      .catch(() => ({ ok: false as const, code: 'TRANSPORT' as const }))
    if (!sameBinding(binding) || ownerFor(identity) !== owner) return failure('STALE')
    if (!result.ok || result.value.captureGeneration !== owner.generation) return failure('TRANSPORT', identity)
    const tracks = result.value.tracks.map((track) => ({
      stream: { generation: owner.generation, track: track.track, epoch: track.streamEpoch },
      phase:
        track.phase === 'closed'
          ? ('closed' as const)
          : track.phase === 'open'
            ? ('open' as const)
            : track.phase === 'ready' || track.phase === 'opening'
              ? ('connecting' as const)
              : ('closing' as const),
      lastSequence: track.lastSequence,
      closeConfirmed: track.closeConfirmed,
      tail: track.tail
    }))
    const trackInventoryValid =
      tracks.length === owner.tracks.length &&
      owner.tracks.every((track) => tracks.some((item) => item.stream.track === track))
    if (!trackInventoryValid) return failure('TRANSPORT', identity)
    const state =
      (result.value.status === 'cancelled' || result.value.status === 'expired') &&
      tracks.every((track) => track.closeConfirmed)
        ? 'closed'
        : tracks.some((track) => track.phase === 'closing' || track.phase === 'closed')
          ? 'closing'
          : 'active'
    const response = { ok: true as const, ...identity, state, tracks }
    return CloudSpeechStatusResultSchema.safeParse(response).success ? response : failure('TRANSPORT', identity)
  })

  const invalidateCurrent = (): void => {
    authorityPreparationGeneration += 1
    capabilityPreparationGeneration += 1
    acceptingInput = false
    if (current) void retire(current)
  }
  const closeInput = (): void => {
    acceptingInput = false
  }
  const shutdown = async (timeoutMs = 2_000): Promise<void> => {
    shuttingDown = true
    authorityPreparationGeneration += 1
    capabilityPreparationGeneration += 1
    acceptingInput = false
    if (current) current.phase = 'cancelled'
    const pending = [...owners.values()]
      .filter((owner) => owner.phase !== 'closed' || owner.closureConfirmed !== true)
      .map((owner) => retire(owner))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, Math.min(timeoutMs, 5_000)))
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    current = null
  }
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await shutdown()
    for (const channel of IPC_CHANNELS) {
      try {
        options.ipcMain.removeHandler(channel)
      } catch {
        /* continue cleanup */
      }
    }
  }
  return { closeInput, invalidateCurrent, shutdown, dispose }
}
