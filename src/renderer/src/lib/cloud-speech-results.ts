import {
  CloudSpeechEventSchema,
  type CloudSpeechEvent,
  type CloudSpeechFailure,
  type CloudSpeechStartRequest,
  type CloudSpeechStartResult,
  type CloudSpeechFinishResult,
  type CloudSpeechEpochTransitionEvent
} from '@shared/cloud-speech'
import type { SpeechStreamRef, Track } from '@shared/contracts/speech'

export const MAX_PENDING_RESULT_APPLICATIONS = 64

type RevisionState = { revision: number; final: boolean }

export function cloudSpeechFailure(
  code: CloudSpeechFailure['code'],
  request?: CloudSpeechStartRequest
): CloudSpeechFailure {
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

export function cloudSpeechIdentityMatches(
  value: { captureId: string; captureGeneration: number },
  request: CloudSpeechStartRequest
): boolean {
  return value.captureId === request.captureId && value.captureGeneration === request.capture.generation
}

export function speechStreamKey(stream: Pick<SpeechStreamRef, 'track' | 'epoch'>): string {
  return `${stream.track}:${stream.epoch}`
}

export function createCloudSpeechResultTracker(request: CloudSpeechStartRequest) {
  const streams = new Map<Track, number>()
  const revisions = new Map<string, RevisionState>()
  const seenSequences = new Map<string, number>()
  const appliedSequences = new Map<string, number>()
  const expectedFrontiers = new Map<string, number>()
  const terminalStreams = new Set<string>()
  const terminalStates = new Map<string, { closeConfirmed: boolean; complete: boolean }>()
  const appliedTerminals = new Set<string>()
  let pendingTransition: Extract<CloudSpeechEpochTransitionEvent, { stage: 'closed' }> | null = null
  let unfinalizedSealedStream = false

  const pruneSealedOldEpochs = (): void => {
    for (const key of [...terminalStreams]) {
      const separator = key.lastIndexOf(':')
      const track = key.slice(0, separator) as Track
      const epoch = Number(key.slice(separator + 1))
      if ((streams.get(track) ?? 0) <= epoch) continue
      if ((appliedSequences.get(key) ?? 0) < (seenSequences.get(key) ?? 0)) continue
      const revisionPrefix = `${request.captureId}:${request.capture.generation}:${track}:${epoch}:`
      for (const [revisionKey, revision] of revisions) {
        if (!revisionKey.startsWith(revisionPrefix)) continue
        if (!revision.final) unfinalizedSealedStream = true
        revisions.delete(revisionKey)
      }
      terminalStreams.delete(key)
      terminalStates.delete(key)
      appliedTerminals.delete(key)
      seenSequences.delete(key)
      appliedSequences.delete(key)
      expectedFrontiers.delete(key)
    }
  }
  const hasUnfinalizedRevisions = (): boolean =>
    unfinalizedSealedStream || [...revisions.values()].some((revision) => !revision.final)

  const parse = (raw: unknown): CloudSpeechEvent | null => {
    const parsed = CloudSpeechEventSchema.safeParse(raw)
    if (!parsed.success || !cloudSpeechIdentityMatches(parsed.data, request)) return null
    return parsed.data
  }

  const admit = (event: CloudSpeechEvent, engine: string): boolean => {
    if (event.type === 'epoch-transition' || event.type === 'capture-ceiling') return true
    const stream = event.type === 'terminal' ? event.stream : event.segment.stream
    const currentEpoch = streams.get(stream.track)
    if (currentEpoch === undefined || stream.epoch !== currentEpoch) return false
    if (event.type === 'terminal') {
      const key = speechStreamKey(event.stream)
      if (terminalStreams.has(key) || event.lastSequence !== (seenSequences.get(key) ?? 0)) return false
      terminalStreams.add(key)
      terminalStates.set(key, { closeConfirmed: event.closeConfirmed, complete: event.tail === 'complete' })
      return true
    }

    if (!request.capture.capturedTracks.includes(stream.track) || event.segment.engine !== engine) return false
    const key = speechStreamKey(stream)
    if (terminalStreams.has(key)) return false
    const previousSequence = seenSequences.get(key) ?? 0
    if (
      event.sequence !== previousSequence + 1 ||
      (expectedFrontiers.has(key) && event.sequence > (expectedFrontiers.get(key) ?? 0))
    )
      return false
    const revisionKey = `${request.captureId}:${request.capture.generation}:${stream.track}:${stream.epoch}:${event.segment.index}`
    const previousRevision = revisions.get(revisionKey)
    if (
      (previousRevision && previousRevision.final) ||
      (previousRevision && event.segment.revision !== previousRevision.revision + 1) ||
      (!previousRevision && event.segment.revision !== 1)
    )
      return false
    seenSequences.set(key, event.sequence)
    revisions.set(revisionKey, { revision: event.segment.revision, final: event.segment.final })
    return true
  }

  return {
    initialize(result: Extract<CloudSpeechStartResult, { ok: true }>): void {
      for (const stream of result.streams) streams.set(stream.track, stream.streamEpoch)
    },

    currentEpoch(track: Track): number | undefined {
      return streams.get(track)
    },

    key: speechStreamKey,

    seenSequence(stream: SpeechStreamRef): number {
      return seenSequences.get(speechStreamKey(stream)) ?? 0
    },

    parse,

    admit,

    validate(raw: unknown, engine: string): CloudSpeechEvent | null {
      const event = parse(raw)
      return event && admit(event, engine) ? event : null
    },

    markApplied(stream: SpeechStreamRef, sequence: number): void {
      appliedSequences.set(speechStreamKey(stream), sequence)
      pruneSealedOldEpochs()
    },

    markTerminalApplied(stream: SpeechStreamRef): void {
      appliedTerminals.add(speechStreamKey(stream))
    },

    validateTransition(event: Extract<CloudSpeechEpochTransitionEvent, { stage: 'closed' | 'opened' }>): boolean {
      const expectedTracks = request.capture.capturedTracks
      if (
        event.streams.length !== expectedTracks.length ||
        expectedTracks.some((track, index) => event.streams[index]?.track !== track)
      )
        return false
      if (event.stage === 'closed') {
        if (pendingTransition) return false
        return event.streams.every((item) => {
          const key = `${item.track}:${item.previousEpoch}`
          return (
            streams.get(item.track) === item.previousEpoch &&
            terminalStreams.has(key) &&
            terminalStates.get(key)?.closeConfirmed === true &&
            terminalStates.get(key)?.complete === true &&
            appliedTerminals.has(key) &&
            (seenSequences.get(key) ?? 0) === item.lastSequence &&
            (appliedSequences.get(key) ?? 0) === item.lastSequence &&
            !hasUnfinalizedRevisions()
          )
        })
      }
      const closed = pendingTransition
      return Boolean(
        closed &&
          closed.transitionId === event.transitionId &&
          closed.handoffNonce === event.handoffNonce &&
          closed.captureId === event.captureId &&
          closed.captureGeneration === event.captureGeneration &&
          event.streams.every((item, index) => {
            const previous = closed.streams[index]
            return (
              previous?.track === item.track &&
              previous.previousEpoch === item.previousEpoch &&
              previous.lastSequence === item.lastSequence &&
              streams.get(item.track) === item.previousEpoch &&
              item.nextEpoch > item.previousEpoch
            )
          })
      )
    },

    installTransition(event: Extract<CloudSpeechEpochTransitionEvent, { stage: 'closed' | 'opened' }>): void {
      if (event.stage === 'closed') {
        pendingTransition = event
        return
      }
      for (const item of event.streams) streams.set(item.track, item.nextEpoch)
      pendingTransition = null
      pruneSealedOldEpochs()
    },

    appliedThrough(result: Extract<CloudSpeechFinishResult, { ok: true }>): boolean {
      return result.tracks.every(
        (track) => (appliedSequences.get(speechStreamKey(track.stream)) ?? 0) >= track.lastSequence
      )
    },

    prepareFinish(result: Extract<CloudSpeechFinishResult, { ok: true }>): boolean {
      expectedFrontiers.clear()
      for (const track of result.tracks) {
        const key = speechStreamKey(track.stream)
        if ((seenSequences.get(key) ?? 0) > track.lastSequence) return false
        expectedFrontiers.set(key, track.lastSequence)
      }
      if (result.complete && hasUnfinalizedRevisions()) return false
      return true
    },

    hasUnfinalizedRevisions
  }
}
