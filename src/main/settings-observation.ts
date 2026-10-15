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
let current: Settings | null = null
let readable = false
let epoch = 0

function notifyObserver(): void {
  if (!current || !observer) return
  try {
    observer({ settings: current, readable, epoch })
  } catch {
    // The latest publication becomes unreadable; semantic receipts close before additive listeners run.
    readable = false
    epoch += 1
    if (current) commitSettingsAuthorityPublication(current, false)
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

export function getSettingsObservationEpoch(): number {
  return epoch
}

export function getPublishedSettingsObservation(): SettingsObservation | null {
  return current ? { settings: current, readable, epoch } : null
}

/** Pure publication: callbacks and epoch checks never read settings or perform an authority refresh. */
export function publishSettingsSnapshot(settings: Settings, canRead: boolean): void {
  const changed = current !== settings || readable !== canRead
  commitSettingsAuthorityPublication(settings, canRead)
  if (changed) epoch += 1
  current = settings
  readable = canRead
  if (observer) {
    try {
      observer({ settings: current, readable, epoch })
    } catch {
      readable = false
      epoch += 1
      commitSettingsAuthorityPublication(current, false)
    }
  }
  flushSettingsAuthorityInvalidations()
}

export function attachSettingsAuthorityHistory(
  snapshot: Omit<SettingsPolicyAuthoritySnapshot, 'history'>
): SettingsPolicyAuthoritySnapshot {
  return Object.freeze({ ...snapshot, history: getSettingsAuthorityHistory() })
}
