/**
 * diagnose.ts — pure diagnosis of the Screen Recording permission (M2-0429).
 *
 * Meeting ("them") audio on macOS rides a ScreenCaptureKit screen stream, so it needs Screen Recording.
 * macOS pins that grant to one exact code identity (bundle id + designated requirement). Every ad-hoc build has
 * a new cdhash, and several installed copies can share the bundle id, so the switch a user sees ON in System
 * Settings can belong to a different build than the one running. The raw status cannot tell that apart:
 * Electron's getMediaAccessStatus('screen') is backed by CGPreflightScreenCaptureAccess, which only answers
 * granted or denied — a never-asked app, a denied app and a "grant not in effect for this build" app all read
 * 'denied'. This module combines the status with the history main persists (which build was asked, which
 * build last captured, whether the user attested it is on) and the install facts (duplicate copies,
 * translocation) into one state and the one action that can move it forward.
 *
 * Invariants:
 *  - 'restricted' (MDM / parental controls) stays its own state; it is never folded into 'denied' or unknown,
 *    because no user action in Métis can change it.
 *  - 'not-asked' is the ONLY non-granted state in which a capture attempt is allowed to reach macOS: that first
 *    attempt is what registers the app and raises the system prompt, and macOS asks only once per identity.
 *  - 'not-effective' never offers "open System Settings" as its action: that switch already shows on.
 */
import type {
  AppBundleCopy,
  AppIdentity,
  PermissionState,
  ScreenDiagnosis,
  ScreenDiagnosisAction,
  ScreenDiagnosisReason
} from '@shared/ipc'

export interface ScreenDiagnoseInput {
  platform: NodeJS.Platform | string
  /** darwin: the raw getMediaAccessStatus('screen'). win32: the capture-probe verdict ('granted' | 'denied' |
   *  'unknown'), since Windows exposes no queryable screen permission. */
  status: string
  /** darwin: the raw status read once when this process started. A grant that appears later in the same
   *  process is not applied to it by macOS until a relaunch. */
  statusAtLaunch: string
  identity: AppIdentity
  state: PermissionState
  /** When this process started (ms). An attestation older than this has already been through a relaunch. */
  launchedAt: number
  /** Other installed copies with this bundle id (this copy excluded). */
  duplicates: AppBundleCopy[]
  /** Running from an App Translocation mount (a quarantined app opened in place). */
  translocated: boolean
}

/** Same build: same version, and the same cdhash whenever both sides know it. An unknown cdhash (helper not
 *  answered yet) only compares versions, so a slow helper never reads as an identity change. */
export function sameIdentity(a: AppIdentity, b: AppIdentity): boolean {
  if (a.version !== b.version) return false
  return !a.cdhash || !b.cdhash || a.cdhash === b.cdhash
}

function result(
  state: ScreenDiagnosis['state'],
  action: ScreenDiagnosisAction,
  input: ScreenDiagnoseInput,
  reasons: ScreenDiagnosisReason[] = []
): ScreenDiagnosis {
  const grantedFor = input.state.screenGrantedFor
  return {
    state,
    reasons,
    action,
    duplicates: input.duplicates,
    grantedFor: grantedFor && !sameIdentity(grantedFor, input.identity) ? grantedFor : null,
    repairFailed: input.state.repairFailed
  }
}

export function diagnoseScreenPermission(input: ScreenDiagnoseInput): ScreenDiagnosis {
  if (input.platform === 'win32') {
    if (input.status === 'granted') return result('granted', 'none', input)
    if (input.status === 'denied') return result('denied', 'open-settings', input)
    return result('not-asked', 'request', input)
  }
  // No per-app screen permission to hold anything up on other platforms.
  if (input.platform !== 'darwin') return result('granted', 'none', input)

  if (input.status === 'restricted') return result('restricted', 'none', input)
  if (input.status === 'granted') {
    return input.statusAtLaunch === 'granted' ? result('granted', 'none', input) : result('needs-relaunch', 'relaunch', input)
  }

  const { state, identity, launchedAt } = input
  // The user just said it is on, in this very process: only the relaunch that goes with it can show whether
  // macOS agrees.
  if (state.attestedOnAt >= launchedAt) return result('needs-relaunch', 'relaunch', input)

  const reasons: ScreenDiagnosisReason[] = []
  const identityChanged = !!state.screenGrantedFor && !sameIdentity(state.screenGrantedFor, identity)
  const attestedBefore = state.attestedOnAt > 0
  if (identityChanged) reasons.push('identity-changed')
  if (input.duplicates.length > 0) reasons.push('duplicate-bundles')
  if (attestedBefore) reasons.push('attested-then-relaunched')
  if (input.translocated) reasons.push('translocated')

  const asked = !!state.screenAskedFor && sameIdentity(state.screenAskedFor, identity)
  // A build that last captured is not this one, or the user saw the switch on and a relaunch did not help:
  // the entry is known to serve something else, and another attempt by this build would fail silently.
  const knownElsewhere = identityChanged || attestedBefore
  if (!knownElsewhere && !asked) return result('not-asked', 'request', input, reasons)
  if (knownElsewhere || input.duplicates.length > 0 || input.translocated) {
    const action: ScreenDiagnosisAction = input.translocated
      ? 'move-to-applications'
      : state.repairFailed
        ? 'open-settings'
        : 'repair'
    return result('not-effective', action, input, reasons)
  }
  return result('denied', 'open-settings', input, reasons)
}

/** The only states in which a capture may reach the OS: working, or the first ask that raises the prompt. */
export function screenCaptureMayProceed(diagnosis: ScreenDiagnosis): boolean {
  return diagnosis.state === 'granted' || diagnosis.state === 'not-asked'
}

/** `/Applications/Metis.app/Contents/MacOS/Metis` → `/Applications/Metis.app`, or null outside a bundle. */
export function appBundlePathFromExecPath(execPath: string): string | null {
  const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match ? match[1] : null
}

/** macOS runs a quarantined app opened in place from a randomized read-only mount under /AppTranslocation/. */
export function isTranslocatedPath(execPath: string): boolean {
  return execPath.includes('/AppTranslocation/')
}

/** Every copy LaunchServices knows for the bundle id, minus the one running. */
export function otherBundleCopies(copies: AppBundleCopy[], ownBundlePath: string | null): AppBundleCopy[] {
  const own = ownBundlePath?.replace(/\/+$/, '')
  return copies.filter((c) => c.path.replace(/\/+$/, '') !== own)
}
