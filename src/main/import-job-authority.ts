import type { Settings } from '@shared/ipc'
import { isCloudOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import type { SettingsObservation, SettingsPolicyAuthoritySnapshot } from './settings-observation'
import {
  canRetainImportedTranscript,
  ImportRetentionAuthorityUnavailableError,
  ImportRetentionBlockedError,
  type ImportRetentionState
} from './import-retention-policy'
import type { PrepareSavedReplacement } from './infra/storage/atomic-saved-write'

export type ImportCapabilityState = 'available' | 'cloud-only-unsupported' | 'unavailable'

export interface ImportJobAuthorityDependencies {
  requireAuth(): boolean
  authGeneration(): number
  readAuthority(): Promise<SettingsPolicyAuthoritySnapshot>
  currentObservation(): SettingsObservation | null
}

function importWriteScope(settings: Settings): string {
  return JSON.stringify({
    meetingsFolder: settings.meetingsFolder,
    encryptTranscripts: settings.encryptTranscripts,
    enterpriseLive: settings.enterpriseLive,
    asrEngine: settings.asrEngine,
    asrLanguage: settings.asrLanguage,
    azureClientId: settings.azureClientId,
    azureTenantId: settings.azureTenantId,
    azureAllowedDomain: settings.azureAllowedDomain
  })
}

function authorityScope(authority: SettingsPolicyAuthoritySnapshot): string {
  return JSON.stringify({
    settings: importWriteScope(authority.settings),
    allowedProviders: authority.allowedProviders,
    localSpeechPack: authority.localSpeechPack,
    lockedKeys: authority.lockedKeys
  })
}

/** One trusted authority boundary shared by token, native-ASR, and transcript replacement admission. */
export function createImportJobAuthority(deps: ImportJobAuthorityDependencies) {
  let authorityQueue: Promise<void> = Promise.resolve()
  let authorityRevision = 0
  let lastVerifiedEpoch: number | undefined
  let lastAuthGeneration: number | undefined
  let lastAuthorityScope: string | undefined

  function unavailable(): ImportRetentionAuthorityUnavailableError {
    return new ImportRetentionAuthorityUnavailableError()
  }

  function currentSettings(): Settings {
    if (!deps.requireAuth()) throw unavailable()
    const observation = deps.currentObservation()
    if (!observation?.readable) throw unavailable()
    return observation.settings
  }

  function currentObservation(): SettingsObservation {
    const observation = deps.currentObservation()
    if (!deps.requireAuth() || !observation?.readable) throw unavailable()
    return observation
  }

  function assertAuthorityRevision(expectedRevision: number): void {
    const observation = deps.currentObservation()
    const authGeneration = deps.authGeneration()
    if (!deps.requireAuth() || !observation?.readable || !Number.isSafeInteger(authGeneration)) throw unavailable()
    if (
      (lastVerifiedEpoch !== undefined && observation.epoch !== lastVerifiedEpoch) ||
      (lastAuthGeneration !== undefined && authGeneration !== lastAuthGeneration)
    ) {
      authorityRevision += 1
      lastVerifiedEpoch = observation.epoch
      lastAuthGeneration = authGeneration
    }
    if (authorityRevision !== expectedRevision) throw unavailable()
  }

  async function readFreshSettings(): Promise<Settings> {
    if (!deps.requireAuth()) throw unavailable()
    const before = deps.currentObservation()
    const beforeAuthGeneration = deps.authGeneration()
    if (!Number.isSafeInteger(beforeAuthGeneration)) throw unavailable()
    if (before && lastVerifiedEpoch !== undefined && before.epoch !== lastVerifiedEpoch) authorityRevision += 1
    if (lastAuthGeneration !== undefined && beforeAuthGeneration !== lastAuthGeneration) authorityRevision += 1
    const revisionBeforeRead = authorityRevision
    const authority = await deps.readAuthority()
    const current = deps.currentObservation()
    const afterAuthGeneration = deps.authGeneration()
    if (
      !deps.requireAuth() ||
      beforeAuthGeneration !== afterAuthGeneration ||
      !authority.readable ||
      !current?.readable ||
      current.epoch !== authority.epoch ||
      current.settings !== authority.settings
    ) {
      authorityRevision += 1
      if (current) lastVerifiedEpoch = current.epoch
      lastAuthGeneration = afterAuthGeneration
      throw unavailable()
    }
    const signature = authorityScope(authority)
    if (
      (lastAuthorityScope !== undefined && signature !== lastAuthorityScope) ||
      (before && current.epoch > before.epoch + 1)
    ) {
      authorityRevision += 1
    }
    // Only a single equivalent publication from this forced read is allowed to advance the observation
    // epoch. Any other change during the await was an intervening policy/tenant transition.
    if (revisionBeforeRead !== authorityRevision || (before && current.epoch > before.epoch + 1)) {
      lastVerifiedEpoch = current.epoch
      lastAuthorityScope = signature
      throw unavailable()
    }
    lastVerifiedEpoch = current.epoch
    lastAuthGeneration = afterAuthGeneration
    lastAuthorityScope = signature
    return authority.settings
  }

  function refreshSettings(): Promise<Settings> {
    const run = authorityQueue.then(readFreshSettings)
    authorityQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function refreshRetentionState(): Promise<ImportRetentionState> {
    if (!deps.requireAuth()) return 'unavailable'
    try {
      return canRetainImportedTranscript(await refreshSettings()) ? 'allowed' : 'summary-only'
    } catch {
      return 'unavailable'
    }
  }

  function currentRetentionState(): ImportRetentionState {
    try {
      return canRetainImportedTranscript(currentSettings()) ? 'allowed' : 'summary-only'
    } catch {
      return 'unavailable'
    }
  }

  function capabilityFor(settings: Settings): ImportCapabilityState {
    return isCloudOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive))
      ? 'cloud-only-unsupported'
      : 'available'
  }

  function currentCapabilityState(): ImportCapabilityState {
    try {
      return capabilityFor(currentSettings())
    } catch {
      return 'unavailable'
    }
  }

  async function refreshCapabilityState(): Promise<ImportCapabilityState> {
    try {
      return capabilityFor(await refreshSettings())
    } catch {
      return 'unavailable'
    }
  }

  function assertRetentionAllowed(): void {
    const state = currentRetentionState()
    if (state === 'unavailable') throw unavailable()
    if (state !== 'allowed') throw new ImportRetentionBlockedError()
  }

  function assertAdmissionCurrent(): void {
    const observed = currentObservation()
    if (lastVerifiedEpoch !== observed.epoch || lastAuthGeneration !== deps.authGeneration()) throw unavailable()
    assertRetentionAllowed()
    const capability = currentCapabilityState()
    if (capability === 'unavailable') throw unavailable()
    if (capability !== 'available') {
      throw new Error('Recording import is unavailable in the managed cloud-only speech profile.')
    }
  }

  async function assertAdmissionAllowed(): Promise<Settings> {
    const settings = await refreshSettings()
    if (!canRetainImportedTranscript(settings)) throw new ImportRetentionBlockedError()
    if (capabilityFor(settings) !== 'available') {
      throw new Error('Recording import is unavailable in the managed cloud-only speech profile.')
    }
    return settings
  }

  async function captureAsrAdmission() {
    const settings = await assertAdmissionAllowed()
    const observed = currentObservation()
    if (
      observed.settings !== settings ||
      lastVerifiedEpoch !== observed.epoch ||
      lastAuthGeneration !== deps.authGeneration()
    ) {
      throw unavailable()
    }
    const revision = authorityRevision
    const scope = lastAuthorityScope
    return {
      settings,
      assertCurrent(): void {
        const latest = currentObservation()
        assertAuthorityRevision(revision)
        if (importWriteScope(latest.settings) !== importWriteScope(settings) || lastAuthorityScope !== scope) {
          throw unavailable()
        }
        assertAdmissionCurrent()
      }
    }
  }

  function prepareReplacement(expectedSettings?: Settings): PrepareSavedReplacement {
    const expected = currentObservation()
    const expectedRevision = authorityRevision
    if (
      lastVerifiedEpoch !== expected.epoch ||
      (expectedSettings && importWriteScope(expected.settings) !== importWriteScope(expectedSettings))
    ) {
      throw unavailable()
    }
    const expectedScope = importWriteScope(expected.settings)
    return async () => {
      const beforeRead = currentObservation()
      assertAuthorityRevision(expectedRevision)
      if (importWriteScope(beforeRead.settings) !== expectedScope) throw unavailable()
      const settings = await refreshSettings()
      const afterRead = currentObservation()
      if (authorityRevision !== expectedRevision || importWriteScope(settings) !== expectedScope) {
        throw unavailable()
      }
      if (!canRetainImportedTranscript(settings)) throw new ImportRetentionBlockedError()
      const capability = capabilityFor(settings)
      if (capability !== 'available') {
        throw new Error('Recording import is unavailable in the managed cloud-only speech profile.')
      }
      const observed = currentObservation()
      if (observed.epoch !== afterRead.epoch || observed.settings !== settings) throw unavailable()
      return () => {
        const latest = currentObservation()
        if (
          authorityRevision !== expectedRevision ||
          lastVerifiedEpoch !== latest.epoch ||
          importWriteScope(latest.settings) !== expectedScope
        ) {
          throw unavailable()
        }
        assertAdmissionCurrent()
      }
    }
  }

  return {
    currentSettings,
    refreshSettings,
    currentRetentionState,
    refreshRetentionState,
    currentCapabilityState,
    refreshCapabilityState,
    assertRetentionAllowed,
    assertAdmissionCurrent,
    assertAdmissionAllowed,
    captureAsrAdmission,
    prepareReplacement
  }
}
