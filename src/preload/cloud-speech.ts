import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { ZodType } from 'zod'
import {
  CLOUD_SPEECH_DISCLOSURE_VERSION,
  CLOUD_SPEECH_IPC,
  CLOUD_SPEECH_MAX_EVENT_SUBSCRIPTIONS,
  CLOUD_SPEECH_MAX_PRELOAD_FRAME_INVOKES,
  CloudSpeechCancelRequestSchema,
  CloudSpeechCancelResultSchema,
  CloudSpeechCapabilitySchema,
  CloudSpeechEventSchema,
  CloudSpeechFailure,
  CloudSpeechFinishRequestSchema,
  CloudSpeechFinishResultSchema,
  CloudSpeechFrameResultSchema,
  CloudSpeechFrameSchema,
  CloudSpeechIdentitySchema,
  CloudSpeechStartRequestSchema,
  CloudSpeechStartResultSchema,
  CloudSpeechStatusRequestSchema,
  CloudSpeechStatusResultSchema,
  type CloudSpeechCancelResult,
  type CloudSpeechCancelRequest,
  type CloudSpeechCapability,
  type CloudSpeechEvent,
  type CloudSpeechFinishRequest,
  type CloudSpeechFinishResult,
  type CloudSpeechFrame,
  type CloudSpeechFrameResult,
  type CloudSpeechStartRequest,
  type CloudSpeechStartResult,
  type CloudSpeechStatusRequest,
  type CloudSpeechStatusResult
} from '../shared/cloud-speech'

type Renderer = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
type Unsubscribe = () => void

export type CloudSpeechPreloadApi = {
  cloudSpeechCapability: () => Promise<CloudSpeechCapability>
  cloudSpeechStart: (request: CloudSpeechStartRequest) => Promise<CloudSpeechStartResult>
  cloudSpeechFrame: (frame: CloudSpeechFrame) => Promise<CloudSpeechFrameResult>
  cloudSpeechFinish: (request: CloudSpeechFinishRequest) => Promise<CloudSpeechFinishResult>
  cloudSpeechCancel: (request: CloudSpeechCancelRequest) => Promise<CloudSpeechCancelResult>
  cloudSpeechStatus: (request: CloudSpeechStatusRequest) => Promise<CloudSpeechStatusResult>
  onCloudSpeechEvent: (
    captureId: string,
    captureGeneration: number,
    callback: (event: CloudSpeechEvent) => void
  ) => Unsubscribe
}

function failure(identity?: unknown, code: CloudSpeechFailure['code'] = 'INVALID_REQUEST'): CloudSpeechFailure {
  let source = identity
  try {
    if (typeof identity === 'object' && identity !== null) {
      source = {
        captureId: Reflect.get(identity, 'captureId'),
        captureGeneration: Reflect.get(identity, 'captureGeneration')
      }
    }
  } catch {
    source = undefined
  }
  const parsedIdentity = CloudSpeechIdentitySchema.safeParse(source)
  return parsedIdentity.success ? { ok: false, code, ...parsedIdentity.data } : { ok: false, code }
}

function transportFailure<T>(schema: ZodType<T>, value: unknown, identity?: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success || !matchesIdentity(parsed.data, identity)) return failure(identity, 'TRANSPORT') as T
  return parsed.data
}

function matchesIdentity(value: unknown, identity: unknown): boolean {
  const expected = CloudSpeechIdentitySchema.safeParse(identity)
  if (!expected.success || typeof value !== 'object' || value === null) return false
  let ok: unknown
  try {
    ok = Reflect.get(value, 'ok')
    const captureId = Reflect.get(value, 'captureId')
    const captureGeneration = Reflect.get(value, 'captureGeneration')
    if (ok === true) {
      return captureId === expected.data.captureId && captureGeneration === expected.data.captureGeneration
    }
    return (
      (captureId === undefined || captureId === expected.data.captureId) &&
      (captureGeneration === undefined || captureGeneration === expected.data.captureGeneration)
    )
  } catch {
    return false
  }
}

function fixedPcmByteLength(value: ArrayBuffer): number {
  const byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
  if (!byteLengthGetter) throw new TypeError('ArrayBuffer byteLength is unavailable')
  return byteLengthGetter.call(value) as number
}

function invalidCapability(): CloudSpeechCapability {
  return {
    disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION,
    selected: null,
    allowed: [],
    ready: false,
    refusal: 'TRANSPORT'
  }
}

/** Validates both directions and bounds renderer-originated frame invoke concurrency. */
export function createCloudSpeechPreloadApi(renderer: Renderer): CloudSpeechPreloadApi {
  const pendingFrames = new Set<string>()
  const subscriptions = new Set<Unsubscribe>()

  return {
    async cloudSpeechCapability() {
      try {
        const parsed = CloudSpeechCapabilitySchema.safeParse(await renderer.invoke(CLOUD_SPEECH_IPC.capability))
        return parsed.success ? parsed.data : invalidCapability()
      } catch {
        return invalidCapability()
      }
    },
    async cloudSpeechStart(request) {
      let parsed: ReturnType<typeof CloudSpeechStartRequestSchema.safeParse>
      try {
        parsed = CloudSpeechStartRequestSchema.safeParse(request)
      } catch {
        return failure(request, 'INVALID_REQUEST')
      }
      if (!parsed.success) return failure(request, 'INVALID_REQUEST')
      try {
        return transportFailure(
          CloudSpeechStartResultSchema,
          await renderer.invoke(CLOUD_SPEECH_IPC.start, parsed.data),
          parsed.data
        )
      } catch {
        return failure(parsed.data, 'TRANSPORT')
      }
    },
    async cloudSpeechFrame(frame) {
      let parsed: ReturnType<typeof CloudSpeechFrameSchema.safeParse>
      try {
        parsed = CloudSpeechFrameSchema.safeParse(frame)
      } catch {
        return failure(frame, 'INVALID_REQUEST')
      }
      if (!parsed.success) return failure(frame, 'INVALID_REQUEST')
      const value = parsed.data
      const key = `${value.captureId}:${value.captureGeneration}:${value.track}`
      if (pendingFrames.has(key) || pendingFrames.size >= CLOUD_SPEECH_MAX_PRELOAD_FRAME_INVOKES)
        return failure(value, 'QUEUE_LIMIT')
      pendingFrames.add(key)
      try {
        // Clone immediately into a fresh fixed backing buffer before crossing the context bridge.
        const pcmLength = fixedPcmByteLength(value.pcm16le)
        const copy: CloudSpeechFrame = {
          ...value,
          pcm16le: ArrayBuffer.prototype.slice.call(value.pcm16le, 0) as ArrayBuffer
        }
        const result = transportFailure(
          CloudSpeechFrameResultSchema,
          await renderer.invoke(CLOUD_SPEECH_IPC.frame, copy),
          value
        )
        if (
          result.ok &&
          (result.track !== value.track ||
            result.sequence !== value.sequence ||
            result.nextSampleOffset !== value.sampleOffset + pcmLength / 2)
        )
          return failure(value, 'TRANSPORT')
        return result
      } catch {
        return failure(value, 'TRANSPORT')
      } finally {
        pendingFrames.delete(key)
      }
    },
    async cloudSpeechFinish(request) {
      let parsed: ReturnType<typeof CloudSpeechFinishRequestSchema.safeParse>
      try {
        parsed = CloudSpeechFinishRequestSchema.safeParse(request)
      } catch {
        return failure(request, 'INVALID_REQUEST')
      }
      if (!parsed.success) return failure(request, 'INVALID_REQUEST')
      try {
        return transportFailure(
          CloudSpeechFinishResultSchema,
          await renderer.invoke(CLOUD_SPEECH_IPC.finish, parsed.data),
          parsed.data
        )
      } catch {
        return failure(parsed.data, 'TRANSPORT')
      }
    },
    async cloudSpeechCancel(request) {
      let parsed: ReturnType<typeof CloudSpeechCancelRequestSchema.safeParse>
      try {
        parsed = CloudSpeechCancelRequestSchema.safeParse(request)
      } catch {
        return failure(request, 'INVALID_REQUEST')
      }
      if (!parsed.success) return failure(request, 'INVALID_REQUEST')
      try {
        return transportFailure(
          CloudSpeechCancelResultSchema,
          await renderer.invoke(CLOUD_SPEECH_IPC.cancel, parsed.data),
          parsed.data
        )
      } catch {
        return failure(parsed.data, 'TRANSPORT')
      }
    },
    async cloudSpeechStatus(request) {
      let parsed: ReturnType<typeof CloudSpeechStatusRequestSchema.safeParse>
      try {
        parsed = CloudSpeechStatusRequestSchema.safeParse(request)
      } catch {
        return failure(request, 'INVALID_REQUEST')
      }
      if (!parsed.success) return failure(request, 'INVALID_REQUEST')
      try {
        return transportFailure(
          CloudSpeechStatusResultSchema,
          await renderer.invoke(CLOUD_SPEECH_IPC.status, parsed.data),
          parsed.data
        )
      } catch {
        return failure(parsed.data, 'TRANSPORT')
      }
    },
    onCloudSpeechEvent(captureId, captureGeneration, callback) {
      const identity = CloudSpeechIdentitySchema.safeParse({ captureId, captureGeneration })
      if (!identity.success || subscriptions.size >= CLOUD_SPEECH_MAX_EVENT_SUBSCRIPTIONS) return () => undefined
      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = CloudSpeechEventSchema.safeParse(payload)
        if (
          !parsed.success ||
          parsed.data.captureId !== identity.data.captureId ||
          parsed.data.captureGeneration !== identity.data.captureGeneration
        )
          return
        try {
          callback(parsed.data)
        } catch {
          // Renderer listeners cannot disrupt the preload event loop or other subscribers.
        }
      }
      renderer.on(CLOUD_SPEECH_IPC.event, listener)
      let active = true
      const unsubscribe = (): void => {
        if (!active) return
        active = false
        subscriptions.delete(unsubscribe)
        renderer.removeListener(CLOUD_SPEECH_IPC.event, listener)
      }
      subscriptions.add(unsubscribe)
      return unsubscribe
    }
  }
}
