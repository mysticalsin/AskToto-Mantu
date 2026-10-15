import {
  CloudSpeechCaptureCeilingAckResultSchema,
  CloudSpeechCaptureCeilingAckSchema,
  type CloudSpeechCaptureCeilingAck,
  type CloudSpeechCaptureCeilingEvent,
  type CloudSpeechFailure,
  type CloudSpeechFinishRequest
} from '@shared/cloud-speech'

export async function acknowledgeCaptureCeiling(options: {
  event: CloudSpeechCaptureCeilingEvent
  finishRequest: CloudSpeechFinishRequest
  bridge: { cloudSpeechAckCaptureCeiling(request: CloudSpeechCaptureCeilingAck): Promise<unknown> }
  deadline: number
  timeoutFailure: CloudSpeechFailure
  failure(code: CloudSpeechFailure['code']): CloudSpeechFailure
  boundedCall<T>(operation: () => Promise<T>, deadline: number, timeoutValue: T): Promise<T>
}): Promise<CloudSpeechFailure | null> {
  const ack: CloudSpeechCaptureCeilingAck = {
    type: 'capture-ceiling-ack',
    captureId: options.event.captureId,
    captureGeneration: options.event.captureGeneration,
    ceilingId: options.event.ceilingId,
    tracks: options.finishRequest.tracks
  }
  if (!CloudSpeechCaptureCeilingAckSchema.safeParse(ack).success) return options.failure('INVALID_REQUEST')

  let raw: unknown
  try {
    raw = await options.boundedCall(
      () => options.bridge.cloudSpeechAckCaptureCeiling(ack),
      options.deadline,
      options.timeoutFailure
    )
  } catch {
    return options.failure('TRANSPORT')
  }
  const result = CloudSpeechCaptureCeilingAckResultSchema.safeParse(raw)
  if (!result.success) return options.failure('TRANSPORT')
  if (!result.data.ok) return result.data
  if (
    result.data.captureId !== ack.captureId ||
    result.data.captureGeneration !== ack.captureGeneration ||
    result.data.ceilingId !== ack.ceilingId ||
    result.data.tracks.length !== ack.tracks.length ||
    result.data.tracks.some(
      (track, index) =>
        track.track !== ack.tracks[index]?.track ||
        track.finalSequence !== ack.tracks[index]?.finalSequence ||
        track.finalSampleOffset !== ack.tracks[index]?.finalSampleOffset
    )
  )
    return options.failure('TRANSPORT')
  return null
}
