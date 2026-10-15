import type { Settings } from '@shared/ipc'
import type { LocalSpeechPackPolicy } from '@shared/model-policy'

export type SettingsObservation = { settings: Settings; readable: boolean; epoch: number }
export type SettingsPolicyAuthoritySnapshot = SettingsObservation & {
  allowedProviders: string[] | null
  localSpeechPack: LocalSpeechPackPolicy | null
  lockedKeys: string[]
}
type Listener = (observation: SettingsObservation) => void
let observer: Listener | null = null
let current: Settings | null = null
let readable = false
let epoch = 0

function notifyObserver(): void {
  if (!current || !observer) return
  try {
    observer({ settings: current, readable, epoch })
  } catch {
    // Existing settings callers must remain usable; any speech cache at the old epoch closes.
    readable = false
    epoch += 1
  }
}

export function observeSettingsSnapshot(listener: Listener): () => void {
  observer = listener
  notifyObserver()
  return () => {
    if (observer === listener) observer = null
  }
}

export function getSettingsObservationEpoch(): number {
  return epoch
}

export function getPublishedSettingsObservation(): SettingsObservation | null {
  return current ? { settings: current, readable, epoch } : null
}

/** Pure publication: callbacks and epoch checks never read settings or perform an authority refresh. */
export function publishSettingsSnapshot(settings: Settings, canRead: boolean): void {
  if (settings !== current || readable !== canRead) epoch += 1
  current = settings
  readable = canRead
  notifyObserver()
}
