import {
  CloudSpeechEpochTransitionAckResultSchema,
  type CloudSpeechEpochTransitionAck,
  type CloudSpeechEpochTransitionEvent,
  type CloudSpeechFailure,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'

export function createCloudSpeechTransitionHandler(options: {
  request: CloudSpeechStartRequest
  bridge: {
    cloudSpeechAckEpochTransition(request: CloudSpeechEpochTransitionAck): Promise<unknown>
  }
  validate(event: CloudSpeechEpochTransitionEvent): boolean
  install(event: CloudSpeechEpochTransitionEvent): void
  deadline(): number
  timeoutFailure(): CloudSpeechFailure
  boundedCall<T>(operation: () => Promise<T>, deadline: number, timeoutValue: T): Promise<T>
  invalidate(code: CloudSpeechFailure['code']): void
}) {
  return async (event: CloudSpeechEpochTransitionEvent): Promise<void> => {
    if (!options.validate(event)) {
      options.invalidate('STALE')
      return
    }
    const request: CloudSpeechEpochTransitionAck = {
      type: 'epoch-transition-ack',
      captureId: event.captureId,
      captureGeneration: event.captureGeneration,
      transitionId: event.transitionId,
      handoffNonce: event.handoffNonce,
      stage: event.stage,
      streams: event.streams
    }
    let raw: unknown
    try {
      raw = await options.boundedCall(
        () => options.bridge.cloudSpeechAckEpochTransition(request),
        options.deadline(),
        options.timeoutFailure()
      )
    } catch {
      options.invalidate('TRANSPORT')
      return
    }
    const parsed = CloudSpeechEpochTransitionAckResultSchema.safeParse(raw)
    if (
      !parsed.success ||
      !parsed.data.ok ||
      parsed.data.captureId !== event.captureId ||
      parsed.data.captureGeneration !== event.captureGeneration ||
      parsed.data.transitionId !== event.transitionId ||
      parsed.data.handoffNonce !== event.handoffNonce ||
      parsed.data.stage !== event.stage
    ) {
      options.invalidate(parsed.success && !parsed.data.ok ? parsed.data.code : 'TRANSPORT')
      return
    }
    options.install(event)
  }
}
