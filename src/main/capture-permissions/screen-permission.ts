/**
 * screen-permission.ts — the live side of the Screen Recording diagnosis (M2-0429).
 *
 * diagnose.ts is pure; this module owns the facts it needs and the history it learns from:
 *  - the status read once at process start (a grant that appears later needs a relaunch);
 *  - this build's identity (version + cdhash from metis-mac-helper `code-identity`) and the other installed
 *    copies of the bundle id (`bundle-copies`), loaded once in the background;
 *  - the persisted history in settings.permissionState: which build let an attempt reach macOS, which build
 *    last captured, and whether the user attested the switch is on.
 *
 * Dependency-injected (no Electron import) so the history rules are unit-tested directly. Persistence only
 * happens when a value actually changes, so a capture that keeps succeeding never rewrites the profile.
 */
import type { AppBundleCopy, AppIdentity, CodeIdentity, PermissionState, ScreenDiagnosis } from '@shared/screen-permission'
import {
  appBundlePathFromExecPath,
  diagnoseScreenPermission,
  isTranslocatedPath,
  otherBundleCopies,
  sameIdentity
} from './diagnose'

export interface ScreenPermissionDeps {
  platform: NodeJS.Platform | string
  appVersion: string
  execPath: string
  bundleId: string
  launchedAt: number
  /** darwin: raw getMediaAccessStatus('screen'). win32: the capture-probe verdict. */
  readStatus: () => string
  getState: () => PermissionState
  setState: (next: PermissionState) => void
  loadIdentity: (bundlePath: string) => Promise<{ cdhash: string; teamId: string; adhoc: boolean } | null>
  loadCopies: (bundleId: string) => Promise<AppBundleCopy[] | null>
  now?: () => number
}

export interface ScreenPermission {
  loadInstallFacts: () => Promise<void>
  diagnose: () => ScreenDiagnosis
  identity: () => CodeIdentity | null
  /** A capture attempt is about to reach macOS — the one that raises its prompt for this build. */
  noteAttempt: () => void
  /** A real capture finished: success proves which build the grant serves. */
  noteOutcome: (succeeded: boolean) => void
  /** The user says the switch is already on; the relaunch that follows decides. */
  attest: () => void
  /** Repair reset the entry: forget every per-build fact so the next attempt asks macOS afresh. */
  noteRepairStarted: () => void
  noteRepairFailed: () => void
  /** Consume a pending post-repair re-probe. True exactly once after a Repair relaunch. */
  takePendingRepair: () => boolean
  bundlePath: string | null
}

export function createScreenPermission(deps: ScreenPermissionDeps): ScreenPermission {
  const now = deps.now ?? (() => Date.now())
  const statusAtLaunch = deps.readStatus()
  const bundlePath = appBundlePathFromExecPath(deps.execPath)
  let identity: CodeIdentity | null = null
  let duplicates: AppBundleCopy[] = []

  const appIdentity = (): AppIdentity => ({ version: deps.appVersion, cdhash: identity?.cdhash ?? '' })
  const update = (patch: Partial<PermissionState>): void => {
    const cur = deps.getState()
    const next = { ...cur, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(cur)) deps.setState(next)
  }

  const diagnose = (): ScreenDiagnosis =>
    diagnoseScreenPermission({
      platform: deps.platform,
      status: deps.readStatus(),
      statusAtLaunch,
      identity: appIdentity(),
      state: deps.getState(),
      launchedAt: deps.launchedAt,
      duplicates,
      translocated: isTranslocatedPath(deps.execPath)
    })

  return {
    bundlePath,
    loadInstallFacts: async () => {
      if (deps.platform !== 'darwin' || !bundlePath) return
      const [id, copies] = await Promise.all([deps.loadIdentity(bundlePath), deps.loadCopies(deps.bundleId)])
      if (id) identity = { version: deps.appVersion, cdhash: id.cdhash, teamId: id.teamId, adhoc: id.adhoc }
      if (copies) duplicates = otherBundleCopies(copies, bundlePath)
    },
    diagnose,
    identity: () => identity,
    noteAttempt: () => {
      if (deps.platform !== 'darwin') return
      const asked = deps.getState().screenAskedFor
      if (!asked || !sameIdentity(asked, appIdentity())) update({ screenAskedFor: appIdentity() })
    },
    noteOutcome: (succeeded) => {
      if (deps.platform !== 'darwin' || !succeeded) return
      update({ screenAskedFor: appIdentity(), screenGrantedFor: appIdentity(), attestedOnAt: 0, repairFailed: false })
    },
    attest: () => update({ attestedOnAt: now() }),
    noteRepairStarted: () =>
      update({ screenAskedFor: null, screenGrantedFor: null, attestedOnAt: 0, repairStartedAt: now(), repairFailed: false }),
    noteRepairFailed: () => update({ repairFailed: true, repairStartedAt: 0 }),
    takePendingRepair: () => {
      if (!deps.getState().repairStartedAt) return false
      update({ repairStartedAt: 0 })
      return true
    }
  }
}
