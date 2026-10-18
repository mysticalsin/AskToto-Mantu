import type { Settings } from '@shared/ipc'
import type { LocalSpeechPackPolicy } from '@shared/model-policy'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'

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
let draftSettingsKey: string | null = null
let draftSettingsGeneration = 0

function draftSettingsSemantic(settings: Settings): string {
  return JSON.stringify([
    settings.meetingsFolder,
    Boolean(settings.encryptTranscripts),
    isSummaryOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive ?? settings)),
    String(settings.azureClientId || '').trim(),
    String(settings.azureTenantId || '').trim(),
    String(settings.azureAllowedDomain || '')
      .trim()
      .replace(/^@/, '')
  ])
}

function notifyObserver(): void {
  if (!current || !observer) return
  try {
    observer({ settings: current, readable, epoch })
  } catch {
    // Existing settings callers must remain usable; any speech cache at the old epoch closes.
    readable = false
    epoch += 1
    draftSettingsGeneration += 1
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

/** Bind a draft replacement to relevant published authority, retaining observed ABA transitions. */
export function captureDraftSettingsBoundary(): () => boolean {
  const generation = draftSettingsGeneration
  const admitted = current !== null && readable
  return () => admitted && readable && draftSettingsGeneration === generation
}

/** Pure publication: callbacks and epoch checks never read settings or perform an authority refresh. */
export function publishSettingsSnapshot(settings: Settings, canRead: boolean): void {
  const key = draftSettingsSemantic(settings)
  if (key !== draftSettingsKey || readable !== canRead) draftSettingsGeneration += 1
  draftSettingsKey = key
  if (settings !== current || readable !== canRead) epoch += 1
  current = settings
  readable = canRead
  notifyObserver()
}
