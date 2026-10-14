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
  const bufferedEvents: Array<{ event: CloudSpeechEvent; byteLength: number }> = []
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
    bufferedEvents.push({ event: parsed.data, byteLength })
    bufferedBytes += byteLength
  })

  return {
    async activate(waitForDispatch: () => Promise<void>): Promise<void> {
      if (!active || !buffering) return
      while (active && bufferedEvents.length > 0) {
        const next = bufferedEvents.shift()
        if (!next) break
        bufferedBytes -= next.byteLength
        dispatch(next.event)
        await waitForDispatch()
      }
      if (active) buffering = false
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

export async function waitForStartupDispatch(
  dispatchTail: Promise<void>,
  deadline: number,
  now: () => number,
  onTimeout: () => void
): Promise<void> {
  const remaining = deadline - now()
  if (remaining <= 0) {
    onTimeout()
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), remaining)
  })
  try {
    const drained = await Promise.race([dispatchTail.then(() => true), timeout])
    if (!drained) onTimeout()
  } finally {
    if (timer) clearTimeout(timer)
  }
}
