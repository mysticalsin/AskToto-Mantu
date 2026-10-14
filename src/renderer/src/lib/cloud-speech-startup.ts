import {
  CloudSpeechCapabilitySchema,
  CloudSpeechEventSchema,
  type CloudSpeechCapability,
  type CloudSpeechEvent,
  type CloudSpeechFailure
} from '@shared/cloud-speech'

const MAX_STARTUP_EVENT_COUNT = 128
const MAX_STARTUP_EVENT_BYTES = 256 * 1024

export function selectCloudSpeechStartRoute(
  raw: unknown,
  expectedEngine: string
):
  | { ok: true; selected: NonNullable<CloudSpeechCapability['selected']> }
  | { ok: false; code: CloudSpeechFailure['code']; report: boolean } {
  const parsed = CloudSpeechCapabilitySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'TRANSPORT', report: false }
  const capability = parsed.data
  const selected = capability.selected
  if (
    !capability.ready ||
    !selected ||
    selected.engine !== expectedEngine ||
    !capability.allowed.some(
      (route) =>
        route.engine === selected.engine && route.routeId === selected.routeId && route.modelId === selected.modelId
    )
  )
    return { ok: false, code: capability.refusal ?? 'NOT_READY', report: true }
  return { ok: true, selected }
}

export function createCloudSpeechStartupSubscription(
  subscribe: (callback: (event: CloudSpeechEvent) => void) => () => void,
  identity: { captureId: string; captureGeneration: number },
  dispatch: (event: CloudSpeechEvent) => void,
  onInvalid: (code: 'STALE' | 'QUEUE_LIMIT') => void
) {
  let buffering = true
  let active = true
  let bufferedBytes = 0
  const bufferedEvents: CloudSpeechEvent[] = []
  const unsubscribe = subscribe((raw) => {
    if (!active) return
    if (!buffering) {
      dispatch(raw)
      return
    }
    const parsed = CloudSpeechEventSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.captureId !== identity.captureId ||
      parsed.data.captureGeneration !== identity.captureGeneration
    ) {
      onInvalid('STALE')
      return
    }
    let byteLength: number
    try {
      byteLength = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength
    } catch {
      onInvalid('STALE')
      return
    }
    if (bufferedEvents.length + 1 > MAX_STARTUP_EVENT_COUNT || bufferedBytes + byteLength > MAX_STARTUP_EVENT_BYTES) {
      onInvalid('QUEUE_LIMIT')
      return
    }
    bufferedEvents.push(parsed.data)
    bufferedBytes += byteLength
  })

  return {
    activate(): void {
      if (!active || !buffering) return
      buffering = false
      bufferedBytes = 0
      for (const event of bufferedEvents.splice(0)) dispatch(event)
    },
    close(): void {
      if (!active) return
      active = false
      bufferedEvents.length = 0
      bufferedBytes = 0
      unsubscribe()
    }
  }
}
