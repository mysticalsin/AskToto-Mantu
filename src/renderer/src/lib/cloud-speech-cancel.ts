import {
  CloudSpeechCancelResultSchema,
  type CloudSpeechCancelRequest,
  type CloudSpeechCancelResult,
  type CloudSpeechFailure,
  type CloudSpeechStartRequest
} from '@shared/cloud-speech'
import { cloudSpeechIdentityMatches } from './cloud-speech-results'

export function createCloudSpeechCancellation(options: {
  request: CloudSpeechStartRequest
  bridge: { cloudSpeechCancel(identity: CloudSpeechCancelRequest): Promise<unknown> }
  now(): number
  isStarted(): boolean
  bounded<T>(operation: Promise<T>, deadline: number, timeoutValue: T): Promise<T>
  failure(code: CloudSpeechFailure['code'], request?: CloudSpeechStartRequest): CloudSpeechFailure
}) {
  let cancelPromise: Promise<CloudSpeechCancelResult> | null = null
  let cancelResult: CloudSpeechCancelResult | null = null
  let cancelWait: Promise<CloudSpeechCancelResult> | null = null
  let cancelDeadline: number | null = null
  const identity = () => ({
    captureId: options.request.captureId,
    captureGeneration: options.request.capture.generation
  })

  const cancelRequestedIdentity = async (deadline: number): Promise<void> => {
    try {
      await waitForCancel(deadline, true)
    } catch {
      // Cleanup is best effort; never replace the original start failure.
    }
  }

  const dispatchCancel = (): Promise<CloudSpeechCancelResult> => {
    if (cancelPromise) return cancelPromise
    let pending: Promise<unknown>
    try {
      pending = options.bridge.cloudSpeechCancel(identity())
    } catch {
      cancelResult = options.failure('TRANSPORT', options.request)
      cancelPromise = Promise.resolve(cancelResult)
      return cancelPromise
    }
    cancelPromise = Promise.resolve(pending).then(
      (result) => {
        const parsed = CloudSpeechCancelResultSchema.safeParse(result)
        const settledResult =
          parsed.success && (!parsed.data.ok || cloudSpeechIdentityMatches(parsed.data, options.request))
            ? parsed.data
            : options.failure('TRANSPORT', options.request)
        cancelResult = settledResult
        return settledResult
      },
      () => {
        const settledResult = options.failure('TRANSPORT', options.request)
        cancelResult = settledResult
        return settledResult
      }
    )
    return cancelPromise
  }

  const waitForCancel = (deadline: number, allowUnstarted: boolean): Promise<CloudSpeechCancelResult> => {
    if (!allowUnstarted && !options.isStarted() && cancelPromise === null)
      return Promise.resolve(options.failure('CLOSED', options.request))
    cancelDeadline = cancelDeadline === null ? deadline : Math.min(cancelDeadline, deadline)
    const boundedDeadline = cancelDeadline
    const operation = cancelPromise ?? dispatchCancel()
    return options.bounded(operation, boundedDeadline, options.failure('TIMEOUT', options.request))
  }

  const cancelBridgeWithin = (deadline: number): Promise<CloudSpeechCancelResult> => waitForCancel(deadline, false)

  const cancel = (deadline: number): Promise<CloudSpeechCancelResult> => {
    if (cancelWait) return cancelWait
    cancelWait = cancelBridgeWithin(deadline)
    return cancelWait
  }

  return {
    cancelRequestedIdentity,
    cancelBridgeWithin,
    cancel,
    hasPending: () => cancelPromise !== null && cancelResult === null
  }
}
