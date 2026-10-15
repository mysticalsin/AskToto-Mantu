import { app } from 'electron'
import type { Settings } from '@shared/ipc'
import { readSettingsAtAuthorityBoundary } from './store'
import { getSettingsObservationEpoch } from './settings-observation'
import {
  captureAuthEnvironmentSnapshot,
  isAuthEnvironmentSnapshotCurrent,
  leaseEnforced,
  resolveLeaseConfig
} from './auth-config'
import { readSpeechAuthBoundary } from './auth-speech-boundary'
import type { SpeechAuthLeaseReaders, SpeechAuthSession } from './auth-speech-lease'
import { adminManagedConfigPath, readTrustedAdminManagedBytes } from './win-security'

/** Concrete, import-inert adapter for the C1 auth producer. It performs no work until called. */
export function createMainAuthBoundaryReader(readSession: () => SpeechAuthSession | null) {
  return async (isOriginalFenceCurrent: () => boolean) => {
    const environment = captureAuthEnvironmentSnapshot()
    const profilePath = app.getPath('userData')
    const adminPath = adminManagedConfigPath()
    const pathsRevision = JSON.stringify([profilePath, adminPath])
    const currentPathsRevision = () => JSON.stringify([app.getPath('userData'), adminManagedConfigPath()])
    let externalFenceRetired = false
    const isExternalFenceCurrent = () => {
      if (
        !isOriginalFenceCurrent() ||
        !isAuthEnvironmentSnapshotCurrent(environment) ||
        currentPathsRevision() !== pathsRevision
      )
        externalFenceRetired = true
      return !externalFenceRetired
    }
    const readers = {
      readSettingsAtBoundary: async () => {
        const snapshot = await readSettingsAtAuthorityBoundary()
        return {
          settings: snapshot.settings,
          readable: snapshot.readable,
          epoch: snapshot.epoch,
          authoritySnapshot: snapshot
        }
      },
      readSettingsEpoch: getSettingsObservationEpoch,
      readPolicyPathsRevision: () => pathsRevision,
      readTrustedAdminManagedBytes
    }
    return readSpeechAuthBoundary(readers, {
      readProfilePath: () => profilePath,
      readAdminPath: () => adminPath,
      readSession,
      resolveConfig: (settings: Settings, admin, user, sticky, lkg) =>
        resolveLeaseConfig(settings, admin, user, sticky, lkg, environment),
      isEnforced: (admin, user) => leaseEnforced(admin, user, environment),
      readEnvironmentSnapshot: () => environment,
      isExternalFenceCurrent
    })
  }
}

/** Speech-only compatibility reader; its result cannot mint a C1 persistence publication. */
export function createSpeechAuthBoundaryReader(readSession: () => SpeechAuthSession | null) {
  return (readers: SpeechAuthLeaseReaders) =>
    readSpeechAuthBoundary(readers, {
      readProfilePath: () => app.getPath('userData'),
      readAdminPath: adminManagedConfigPath,
      readSession,
      resolveConfig: resolveLeaseConfig,
      isEnforced: leaseEnforced
    })
}
