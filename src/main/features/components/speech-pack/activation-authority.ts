import type { SpeechPackActivationMarker } from './marker'
import type { SpeechPackComponentId } from './manifest'
import { SpeechPackError } from './errors'

export type PriorReadyMarker = Pick<SpeechPackActivationMarker, 'version' | 'manifestIdentity'>

export function assertSpeechPackTransferAuthorized(
  componentId: SpeechPackComponentId,
  signal: AbortSignal,
  authorize: ((componentId: SpeechPackComponentId) => boolean) | undefined
): void {
  if (signal.aborted) throw signal.reason
  if (authorize?.(componentId) === false)
    throw new SpeechPackError('policy', 'speech-pack action is no longer authorized')
}

export async function assertSpeechPackActivationAuthorized(
  componentId: SpeechPackComponentId,
  signal: AbortSignal,
  authorizeTransfer: ((componentId: SpeechPackComponentId) => boolean) | undefined,
  authorizeActivation: ((componentId: SpeechPackComponentId) => boolean | Promise<boolean>) | undefined
): Promise<void> {
  assertSpeechPackTransferAuthorized(componentId, signal, authorizeTransfer)
  if ((await authorizeActivation?.(componentId)) === false)
    throw new SpeechPackError('policy', 'speech-pack activation is no longer authorized')
  assertSpeechPackTransferAuthorized(componentId, signal, authorizeTransfer)
}

export async function authorizePriorPackRestore(
  componentId: SpeechPackComponentId,
  marker: PriorReadyMarker | null,
  refresh:
    | ((componentId: SpeechPackComponentId, marker: PriorReadyMarker | null) => boolean | Promise<boolean>)
    | undefined,
  current: ((componentId: SpeechPackComponentId, marker: PriorReadyMarker | null) => boolean) | undefined
): Promise<boolean> {
  try {
    return (await refresh?.(componentId, marker)) !== false && current?.(componentId, marker) !== false
  } catch {
    return false
  }
}

export function priorPackRestoreStillCurrent(
  componentId: SpeechPackComponentId,
  marker: PriorReadyMarker | null,
  current: ((componentId: SpeechPackComponentId, marker: PriorReadyMarker | null) => boolean) | undefined
): boolean {
  try {
    return current?.(componentId, marker) !== false
  } catch {
    return false
  }
}

export async function rollbackSpeechPackActivation(options: {
  currentVersion: string
  previousMarker: { marker: PriorReadyMarker } | null
  authorize: () => Promise<boolean>
  stillCurrent: () => boolean
  restoreMarker: () => Promise<boolean>
  removeCurrent: () => Promise<void>
  restoreAside: () => Promise<boolean>
  removeMarker: () => Promise<void>
}): Promise<void> {
  const previous = options.previousMarker
  if (!(await options.authorize())) return
  if (previous && previous.marker.version !== options.currentVersion) {
    if (!(await options.restoreMarker()) || !(await options.authorize()) || !options.stillCurrent()) return
    await options.removeCurrent()
    await options.restoreAside()
    return
  }
  if (!options.stillCurrent()) return
  await options.removeCurrent()
  const restored = previous ? await options.restoreAside() : false
  if (previous && restored) await options.restoreMarker()
  else if ((await options.authorize()) && options.stillCurrent()) await options.removeMarker()
}
