/**
 * screen-permission-ipc.ts — the Screen Recording permission IPC surface (M2-0429).
 *
 * Every handler checks its sender with the caller's assertMainWindow. Repair resets ONLY this app's Screen
 * Recording entry (allowlisted bundle id, fixed argv, execFile with no shell), audits permission.repair and
 * relaunches; the next boot re-probes once and opens the pane (resumeScreenRepairOnBoot). On failure the
 * renderer shows the manual remove-then-add guidance.
 */
import { app, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { auditLog } from '../logger'
import { repairScreenPermission } from '../permission-repair'
import { execFileNoShell } from '../infra/process/exec-file'
import { APP_BUNDLE_ID, screenPermission } from '../capture-permissions/screen-permission-runtime'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

function relaunch(): void {
  app.relaunch()
  app.quit()
}

export function registerScreenPermissionIpc(assertMainWindow: AssertMainWindow): void {
  // Deep-link to the relevant macOS Privacy pane once a permission has been denied — getUserMedia never
  // re-prompts after a Deny, so without this a denied user has no in-app path back to granting it. The
  // x-apple.systempreferences scheme only exists on macOS; a no-op elsewhere.
  ipcMain.handle(IPC.permissionsOpenSettings, (e, kind: unknown) => {
    assertMainWindow(e)
    if (process.platform === 'darwin') {
      const pane = kind === 'screenRecording' ? 'Privacy_ScreenCapture' : 'Privacy_Microphone'
      void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
      return
    }
    if (process.platform === 'win32') {
      // Windows has no single TCC-style "Screen Recording" permission like macOS; the closest deep link
      // is the App graphics capture privacy page (added in the Windows 10 2004 update). Picked over the
      // generic 'ms-settings:privacy' page because it's the actual per-capability toggle; on Windows
      // builds that predate it, an unrecognized ms-settings URI opens the Settings home instead of
      // erroring, so no separate fallback URI is needed here.
      const uri = kind === 'screenRecording' ? 'ms-settings:privacy-graphicscaptureprogrammatic' : 'ms-settings:privacy-microphone'
      void shell.openExternal(uri)
    }
  })
  ipcMain.handle(IPC.permissionsRepairScreen, async (e) => {
    assertMainWindow(e)
    return await repairScreenPermission({
      platform: process.platform,
      bundleId: APP_BUNDLE_ID,
      execFile: execFileNoShell,
      audit: (event, data) => auditLog(event, data),
      onRepairStarted: () => screenPermission().noteRepairStarted(),
      onRepairFailed: () => screenPermission().noteRepairFailed(),
      relaunch
    })
  })
  // "It's already on": the user sees Métis switched on in System Settings. Record it and relaunch; if this
  // build still cannot capture after that, the diagnosis says the switch belongs to another copy or build.
  ipcMain.handle(IPC.permissionsAttestScreen, (e) => {
    assertMainWindow(e)
    if (process.platform !== 'darwin') return
    screenPermission().attest()
    relaunch()
  })
  // Show a duplicate copy in Finder. Only a path the diagnosis itself listed is accepted, never an arbitrary
  // renderer-supplied one.
  ipcMain.handle(IPC.permissionsRevealCopy, (e, path: unknown) => {
    assertMainWindow(e)
    if (typeof path !== 'string') return
    if (!screenPermission().diagnose().duplicates.some((copy) => copy.path === path)) return
    shell.showItemInFolder(path)
  })
}
