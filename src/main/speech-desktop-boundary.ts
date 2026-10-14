import { app } from 'electron'
import { join } from 'node:path'
import { readSettingsAtAuthorityBoundary } from './store'
import { getDurableMachineId } from './license'
import {
  observeSettingsSnapshot,
  getSettingsObservationEpoch,
  getPublishedSettingsObservation
} from './settings-observation'
import {
  configureSpeechAuthLeaseReaders,
  resetSpeechAuthLeaseReaders,
  refreshSpeechAuthLease,
  isSpeechAuthLeaseCurrent,
  observeSpeechAuthSettings,
  subscribeSpeechAuthLeaseInvalidation,
  type SpeechAuthLease
} from './auth'
import { readManagedSpeechPolicy } from './managed-speech-providers'
import { adminManagedConfigPath, readTrustedAdminManagedBytes } from './win-security'
import {
  setSpeechPolicyIdentityReader,
  invalidateSpeechPolicyProof,
  setSpeechPolicyProofRevocationListener,
  refreshModelPolicyChecked
} from './model-policy-client'
import { getSettings } from './store'
import { screenPermission } from './capture-permissions/screen-permission-runtime'

/** Actual Electron/store adapters: only explicit authority boundaries call these filesystem readers. */
export function speechDesktopBoundaryOptions() {
  let lease: SpeechAuthLease | null = null
  const actualPathsRevision = () => JSON.stringify([app.getPath('userData'), adminManagedConfigPath()])
  let pathsRevision = actualPathsRevision()
  configureSpeechAuthLeaseReaders({
    readSettingsAtBoundary: async () => {
      readSettingsAtAuthorityBoundary()
      return getPublishedSettingsObservation()
    },
    readSettingsEpoch: getSettingsObservationEpoch,
    readPolicyPathsRevision: () => pathsRevision,
    readTrustedAdminManagedBytes
  })
  return {
    requireAuth: () => isSpeechAuthLeaseCurrent(lease),
    prepareAuthentication: async () => {
      pathsRevision = actualPathsRevision()
      lease = await refreshSpeechAuthLease()
    },
    observeAuthenticationSettings: observeSpeechAuthSettings,
    observeAuthenticationRevocations: (listener: () => void) =>
      subscribeSpeechAuthLeaseInvalidation(() => {
        lease = null
        listener()
      }),
    releaseAuthentication: () => {
      lease = null
      resetSpeechAuthLeaseReaders()
    },
    observeSettings: observeSettingsSnapshot,
    readSettingsAtBoundary: readSettingsAtAuthorityBoundary,
    readSettingsEpoch: getSettingsObservationEpoch,
    installPolicyIdentityReader: setSpeechPolicyIdentityReader,
    invalidatePolicyProof: invalidateSpeechPolicyProof,
    observePolicyRevocations: setSpeechPolicyProofRevocationListener,
    refreshVerifiedPolicy: async () => {
      await refreshModelPolicyChecked(getSettings(), 'speech-boundary')
    },
    readPolicyPathsRevision: () => pathsRevision,
    readBoundaryMetadata: async () => ({
      durableDeviceId: getDurableMachineId(),
      managedPolicy: await readManagedSpeechPolicy(
        join(app.getPath('userData'), 'managed-config.json'),
        adminManagedConfigPath(),
        readTrustedAdminManagedBytes
      ),
      screenDiagnosisState: screenPermission().diagnose().state
    })
  }
}
