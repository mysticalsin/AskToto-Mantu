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
import { registerPermissionHelperIpc } from './permission-helper-ipc'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

const MAC_PANES: Record<string, string> = {
  microphone: 'Privacy_Microphone',
  screenRecording: 'Privacy_ScreenCapture',
  // G10: macOS-only lists; Windows has no per-app consent for these, so it has no page to open.
  accessibility: 'Privacy_Accessibility',
  inputMonitoring: 'Privacy_ListenEvent',
  automation: 'Privacy_Automation'
}
const WINDOWS_PAGES: Record<string, string> = {
  microphone: 'ms-settings:privacy-microphone',
  screenRecording: 'ms-settings:privacy-graphicscaptureprogrammatic'
}

/**
 * The privacy pane for one permission, or null for any other kind or platform. macOS: the Privacy & Security
 * pane's anchor. Windows: the per-capability page; programmatic graphics capture arrived in Windows 10 2004,
 * and an older build opens the Settings home for an unknown ms-settings URI rather than failing. Accessibility,
 * Input Monitoring and Automation exist on macOS only.
 */
export function permissionSettingsUrl(platform: NodeJS.Platform, kind: unknown): string | null {
  if (typeof kind !== 'string' || !Object.hasOwn(MAC_PANES, kind)) return null
  if (platform === 'darwin') return `x-apple.systempreferences:com.apple.preference.security?${MAC_PANES[kind]}`
  if (platform === 'win32') return Object.hasOwn(WINDOWS_PAGES, kind) ? WINDOWS_PAGES[kind] : null
  return null
}

function relaunch(): void {
  app.relaunch()
  app.quit()
}

export function registerScreenPermissionIpc(assertMainWindow: AssertMainWindow): void {
  // Deep-link to the exact privacy pane once a permission has been denied: getUserMedia never re-prompts after
  // a Deny, so without this a denied user has no in-app path back to granting it. Only the allowlisted
  // kinds open anything (permissionSettingsUrl).
  ipcMain.handle(IPC.permissionsOpenSettings, (e, kind: unknown) => {
    assertMainWindow(e)
    const url = permissionSettingsUrl(process.platform, kind)
    if (url) void shell.openExternal(url)
  })
  // C32 Part D: the guided grant helper beside the pane (drag Métis into the list, then turn it on).
  registerPermissionHelperIpc({
    assertMainWindow,
    paneUrl: (kind) => permissionSettingsUrl(process.platform, kind),
    relaunch
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
    if (
      !screenPermission()
        .diagnose()
        .duplicates.some((copy) => copy.path === path)
    )
      return
    shell.showItemInFolder(path)
  })
}
