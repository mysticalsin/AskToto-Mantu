import {
  CLOUD_SPEECH_DISCLOSURE_VERSION,
  CLOUD_SPEECH_FULL_FRAME_BYTES,
  CLOUD_SPEECH_IPC,
  CLOUD_SPEECH_MAX_PENDING_AUDIO_MS,
  CLOUD_SPEECH_MAX_PENDING_BYTES,
  CLOUD_SPEECH_MAX_PENDING_FRAMES,
  CloudSpeechCancelResultSchema,
  CloudSpeechCancelRequestSchema,
  CloudSpeechCapabilitySchema,
  CloudSpeechEventSchema,
  CloudSpeechFinishRequestSchema,
  CloudSpeechFrameSchema,
  CloudSpeechFrameResultSchema,
  CloudSpeechFinishResultSchema,
  CloudSpeechStartRequestSchema,
  CloudSpeechStartResultSchema,
  CloudSpeechStatusRequestSchema,
  CloudSpeechStatusResultSchema,
  type CloudSpeechEngine,
  type CloudSpeechFailure,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'
import { SpeechBrokerClient, type SpeechBrokerClientOptions, type SpeechTrack } from '../cloud-stt/broker-client'
import { RelaySpeechSession, type RelaySpeechSessionOptions } from '../cloud-stt/relay-session'
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
  const makeClient =
    options.clientFactory ?? ((credentials: SpeechBrokerClientOptions) => new SpeechBrokerClient(credentials))
  let current: Owner | null = null
  const owners = new Map<string, Owner>()
  let acceptingInput = true
  let shuttingDown = false

  const currentAuthority = (owner: Owner, requireCapture: boolean): Authority | null => {
    if (!sameBinding(owner.binding) || shuttingDown || (requireCapture && !acceptingInput)) return null
    try {
      const latest = options.readAuthority(owner.event, owner.request)
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
    const previousSequence = owner.eventFrontier.get(key) ?? 0
    const expectedStreams = owner.session?.identity.tracks
    if (
      (expectedStreams &&
        !expectedStreams.some(
          (stream) => stream.track === transcript.track && stream.streamEpoch === transcript.streamEpoch
        )) ||
      transcript.sequence !== previousSequence + 1
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
    if (sendEvent(owner, event)) owner.eventFrontier.set(key, transcript.sequence)
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

  const queryClosure = async (owner: Owner): Promise<'confirmed' | 'unknown'> => {
    if (!owner.allocationId) return owner.allocationAttempted ? 'unknown' : owner.startSettled ? 'confirmed' : 'unknown'
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
    }
    return confirmed ? 'confirmed' : 'unknown'
  }

  const retire = async (owner: Owner): Promise<'confirmed' | 'unknown'> => {
    if (owner.phase === 'closed') return owner.closureConfirmed === true ? 'confirmed' : queryClosure(owner)
    owner.phase = 'cancelled'
    if (current === owner) current = null
    if (owner.session) {
      await owner.session.cancel().catch(() => undefined)
      return queryClosure(owner)
    }
    if (!owner.allocationAttempted) {
      const confirmed = owner.startSettled
      if (confirmed) {
        owner.closureConfirmed = true
        owner.phase = 'closed'
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
    let authority: Authority
    try {
      authority = options.readAuthority(event, request)
    } catch {
      return failure('POLICY', identity)
    }
    if (!authority.enabled) return failure('DISABLED', identity)
    if (!authority.authenticated) return failure('AUTH', identity)
    if (!authority.policyReady) return failure('POLICY', identity)
    if (!authority.captureAllowed || shuttingDown) return failure('CLOSED', identity)
    // A new explicit, currently authorized Start reopens admission after a prior normal Stop.
    acceptingInput = true
    const stableRevision = authorityRevision(authority)
    if (!stableRevision) return failure('POLICY', identity)
    if (request.consent.disclosureVersion !== CLOUD_SPEECH_DISCLOSURE_VERSION) return failure('CONSENT', identity)
    const engine = request.capture.engine as CloudSpeechEngine
    const selected = routeFor(engine)
    if (authority.selectedEngine !== engine || !authority.allowedEngines.includes(engine))
      return failure('POLICY', identity)
    if (!validTrackList(request.capture.capturedTracks as SpeechTrack[])) return failure('INVALID_REQUEST', identity)
    if (request.language !== 'auto' && !authority.allowedLanguages.includes(request.language))
      return failure('POLICY', identity)
    if (!authority.credentials) return failure('NOT_CONFIGURED', identity)
    let client: SpeechBrokerClient
    try {
      client = makeClient(authority.credentials!)
    } catch {
      return failure('NOT_CONFIGURED', identity)
    }

    for (const [key, candidate] of owners) {
      if (candidate.phase === 'closed' && candidate.closureConfirmed === true && candidate.startSettled)
        owners.delete(key)
    }
    if (owners.size >= 2) return failure('CLOSURE_UNCONFIRMED', identity)
    const prior = current
    const owner: Owner = {
      binding,
      captureId: request.captureId,
      generation: request.capture.generation,
      engine,
      tracks: [...request.capture.capturedTracks] as SpeechTrack[],
      authorityRevision: stableRevision,
      client,
      phase: 'starting',
      allocationAttempted: false,
      allocationId: null,
      session: null,
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
      event,
      request
    }
    // Synchronous ownership precedes retirement/capability awaits so stop and replacement can tombstone this start.
    current = owner
    owners.set(identityKey(owner.captureId, owner.generation), owner)
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
    try {
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
          owner.allocationId = id
        }),
        createRequest,
        expectedSelection: { routeId: route.routeId, modelId: route.modelId, language },
        isCurrent: () => {
          if (current !== owner) return false
          if (owner.phase === 'starting') return currentAuthority(owner, true) !== null
          return (owner.phase === 'active' || owner.phase === 'finishing') && currentAuthority(owner, false) !== null
        },
        onAllocated: (id) => {
          owner.allocationId = id
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
    }
  }

  const handle = createIpcHandlerRegistrar(options.ipcMain)

  handle(CLOUD_SPEECH_IPC.capability, async (event) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return refusedCapability('AUTH')
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
  handle(CLOUD_SPEECH_IPC.frame, (event, raw) => {
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
      owner.phase !== 'active' ||
      owner.binding.sender !== binding.sender ||
      owner.binding.frame !== binding.frame
    )
      return failure('STALE')
    if (!acceptingInput || !currentAuthority(owner, true)) {
      void retire(owner)
      return failure('CLOSED', identity)
    }
    if (!owner.tracks.includes(frame.track)) return failure('INVALID_REQUEST', identity)
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
    const pcm16le = new Uint8Array(frame.pcm16le.byteLength)
    pcm16le.set(new Uint8Array(frame.pcm16le))
    const admitted = owner.session?.pushFrame(frame.track, {
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
  handle(CLOUD_SPEECH_IPC.finish, async (event, raw) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechFinishRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data
    const owner = ownerFor(request)
    const identity = { captureId: request.captureId, captureGeneration: request.captureGeneration }
    if (!owner || owner.binding.sender !== binding.sender || owner.binding.frame !== binding.frame)
      return failure('STALE')
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
    if (!owner.allocationId) return { ok: true, ...identity, state: 'unknown', tracks: [] }
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
    acceptingInput = false
    if (current) void retire(current)
  }
  const closeInput = (): void => {
    acceptingInput = false
  }
  const shutdown = async (timeoutMs = 2_000): Promise<void> => {
    shuttingDown = true
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
