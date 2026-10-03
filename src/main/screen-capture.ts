import { isScreenCapturePermissionError, needsAppRelaunchForScreenCapture } from '@shared/screen-capture'

export { isScreenCapturePermissionError, needsAppRelaunchForScreenCapture }

/**
 * Shared screen-source recovery for visual screen asks and macOS system-audio loopback.
 * Electron can briefly return an empty list or reject `desktopCapturer.getSources()` while
 * ScreenCaptureKit is starting. Retrying both cases here keeps the recovery behaviour identical.
 */
export type ScreenSourceLike = {
  thumbnail: { getSize(): { width: number; height: number } }
}

export type CaptureSourceKind = 'window' | 'display' | 'region'

export type SingleWindowCaptureTarget = {
  kind: CaptureSourceKind
  id: string
}

export type SingleWindowCaptureSource = ScreenSourceLike & {
  id: string
  name?: string
  thumbnail: ScreenSourceLike['thumbnail'] & {
    resize?(size: { width: number; height: number }): SingleWindowCaptureSource['thumbnail']
    toPNG(): Buffer
  }
}

export type CapturedWindowImage = {
  image: string
  width: number
  height: number
  capturedAt: number
  targetWindowId: string
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

export function assertSingleWindowCaptureTarget(target: SingleWindowCaptureTarget): void {
  if (target.kind !== 'window') {
    throw new Error('OCR capture requires one target window; display and region sources are not accepted.')
  }
  if (!target.id.trim()) throw new Error('OCR capture requires a target window id.')
}

export async function captureSingleWindowSource(
  target: SingleWindowCaptureTarget,
  getSources: (options: {
    types: ['window']
    thumbnailSize: { width: number; height: number }
  }) => Promise<SingleWindowCaptureSource[]>,
  now: () => number = Date.now
): Promise<CapturedWindowImage> {
  assertSingleWindowCaptureTarget(target)
  const sources = await getScreenSourcesWithRetry(
    () => getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 1280 } }),
    isUsableScreenSource
  )
  const source = sources.find((candidate) => candidate.id === target.id)
  if (!source) throw new Error('The selected window changed before Métis could capture it. Try again.')
  let image = source.thumbnail
  const size = image.getSize()
  const maxEdge = Math.max(size.width, size.height)
  if (maxEdge > 1280 && image.resize) {
    const scale = 1280 / maxEdge
    image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) })
  }
  const finalSize = image.getSize()
  const png = image.toPNG()
  if (finalSize.width < 1 || finalSize.height < 1 || png.length < 1) {
    throw new Error('Window capture returned an empty image. Try again in a moment.')
  }
  return {
    image: png.toString('base64'),
    width: finalSize.width,
    height: finalSize.height,
    capturedAt: now(),
    targetWindowId: target.id
  }
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
    return 'Screen Recording permission is off for Métis. Enable it in System Settings → Privacy & Security → Screen Recording, then restart Métis.'
  }
  return platform === 'darwin'
    ? 'No screen source available. If you granted Screen Recording just now, restart Métis to finish enabling it: macOS only applies a fresh grant to the next launch.'
    : 'No screen source available. Check your system’s screen-capture permissions for Métis, then try again.'
}
