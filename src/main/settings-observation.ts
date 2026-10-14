import type { Settings } from '@shared/ipc'
import type { LocalSpeechPackPolicy } from '@shared/model-policy'
import {
  commitSettingsAuthorityPublication,
  flushSettingsAuthorityInvalidations,
  getSettingsAuthorityHistory,
  type SettingsAuthorityHistory
} from './settings-authority-history'

export type SettingsObservation = { settings: Settings; readable: boolean; epoch: number }
export type SettingsPolicyAuthoritySnapshot = SettingsObservation & {
  allowedProviders: string[] | null
  localSpeechPack: LocalSpeechPackPolicy | null
  lockedKeys: string[]
  history: SettingsAuthorityHistory
}
type Listener = (observation: SettingsObservation) => void
let observer: Listener | null = null
const additionalObservers = new Set<Listener>()
let current: Settings | null = null
let readable = false
let epoch = 0

function notifyObserver(): void {
  if (!current) return
  if (observer) {
    try {
      observer({ settings: current, readable, epoch })
    } catch {
      // The publication is unreadable; semantic receipts close before independent observers run.
      readable = false
      epoch += 1
      commitSettingsAuthorityPublication(current, false)
    }
  }
  for (const listener of additionalObservers) {
    try {
      listener({ settings: current, readable, epoch })
    } catch {
      // Independent retirement listeners cannot break settings publication.
    }
  }
  flushSettingsAuthorityInvalidations()
}

export function observeSettingsSnapshot(listener: Listener): () => void {
  observer = listener
  notifyObserver()
  return () => {
    if (observer === listener) observer = null
  }
}

/** Add an independent authority-retirement observer without replacing the speech-cache owner. */
export function observeSettingsAuthorityChanges(listener: Listener): () => void {
  additionalObservers.add(listener)
  return () => additionalObservers.delete(listener)
}

export function getSettingsObservationEpoch(): number {
  return epoch
}

export function getPublishedSettingsObservation(): SettingsObservation | null {
  return current ? { settings: current, readable, epoch } : null
}

/** Pure publication: callbacks and epoch checks never read settings or perform an authority refresh. */
export function publishSettingsSnapshot(settings: Settings, canRead: boolean): void {
  if (current !== settings || readable !== canRead) epoch += 1
  commitSettingsAuthorityPublication(settings, canRead)
  current = settings
  readable = canRead
  notifyObserver()
}

export function attachSettingsAuthorityHistory(
  snapshot: Omit<SettingsPolicyAuthoritySnapshot, 'history'>
): SettingsPolicyAuthoritySnapshot {
  return Object.freeze({ ...snapshot, history: getSettingsAuthorityHistory() })
}
