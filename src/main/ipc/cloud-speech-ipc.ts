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
  CloudSpeechStartRequestSchema,
  CloudSpeechStartResultSchema,
  CloudSpeechStatusRequestSchema,
  CloudSpeechStatusResultSchema,
  type CloudSpeechEngine,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'
import { sttResolvedIdentity } from '@shared/contracts/stt-provider'
import {
  SpeechBrokerClient,
  type SpeechBrokerClientOptions,
  type SpeechBrokerOperation,
  type SpeechTrack
} from '../cloud-stt/broker-client'
import { RelaySpeechSession, type RelaySpeechSessionOptions, type RelayTrackClosure } from '../cloud-stt/relay-session'
import { CLOUD_SPEECH_CAPTURE_MAX_MS, MainSpeechCaptureSession } from '../cloud-stt/capture-session'
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
  identityOf,
  getBinding,
  identityKey,
  mapBrokerFailure,
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
import type { CloudSpeechIpcState } from './cloud-speech-ipc-context'
import { createCaptureLifecycle } from './cloud-speech-capture-lifecycle'
import { createCaptureHandlers } from './cloud-speech-capture-handlers'

export type { CloudSpeechMainAuthority, CloudSpeechIpcOptions } from './cloud-speech-ipc-support'
export type CloudSpeechIpcRegistration = {
  closeInput: () => void
  invalidateCurrent: () => void
  ownerCount: () => number
  shutdown: (timeoutMs?: number) => Promise<void>
  dispose: () => Promise<void>
}

export function registerCloudSpeechIpc(options: CloudSpeechIpcOptions): CloudSpeechIpcRegistration {
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const makeClient =
    options.clientFactory ?? ((credentials: SpeechBrokerClientOptions) => new SpeechBrokerClient(credentials))
  const state: CloudSpeechIpcState = {
    current: null,
    owners: new Map<string, Owner>(),
    acceptingInput: true,
    shuttingDown: false,
    authorityPreparationGeneration: 0,
    capabilityPreparationGeneration: 0,
    disposed: false
  }

  const currentAuthority = (owner: Owner, requireCapture: boolean): Authority | null => {
    if (!sameBinding(owner.binding) || state.shuttingDown || (requireCapture && !state.acceptingInput)) return null
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

  const ownerFor = (identity: { captureId: string; captureGeneration: number }): Owner | null =>
    state.owners.get(identityKey(identity.captureId, identity.captureGeneration)) ?? null
  const releaseCaptureOwner = (owner: Owner): void => {
    if (owner.finishContextReleased || owner.closureConfirmed !== true) return
    owner.finishContextReleased = true
    try {
      options.releaseCaptureOwner?.(owner)
    } catch {
      /* A failed release cannot restore capture or invalidate a completed main-owned closure. */
    }
  }

  const queryClosure = async (owner: Owner): Promise<'confirmed' | 'unknown'> => {
    const statusFor = async (
      sessionId: string | null
    ): Promise<{ closed: boolean; tracks: RelayTrackClosure[] } | null> => {
      if (!sessionId || !owner.client) return null
      const status = await owner.client.status(sessionId, 1_000).catch(() => null)
      if (!status?.ok || status.value.captureGeneration !== owner.generation) return null
      const tracks = status.value.tracks
      if (
        !validTrackList(tracks.map((track) => track.track)) ||
        tracks.length !== owner.tracks.length ||
        owner.tracks.some((track) => !tracks.some((item) => item.track === track)) ||
        tracks.some((track) => !track.closeConfirmed)
      )
        return null
      return {
        closed: status.value.status === 'cancelled' || status.value.status === 'expired',
        tracks: tracks.map((track) => ({
          track: track.track,
          streamEpoch: track.streamEpoch,
          closeConfirmed: track.closeConfirmed,
          tail: track.tail ?? 'incomplete',
          lastSequence: track.lastSequence,
          reason: status.value.status === 'expired' ? 'lease-expired' : 'cancelled'
        }))
      }
    }
    const obligations = [owner.primaryAllocation, owner.candidateAllocation].filter(
      (allocation): allocation is NonNullable<typeof allocation> => allocation !== null && allocation.attempted
    )
    const allocations: Array<Promise<{ closed: boolean; tracks: RelayTrackClosure[] } | null>> = obligations.map(
      (allocation) => statusFor(allocation.sessionId)
    )
    if (allocations.length === 0) {
      const confirmed = owner.startSettled
      if (confirmed) {
        owner.closureConfirmed = true
        owner.phase = 'closed'
        releaseCaptureOwner(owner)
      }
      return confirmed ? 'confirmed' : 'unknown'
    }
    const closures = await Promise.all(allocations)
    if (closures.some((closure) => !closure?.closed)) return 'unknown'
    const terminal = closures.find((closure) => closure !== null)?.tracks ?? []
    owner.closureConfirmed = true
    owner.phase = 'closed'
    if (terminal.length > 0) lifecycle.setTerminal(owner, terminal)
    releaseCaptureOwner(owner)
    return 'confirmed'
  }

  const retire = async (owner: Owner): Promise<'confirmed' | 'unknown'> => {
    if (owner.phase === 'closed') {
      if (owner.closureConfirmed === true) releaseCaptureOwner(owner)
      return owner.closureConfirmed === true ? 'confirmed' : queryClosure(owner)
    }
    if (state.current === owner) state.authorityPreparationGeneration += 1
    owner.cancelRotationSchedule?.()
    owner.cancelRotationSchedule = null
    owner.cancelCeilingSchedule?.()
    owner.cancelCeilingSchedule = null
    owner.rotationAbort?.abort()
    owner.captureSession?.invalidate('cancelled', failure('CLOSED', identityOf(owner)))
    owner.phase = 'cancelled'
    if (state.current === owner) state.current = null
    if (owner.candidateSession) await owner.candidateSession.cancel().catch(() => undefined)
    else if (owner.candidateAllocation?.sessionId && owner.client)
      await owner.client.cancel(owner.candidateAllocation.sessionId, 1_000).catch(() => undefined)
    if (owner.session) {
      await owner.session.cancel().catch(() => undefined)
      return queryClosure(owner)
    }
    if (!owner.primaryAllocation.attempted && !owner.candidateAllocation?.attempted) {
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

  const lifecycle = createCaptureLifecycle({
    state,
    now,
    monotonicNow,
    schedule: options.scheduleCaptureDeadline ?? scheduleCaptureDeadline,
    ...(options.prepareAuthority ? { prepareAuthority: options.prepareAuthority } : {}),
    ...(options.onSegmentDelivered ? { onDelivered: options.onSegmentDelivered } : {}),
    currentAuthority,
    retire
  })

  const safeStart = async (event: SpeechIpcEvent, raw: unknown): Promise<unknown> => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return failure('AUTH')
    const parsed = CloudSpeechStartRequestSchema.safeParse(raw)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data
    const identity = { captureId: request.captureId, captureGeneration: request.capture.generation }
    if (state.owners.has(identityKey(identity.captureId, identity.captureGeneration))) return failure('STALE', identity)
    if (state.shuttingDown) return failure('CLOSED', identity)
    // A new explicit, currently authorized Start reopens admission after a prior normal Stop.
    state.acceptingInput = true
    if (request.consent.disclosureVersion !== CLOUD_SPEECH_DISCLOSURE_VERSION) return failure('CONSENT', identity)
    const engine = request.capture.engine as CloudSpeechEngine
    if (!validTrackList(request.capture.capturedTracks as SpeechTrack[])) return failure('INVALID_REQUEST', identity)

    for (const [key, candidate] of state.owners) {
      if (candidate.phase === 'closed' && candidate.closureConfirmed === true && candidate.startSettled)
        state.owners.delete(key)
    }
    if (state.owners.size >= 2) return failure('CLOSURE_UNCONFIRMED', identity)
    const prior = state.current
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
      primaryAllocation: { attempted: false, sessionId: null },
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
      targetLanguage: null,
      rotationDeadlineAt: null,
      candidateAllocation: null,
      candidatePendingEvents: [],
      candidateEventBytes: 0,
      candidateEventFrontier: new Map(),
      finishAfterRotation: null,
      event,
      request
    }
    // Synchronous ownership precedes retirement/capability awaits so stop and replacement can tombstone this start.
    state.current = owner
    state.owners.set(identityKey(owner.captureId, owner.generation), owner)
    let preparationGeneration = state.authorityPreparationGeneration
    const predecessors = [...state.owners.values()].filter(
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
        if (state.current === owner) state.current = null
        return failure('CLOSURE_UNCONFIRMED', identity)
      }
    }
    preparationGeneration = ++state.authorityPreparationGeneration
    try {
      try {
        await options.prepareAuthority?.(event, request)
      } catch {
        return failure('POLICY', identity)
      }
      if (
        state.authorityPreparationGeneration !== preparationGeneration ||
        state.current !== owner ||
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
      if (state.current !== owner || !currentAuthority(owner, true)) return failure('CLOSED', identity)
      const capability = await client.capability()
      if (state.current !== owner || !currentAuthority(owner, true)) return failure('CLOSED', identity)
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
        client: bindCreateToCapability(
          client,
          // Start language until allocated; then a user language change's approved target, else the live session's.
          () => ({
            ...binding,
            language: owner.targetLanguage ?? owner.session?.identity.language ?? binding.language
          }),
          (id, slot) => {
            slot.attempted = true
            slot.sessionId = id
          },
          () => {
            const slot = owner.rotationPromise ? owner.candidateAllocation : owner.primaryAllocation
            const obligation = slot ?? owner.primaryAllocation
            obligation.attempted = true
            return obligation
          }
        ),
        createRequest,
        expectedSelection: { routeId: route.routeId, modelId: route.modelId, language },
        isCurrent: () => {
          if (state.current !== owner) return false
          if (owner.phase === 'starting') return currentAuthority(owner, true) !== null
          return (
            (owner.phase === 'active' || owner.phase === 'rotating' || owner.phase === 'finishing') &&
            currentAuthority(owner, false) !== null
          )
        },
        onAllocated: (id) => {
          const allocation = owner.candidateAllocation ?? owner.primaryAllocation
          allocation.attempted = true
          allocation.sessionId = id
        },
        onTranscript: (transcript, context) => lifecycle.makeRelayTranscript(owner, transcript, context)
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
      if (state.current !== owner || !currentAuthority(owner, true)) {
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
        // One identity per request: the engine, the licensed seat (hashed, shortened) and the route's model.
        resolvedIdentity: sttResolvedIdentity({
          provider: engine,
          transport: 'broker-v1',
          account: `operator-seat:${authority.credentials.deviceIdHash.slice(0, 12)}`
        }),
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
      for (const item of buffered) lifecycle.sendEvent(owner, item)
      if (state.current !== owner || owner.phase !== 'active') return failure('CLOSED', identity)
      lifecycle.armCaptureCeiling(owner)
      if (owner.finishAfterRotation === null) lifecycle.armRotation(owner)
      const parsedStart = CloudSpeechStartResultSchema.safeParse(startResult)
      return parsedStart.success ? parsedStart.data : failure('TRANSPORT', identity)
    } catch {
      return failure('TRANSPORT', identity)
    } finally {
      owner.startSettled = true
      if (!owner.primaryAllocation.attempted && !owner.candidateAllocation?.attempted) owner.closureConfirmed = true
      if (owner.phase !== 'active' && owner.phase !== 'finishing') {
        owner.pendingEvents = []
        owner.pendingEventBytes = 0
      }
      if (owner.phase === 'starting' && state.current === owner) {
        owner.phase = 'closed'
        if (!owner.primaryAllocation.attempted && !owner.candidateAllocation?.attempted) owner.closureConfirmed = true
        state.current = null
      }
      if (owner.phase === 'cancelled' && !owner.primaryAllocation.attempted && !owner.candidateAllocation?.attempted) {
        owner.phase = 'closed'
        owner.closureConfirmed = true
      }
      if (owner.phase === 'closed' && owner.closureConfirmed === true) releaseCaptureOwner(owner)
    }
  }

  const handle = createIpcHandlerRegistrar(options.ipcMain)

  const captureHandlers = createCaptureHandlers({
    state,
    now,
    monotonicNow,
    assertMainWindow: options.assertMainWindow,
    ownerFor,
    currentAuthority,
    retire,
    clearCurrentIf: (owner) => {
      if (state.current === owner) state.current = null
    },
    releaseCaptureOwner,
    lifecycle,
    ...(options.onLanguageChange ? { onLanguageChange: options.onLanguageChange } : {})
  })
  handle(CLOUD_SPEECH_IPC.frame, captureHandlers.frame)
  handle(CLOUD_SPEECH_IPC.transitionAck, captureHandlers.transitionAck)
  handle(CLOUD_SPEECH_IPC.finish, captureHandlers.finishCapture)
  handle(CLOUD_SPEECH_IPC.ceilingAck, captureHandlers.ceilingAck)
  handle(CLOUD_SPEECH_IPC.language, captureHandlers.changeLanguage)

  handle(CLOUD_SPEECH_IPC.capability, async (event) => {
    const binding = getBinding(event, options.assertMainWindow)
    if (!binding) return refusedCapability('AUTH')
    const preparationGeneration = ++state.capabilityPreparationGeneration
    try {
      await options.prepareAuthority?.(event)
    } catch {
      return refusedCapability('POLICY')
    }
    if (preparationGeneration !== state.capabilityPreparationGeneration || !sameBinding(binding))
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
    if (owner.phase === 'rotating' || owner.candidateAllocation?.attempted)
      return { ok: true, ...identity, state: 'unknown', tracks: [] }
    if (!owner.primaryAllocation.sessionId || !owner.client)
      return { ok: true, ...identity, state: 'unknown', tracks: [] }
    const result = await owner.client
      .status(owner.primaryAllocation.sessionId, 1_000)
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
    state.authorityPreparationGeneration += 1
    state.capabilityPreparationGeneration += 1
    state.acceptingInput = false
    if (state.current) void retire(state.current)
  }
  const closeInput = (): void => {
    state.acceptingInput = false
  }
  const shutdown = async (timeoutMs = 2_000): Promise<void> => {
    state.shuttingDown = true
    state.authorityPreparationGeneration += 1
    state.capabilityPreparationGeneration += 1
    state.acceptingInput = false
    if (state.current) state.current.phase = 'cancelled'
    const pending = [...state.owners.values()]
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
    state.current = null
  }
  const dispose = async (): Promise<void> => {
    if (state.disposed) return
    state.disposed = true
    await shutdown()
    for (const channel of IPC_CHANNELS) {
      try {
        options.ipcMain.removeHandler(channel)
      } catch {
        /* continue cleanup */
      }
    }
  }
  return { closeInput, invalidateCurrent, ownerCount: () => state.owners.size, shutdown, dispose }
}
