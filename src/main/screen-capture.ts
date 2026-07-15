import { isScreenCapturePermissionError } from '@shared/screen-capture'

export { isScreenCapturePermissionError }

/**
 * Shared screen-source recovery for visual screen asks and macOS system-audio loopback.
 * Electron can briefly return an empty list or reject `desktopCapturer.getSources()` while
 * ScreenCaptureKit is starting. Retrying both cases here keeps the recovery behaviour identical.
 */
export type ScreenSourceLike = {
  thumbnail: { getSize(): { width: number; height: number } }
}

type RetryOptions = {
  attempts?: number
  wait?: (ms: number) => Promise<void>
  onError?: (error: unknown, attempt: number) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A zero-pixel native image is not a screenshot and must never be sent to a vision provider. */
export function isUsableScreenSource(source: ScreenSourceLike): boolean {
  const { width, height } = source.thumbnail.getSize()
  return width > 0 && height > 0
}

/**
 * Attempts source acquisition up to three times, recovering from both Electron rejections and empty or
 * blank thumbnail results. Returns only sources that carry actual pixels, preserving display routing in
 * the caller while guaranteeing a 0x0 source can never look like a successful capture.
 */
export async function getScreenSourcesWithRetry<T>(
  getSources: () => Promise<T[]>,
  isUsable: (source: T) => boolean,
  { attempts = 3, wait = sleep, onError }: RetryOptions = {}
): Promise<T[]> {
  const total = Math.max(1, Math.floor(attempts))
  for (let attempt = 0; attempt < total; attempt++) {
    try {
      const usable = (await getSources()).filter(isUsable)
      if (usable.length) return usable
    } catch (error) {
      onError?.(error, attempt + 1)
    }
    if (attempt + 1 < total) await wait(250 * (attempt + 1))
  }
  return []
}

/**
 * Coalesce only identical capture requests. A single global in-flight promise can return a frame from
 * display A to a simultaneous request on display B, which is both incorrect and a privacy failure.
 */
export function createKeyedSingleFlight<Key, Value>(
  run: (key: Key) => Promise<Value>
): (key: Key) => Promise<Value> {
  const inFlight = new Map<Key, Promise<Value>>()
  return (key: Key): Promise<Value> => {
    const existing = inFlight.get(key)
    if (existing) return existing
    let promise: Promise<Value>
    promise = Promise.resolve()
      .then(() => run(key))
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key)
      })
    inFlight.set(key, promise)
    return promise
  }
}

/** User-facing recovery copy that only names macOS TCC when that is actually the platform in use. */
export function screenCaptureUnavailableMessage(platform: NodeJS.Platform | string, accessStatus: string): string {
  if (platform === 'darwin' && accessStatus !== 'granted') {
    return 'Screen Recording permission is off for Métis. Enable it in System Settings → Privacy & Security → Screen Recording, then quit and reopen Métis.'
  }
  return platform === 'darwin'
    ? 'No screen source available. If you granted Screen Recording just now, quit and reopen Métis — macOS only applies the permission to a fresh launch.'
    : 'No screen source available. Check your system’s screen-capture permissions for Métis, then try again.'
}
