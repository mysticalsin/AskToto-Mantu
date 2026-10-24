import { app } from 'electron'
import type { ImportJobState } from '@shared/import-jobs'
import type { UpdateBusyReason } from '@shared/update-lifecycle'
import { getPackageRuntimeContract } from '../features/components/speech-pack/package-runtime-state'
import { mainLog } from '../logger'
import { getCodeIdentityUnderVerification } from '../mac-helper'
import { desktopActionTaskStatuses } from '../tasks/desktop-action-task-runtime'
import { defaultHelperReverifyDeps, reverifyHelpers } from './helper-reverify'
import { updateBusyReasons } from './update-busy'
import type { ReconcileDeps, UpdaterDeps } from '../updater'

/** The facts index.ts owns; everything else the update lifecycle needs is read here. */
export interface UpdateBusySources {
  meetingReserved(): boolean
  /** captureActiveForWindowRestart(): listening, armed audio, legacy listening, cloud speech owner. */
  captureActive(): boolean
  leasePurpose(): string | null
  importStates(): readonly ImportJobState[]
}

export function createUpdateBusyReader(sources: UpdateBusySources): () => UpdateBusyReason[] {
  return () =>
    updateBusyReasons({
      meetingReserved: sources.meetingReserved(),
      captureActive: sources.captureActive(),
      leasePurpose: sources.leasePurpose(),
      taskStatuses: desktopActionTaskStatuses(),
      importStates: sources.importStates()
    })
}

export function createUpdaterDeps(sources: UpdateBusySources): Pick<UpdaterDeps, 'busyReasons'> {
  return { busyReasons: createUpdateBusyReader(sources) }
}

/** Boot-time reconcile after an install: re-verifies native helpers against the signed package. */
export function createReconcileDeps(): ReconcileDeps {
  const exe = app.getPath('exe')
  const bundleEnd = exe.indexOf('.app/')
  return {
    userDataDir: () => app.getPath('userData'),
    currentVersion: app.getVersion(),
    reverify: () =>
      reverifyHelpers(
        defaultHelperReverifyDeps({
          platform: process.platform,
          arch: process.arch,
          resourcesPath: process.resourcesPath,
          appBundlePath: bundleEnd > 0 ? exe.slice(0, bundleEnd + 4) : null,
          contract: getPackageRuntimeContract,
          getCodeIdentity: getCodeIdentityUnderVerification,
          log: (message) => mainLog.info(message)
        })
      )
  }
}
