/**
 * permission-repair.ts — one-click Screen Recording repair (M2-0429).
 *
 * When macOS shows Métis as allowed but the grant belongs to another copy or an older ad-hoc build, the only
 * fix is to drop that entry so the running build can be asked again. `/usr/bin/tccutil reset ScreenCapture
 * <bundle id>` does exactly that for one app, is Apple's own supported tool, and needs no elevation for the
 * user's own entry. This module runs it for THIS app's bundle id only — an allowlist, execFile with no shell,
 * a fixed argv — audits the outcome, and relaunches so the next process re-registers with macOS. It never
 * edits the permissions database, never elevates, and never claims a grant: the user still switches it on.
 *
 * If tccutil fails (an entry in the system database needs an admin), the caller shows the manual path instead:
 * remove Métis with "–" in the pane, then add it back with "+".
 */
import type { ScreenRepairResult } from '@shared/ipc'
import { SCREEN_REPAIR_MANUAL_GUIDANCE } from '@shared/screen-capture'

export { SCREEN_REPAIR_MANUAL_GUIDANCE }

/** The only bundle ids Repair may ever reset: the shipping app and its QA identity. */
export const REPAIRABLE_BUNDLE_IDS: readonly string[] = ['com.mantu.asktoto', 'com.mantu.asktoto.qa']
export const TCCUTIL_PATH = '/usr/bin/tccutil'
const TCCUTIL_TIMEOUT_MS = 10_000

/** child_process.execFile's error: `code` is the exit status, or a string errno when the spawn itself failed. */
type ExecError = Error & { code?: number | string | null }

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { shell: false; timeout: number; windowsHide: true },
  callback: (error: ExecError | null) => void
) => void

export interface ScreenRepairDeps {
  platform: NodeJS.Platform | string
  bundleId: string
  execFile: ExecFileLike
  audit: (event: 'permission.repair', data: { ok: boolean; exitCode: number | null }) => void
  /** Persist "a repair is pending" before the relaunch, so the next boot re-probes once. */
  onRepairStarted: () => void
  onRepairFailed: () => void
  relaunch: () => void
}

function exitCodeOf(error: ExecError | null): number | null {
  if (!error) return 0
  return typeof error.code === 'number' ? error.code : null
}

export function repairScreenPermission(deps: ScreenRepairDeps): Promise<ScreenRepairResult> {
  if (deps.platform !== 'darwin') {
    return Promise.resolve({ ok: false, reason: 'unsupported-platform', exitCode: null, guidance: '' })
  }
  if (!REPAIRABLE_BUNDLE_IDS.includes(deps.bundleId)) {
    return Promise.resolve({ ok: false, reason: 'bundle-not-allowed', exitCode: null, guidance: SCREEN_REPAIR_MANUAL_GUIDANCE })
  }
  return new Promise((resolve) => {
    deps.execFile(
      TCCUTIL_PATH,
      ['reset', 'ScreenCapture', deps.bundleId],
      { shell: false, timeout: TCCUTIL_TIMEOUT_MS, windowsHide: true },
      (error) => {
        const exitCode = exitCodeOf(error)
        const ok = error === null
        deps.audit('permission.repair', { ok, exitCode })
        if (!ok) {
          deps.onRepairFailed()
          resolve({ ok: false, reason: 'tccutil-failed', exitCode, guidance: SCREEN_REPAIR_MANUAL_GUIDANCE })
          return
        }
        deps.onRepairStarted()
        resolve({ ok: true })
        deps.relaunch()
      }
    )
  })
}

export interface ResumeRepairDeps {
  /** True exactly once after a Repair relaunch (consumes the pending flag). */
  takePending: () => boolean
  /** One real capture attempt: registers this build with macOS and raises its prompt. */
  probe: () => Promise<boolean>
  openScreenRecordingPane: () => void
}

/**
 * The boot half of Repair: re-probe once so this exact build is the one macOS lists, then open the pane so
 * the user can switch it on. Nothing happens on an ordinary launch.
 */
export async function resumeScreenRepair(deps: ResumeRepairDeps): Promise<void> {
  if (!deps.takePending()) return
  const granted = await deps.probe().catch(() => false)
  if (!granted) deps.openScreenRecordingPane()
}
