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
    | ((
        componentId: SpeechPackComponentId,
        marker: PriorReadyMarker | null,
        transaction: symbol
      ) => boolean | Promise<boolean>)
    | undefined,
  current:
    | ((componentId: SpeechPackComponentId, marker: PriorReadyMarker | null, transaction: symbol) => boolean)
    | undefined,
  transaction: symbol
): Promise<boolean> {
  try {
    return (
      (await refresh?.(componentId, marker, transaction)) !== false &&
      current?.(componentId, marker, transaction) !== false
    )
  } catch {
    return false
  }
}

export function priorPackRestoreStillCurrent(
  componentId: SpeechPackComponentId,
  marker: PriorReadyMarker | null,
  current:
    | ((componentId: SpeechPackComponentId, marker: PriorReadyMarker | null, transaction: symbol) => boolean)
    | undefined,
  transaction: symbol
): boolean {
  try {
    return current?.(componentId, marker, transaction) !== false
  } catch {
    return false
  }
}

export async function rollbackSpeechPackActivation(options: {
  previousMarker: { marker: PriorReadyMarker } | null
  currentVersion: string
  authorize: () => Promise<boolean>
  stillCurrent: () => boolean
  restoreMarker: () => Promise<boolean>
  removeCurrent: () => Promise<boolean>
  restoreAside: () => Promise<boolean>
  removeMarker: () => Promise<boolean>
}): Promise<boolean> {
  const previous = options.previousMarker
  const permitted = async (): Promise<boolean> => (await options.authorize()) && options.stillCurrent()
  if (!(await permitted())) return false
  if (previous && previous.marker.version !== options.currentVersion) {
    if (!(await options.restoreMarker()) || !(await permitted())) return false
    if (!(await options.removeCurrent())) return false
    await options.restoreAside()
    return true
  }
  if (!(await options.removeCurrent())) return false
  const restored = await options.restoreAside()
  if (previous && restored) return (await permitted()) && options.restoreMarker()
  return (await permitted()) && options.removeMarker()
}
