import {
  CloudSpeechFinishResultSchema,
  CloudSpeechStatusResultSchema,
  type CloudSpeechFinishResult,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'
import { cloudSpeechIdentityMatches } from './cloud-speech-results'

export function parseClosedSpeechRecovery(
  raw: unknown,
  request: CloudSpeechStartRequest,
  currentEpoch: (track: 'microphone' | 'system') => number | undefined
): CloudSpeechFinishResult | null {
  const parsed = CloudSpeechStatusResultSchema.safeParse(raw)
  if (
    !parsed.success ||
    !parsed.data.ok ||
    !cloudSpeechIdentityMatches(parsed.data, request) ||
    parsed.data.state !== 'closed'
  )
    return null
  const tracks = new Set(parsed.data.tracks.map((trackResult) => trackResult.stream.track))
  if (
    parsed.data.tracks.length !== request.capture.capturedTracks.length ||
    tracks.size !== parsed.data.tracks.length ||
    request.capture.capturedTracks.some((track) => !tracks.has(track)) ||
    parsed.data.tracks.some(
      (trackResult) =>
        !request.capture.capturedTracks.includes(trackResult.stream.track) ||
        currentEpoch(trackResult.stream.track) !== trackResult.stream.epoch
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
  return recovered.success && recovered.data.ok ? recovered.data : null
}
