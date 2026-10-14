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

type ImportAuthoritySnapshot = SettingsPolicyAuthoritySnapshot & {
  readonly history: Readonly<{ import: object | null }>
}

export interface ImportJobAuthorityDependencies {
  requireAuth(): boolean
  authGeneration(): number
  readAuthority(): Promise<ImportAuthoritySnapshot>
  currentObservation(): SettingsObservation | null
  captureAuthorityReceipt(): object | null
  isAuthorityReceiptCurrent(receipt: object): boolean
}

export interface ImportOperationAuthority {
  assertCurrent(): void
  refreshSameScope(): Promise<void>
}

const IMPORT_POLICY_LOCK_KEYS = new Set([
  'meetingsFolder',
  'encryptTranscripts',
  'enterpriseLive',
  'asrEngine',
  'asrLanguage',
  'azureClientId',
  'azureTenantId',
  'azureAllowedDomain',
  'localSpeechPack',
  'allowedProviders'
])

function importWriteScope(settings: Settings): string {
  const enterpriseLive = resolveEnterpriseLiveProfile(settings.enterpriseLive)
  return JSON.stringify({
    meetingsFolder: settings.meetingsFolder,
    encryptTranscripts: settings.encryptTranscripts,
    enterpriseLive: {
      managed: enterpriseLive.managed,
      inferenceMode: enterpriseLive.inferenceMode,
      summaryOnly: enterpriseLive.summaryOnly
    },
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
    allowedProviders: authority.allowedProviders === null ? null : [...new Set(authority.allowedProviders)].sort(),
    localSpeechPack: authority.localSpeechPack,
    lockedKeys: [...new Set(authority.lockedKeys.filter((key) => IMPORT_POLICY_LOCK_KEYS.has(key)))].sort()
  })
}

/** One trusted authority boundary shared by token, native-ASR, and transcript replacement admission. */
export function createImportJobAuthority(deps: ImportJobAuthorityDependencies) {
  let authorityQueue: Promise<void> = Promise.resolve()
  let authorityRevision = 0
  let lastVerifiedEpoch: number | undefined
  let lastVerifiedReceipt: object | undefined
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

  function receiptCurrent(receipt: object): boolean {
    try {
      return deps.isAuthorityReceiptCurrent(receipt)
    } catch {
      return false
    }
  }

  function captureReceipt(): object {
    let receipt: object | null
    try {
      receipt = deps.captureAuthorityReceipt()
    } catch {
      receipt = null
    }
    if (!receipt || !receiptCurrent(receipt)) throw unavailable()
    return receipt
  }

  function assertAuthorityRevision(expectedRevision: number): void {
    const observation = deps.currentObservation()
    const authGeneration = deps.authGeneration()
    if (!deps.requireAuth() || !observation?.readable || !Number.isSafeInteger(authGeneration)) throw unavailable()
    if (
      (lastVerifiedReceipt !== undefined && !receiptCurrent(lastVerifiedReceipt)) ||
      (lastAuthGeneration !== undefined && authGeneration !== lastAuthGeneration)
    ) {
      authorityRevision += 1
      lastAuthGeneration = authGeneration
    }
    if (authorityRevision !== expectedRevision) throw unavailable()
  }

  async function readFreshSettings(): Promise<Settings> {
    if (!deps.requireAuth()) throw unavailable()
    const receipt = captureReceipt()
    const beforeAuthGeneration = deps.authGeneration()
    if (!Number.isSafeInteger(beforeAuthGeneration)) throw unavailable()
    // Equivalent settings publications retain their semantic receipt; policy or authority changes
    // invalidate it in the publisher before any callback can refresh or adopt a later scope.
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
      !receiptCurrent(receipt) ||
      !authority.history?.import ||
      !receiptCurrent(authority.history.import) ||
      current.epoch !== authority.epoch ||
      current.settings !== authority.settings
    ) {
      authorityRevision += 1
      if (current) lastVerifiedEpoch = current.epoch
      lastAuthGeneration = afterAuthGeneration
      throw unavailable()
    }
    const signature = authorityScope(authority)
    if (lastAuthorityScope !== undefined && signature !== lastAuthorityScope) {
      authorityRevision += 1
    }
    if (revisionBeforeRead !== authorityRevision || !receiptCurrent(receipt)) {
      lastVerifiedEpoch = current.epoch
      lastAuthorityScope = signature
      lastVerifiedReceipt = receipt
      throw unavailable()
    }
    lastVerifiedEpoch = current.epoch
    lastVerifiedReceipt = receipt
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
    currentObservation()
    if (
      lastVerifiedEpoch === undefined ||
      lastVerifiedReceipt === undefined ||
      !receiptCurrent(lastVerifiedReceipt) ||
      lastAuthGeneration !== deps.authGeneration()
    )
      throw unavailable()
    assertRetentionAllowed()
    const capability = currentCapabilityState()
    if (capability === 'unavailable') throw unavailable()
    if (capability !== 'available') {
      throw new Error('Recording import is unavailable in the managed cloud-only speech profile.')
    }
  }

  async function captureOperation(): Promise<ImportOperationAuthority> {
    // Pin the invocation before entering the serialized refresh queue. A request that waits behind
    // another read must never inherit a later auth generation or settings scope.
    const invocation = currentObservation()
    const invocationReceipt = captureReceipt()
    const invocationAuthGeneration = deps.authGeneration()
    if (!Number.isSafeInteger(invocationAuthGeneration)) throw unavailable()
    const invocationSettings = importWriteScope(invocation.settings)
    const invocationRevision = authorityRevision
    const invocationAuthorityScope = lastAuthorityScope
    await refreshSettings()
    const observation = currentObservation()
    const authGeneration = deps.authGeneration()
    if (
      !receiptCurrent(invocationReceipt) ||
      authGeneration !== invocationAuthGeneration ||
      authorityRevision !== invocationRevision ||
      importWriteScope(observation.settings) !== invocationSettings ||
      (invocationAuthorityScope !== undefined && lastAuthorityScope !== invocationAuthorityScope)
    )
      throw unavailable()
    const expectedRevision = authorityRevision
    const expectedScope = lastAuthorityScope
    const expectedSettings = importWriteScope(observation.settings)
    let retired = false

    function assertCurrent(): void {
      if (retired) throw unavailable()
      try {
        const current = currentObservation()
        if (
          !receiptCurrent(invocationReceipt) ||
          authorityRevision !== expectedRevision ||
          deps.authGeneration() !== authGeneration ||
          importWriteScope(current.settings) !== expectedSettings ||
          lastAuthorityScope !== expectedScope
        ) {
          retired = true
          throw unavailable()
        }
      } catch {
        retired = true
        throw unavailable()
      }
    }

    return {
      assertCurrent,
      async refreshSameScope(): Promise<void> {
        assertCurrent()
        try {
          const refreshed = await refreshSettings()
          const current = currentObservation()
          if (
            !receiptCurrent(invocationReceipt) ||
            authorityRevision !== expectedRevision ||
            deps.authGeneration() !== authGeneration ||
            importWriteScope(refreshed) !== expectedSettings ||
            lastAuthorityScope !== expectedScope ||
            importWriteScope(current.settings) !== expectedSettings
          ) {
            throw unavailable()
          }
          assertCurrent()
        } catch {
          retired = true
          throw unavailable()
        }
      }
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
    const receipt = captureReceipt()
    const settings = await assertAdmissionAllowed()
    const observed = currentObservation()
    if (
      observed.settings !== settings ||
      !receiptCurrent(receipt) ||
      lastVerifiedReceipt === undefined ||
      !receiptCurrent(lastVerifiedReceipt) ||
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
        if (
          !receiptCurrent(receipt) ||
          importWriteScope(latest.settings) !== importWriteScope(settings) ||
          lastAuthorityScope !== scope
        ) {
          throw unavailable()
        }
        assertAdmissionCurrent()
      }
    }
  }

  function prepareReplacement(expectedSettings?: Settings): PrepareSavedReplacement {
    const expected = currentObservation()
    const expectedReceipt = captureReceipt()
    const expectedRevision = authorityRevision
    if (
      !receiptCurrent(expectedReceipt) ||
      (expectedSettings && importWriteScope(expected.settings) !== importWriteScope(expectedSettings))
    ) {
      throw unavailable()
    }
    const expectedScope = importWriteScope(expected.settings)
    return async () => {
      const beforeRead = currentObservation()
      if (!receiptCurrent(expectedReceipt)) throw unavailable()
      assertAuthorityRevision(expectedRevision)
      if (importWriteScope(beforeRead.settings) !== expectedScope) throw unavailable()
      const settings = await refreshSettings()
      const afterRead = currentObservation()
      if (
        !receiptCurrent(expectedReceipt) ||
        authorityRevision !== expectedRevision ||
        importWriteScope(settings) !== expectedScope
      ) {
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
          !receiptCurrent(expectedReceipt) ||
          authorityRevision !== expectedRevision ||
          importWriteScope(latest.settings) !== expectedScope
        ) {
          throw unavailable()
        }
        assertAdmissionCurrent()
      }
    }
  }

  return {
    captureOperation,
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
