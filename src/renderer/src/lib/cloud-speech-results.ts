import {
  CloudSpeechEventSchema,
  type CloudSpeechEvent,
  type CloudSpeechFailure,
  type CloudSpeechStartRequest,
  type CloudSpeechStartResult,
  type CloudSpeechFinishResult
} from '@shared/cloud-speech'
import type { SpeechStreamRef, Track } from '@shared/contracts/speech'

export const MAX_PENDING_RESULT_APPLICATIONS = 128

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
      seenSequences.delete(key)
      appliedSequences.delete(key)
      expectedFrontiers.delete(key)
    }
  }
  const hasUnfinalizedRevisions = (): boolean =>
    unfinalizedSealedStream || [...revisions.values()].some((revision) => !revision.final)

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

    validate(raw: unknown, engine: string): CloudSpeechEvent | null {
      const parsed = CloudSpeechEventSchema.safeParse(raw)
      if (!parsed.success || !cloudSpeechIdentityMatches(parsed.data, request)) return null
      const event = parsed.data
      const stream = event.type === 'terminal' ? event.stream : event.segment.stream
      const currentEpoch = streams.get(stream.track)
      if (currentEpoch === undefined || stream.epoch < currentEpoch) return null
      if (stream.epoch > currentEpoch) {
        const priorKey = `${stream.track}:${currentEpoch}`
        if (stream.epoch !== currentEpoch + 1 || !terminalStreams.has(priorKey)) return null
        streams.set(stream.track, stream.epoch)
        pruneSealedOldEpochs()
      }
      if (event.type === 'terminal') {
        const key = speechStreamKey(event.stream)
        if (terminalStreams.has(key) || event.lastSequence !== (seenSequences.get(key) ?? 0)) return null
        terminalStreams.add(key)
        return event
      }

      if (!request.capture.capturedTracks.includes(stream.track) || event.segment.engine !== engine) return null
      const key = speechStreamKey(stream)
      if (terminalStreams.has(key)) return null
      const previousSequence = seenSequences.get(key) ?? 0
      if (
        event.sequence !== previousSequence + 1 ||
        (expectedFrontiers.has(key) && event.sequence > (expectedFrontiers.get(key) ?? 0))
      )
        return null
      const revisionKey = `${request.captureId}:${request.capture.generation}:${stream.track}:${stream.epoch}:${event.segment.index}`
      const previousRevision = revisions.get(revisionKey)
      if (
        (previousRevision && previousRevision.final) ||
        (previousRevision && event.segment.revision !== previousRevision.revision + 1) ||
        (!previousRevision && event.segment.revision !== 1)
      )
        return null
      seenSequences.set(key, event.sequence)
      revisions.set(revisionKey, { revision: event.segment.revision, final: event.segment.final })
      return event
    },

    markApplied(stream: SpeechStreamRef, sequence: number): void {
      appliedSequences.set(speechStreamKey(stream), sequence)
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
