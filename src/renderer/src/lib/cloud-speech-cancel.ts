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
  const identity = () => ({
    captureId: options.request.captureId,
    captureGeneration: options.request.capture.generation
  })

  const cancelRequestedIdentity = async (deadline: number): Promise<void> => {
    if (deadline - options.now() <= 0) return
    try {
      await options.bounded(options.bridge.cloudSpeechCancel(identity()), deadline, undefined)
    } catch {
      // Cleanup is best effort; never replace the original start failure.
    }
  }

  const cancelBridgeWithin = (deadline: number): Promise<CloudSpeechCancelResult> => {
    if (cancelPromise) return cancelPromise
    const call = (async () => {
      if (!options.isStarted()) return options.failure('CLOSED', options.request)
      const remaining = Math.max(0, deadline - options.now())
      if (remaining <= 0) return options.failure('TIMEOUT', options.request)
      let pending: Promise<unknown>
      try {
        pending = options.bridge.cloudSpeechCancel(identity())
      } catch {
        return options.failure('TRANSPORT', options.request)
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<CloudSpeechFailure>((resolve) => {
        timer = setTimeout(() => resolve(options.failure('TIMEOUT', options.request)), remaining)
      })
      try {
        const result = await Promise.race([pending, timeout])
        const parsed = CloudSpeechCancelResultSchema.safeParse(result)
        return parsed.success && (!parsed.data.ok || cloudSpeechIdentityMatches(parsed.data, options.request))
          ? parsed.data
          : options.failure('TRANSPORT', options.request)
      } catch {
        return options.failure('TRANSPORT', options.request)
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    cancelPromise = call
    return call
  }

  const cancel = (deadline: number): Promise<CloudSpeechCancelResult> => {
    if (cancelPromise) return cancelPromise
    cancelPromise = options
      .bounded(cancelBridgeWithin(deadline), deadline, options.failure('TIMEOUT', options.request))
      .then((result) => result)
      .catch(() => options.failure('TRANSPORT', options.request))
    return cancelPromise
  }

  return { cancelRequestedIdentity, cancelBridgeWithin, cancel, hasPending: () => cancelPromise !== null }
}
