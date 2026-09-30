/**
 * screen-permission-runtime.ts — the Electron side of the Screen Recording diagnosis (M2-0429).
 *
 * The raw macOS status reads 'denied' both for a never-asked build and for a grant held by another copy or
 * build; screen-permission.ts tells them apart from the persisted history plus this build's identity. This
 * module owns the one process-wide instance of it and the call sites main needs: the boot init, a recorded
 * deliberate ask, the display-media screen source, and the boot half of a Repair. The instance is created on
 * first use, which the boot sequence forces early so the launch-time status is the real one.
 */
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import { getSettings, setSettings } from '../store'
import { auditLog, mainLog } from '../logger'
import { getBundleCopies, getCodeIdentity } from '../mac-helper'
import { probeScreenCapture, setScreenDiagnosisProvider, windowsScreenStatus } from '../platform-perms'
import { resumeScreenRepair } from '../permission-repair'
import { QA_IDENTITY_BUILD } from '../qa-hooks'
import { isUsableScreenSource } from '../screen-capture'
import { acquireLoopbackScreenSource } from './loopback-grant'
import { createScreenPermission, type ScreenPermission } from './screen-permission'

export const APP_BUNDLE_ID = QA_IDENTITY_BUILD ? 'com.mantu.asktoto.qa' : 'com.mantu.asktoto'
const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

let instance: ScreenPermission | null = null
export function screenPermission(): ScreenPermission {
  instance ??= createScreenPermission({
    platform: process.platform,
    appVersion: app.getVersion(),
    execPath: process.execPath,
    bundleId: APP_BUNDLE_ID,
    launchedAt: Math.round(Date.now() - process.uptime() * 1000),
    readStatus: () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : windowsScreenStatus()),
    getState: () => getSettings().permissionState,
    setState: (next) => {
      try {
        setSettings({ permissionState: next })
      } catch (e) {
        mainLog.warn('[permissions] could not persist Screen Recording history:', e instanceof Error ? e.message : String(e))
      }
    },
    loadIdentity: getCodeIdentity,
    loadCopies: getBundleCopies
  })
  return instance
}

/** Boot: pin the launch-time status, register the diagnosis with every permissions answer, and read this
 *  build's signature and installed copies in the background (read-only helper calls). */
export function initScreenPermission(): void {
  const sp = screenPermission()
  setScreenDiagnosisProvider(() => ({ screenDiagnosis: sp.diagnose(), identity: sp.identity() }))
  void sp.loadInstallFacts().catch((e) => mainLog.warn('[permissions] install facts unavailable:', e instanceof Error ? e.message : String(e)))
}

/** A deliberate ask (onboarding, the post-Repair boot, the Settings check): on macOS this capture is what
 *  registers the running build and raises the prompt, so it is recorded as this build's ask. */
export async function probeScreenWithHistory(): Promise<boolean> {
  screenPermission().noteAttempt()
  const ok = await probeScreenCapture()
  screenPermission().noteOutcome(ok)
  return ok
}

/** Deny a display-media request. Electron maps a null stream set to a clean capture failure; `{}` is rejected
 *  with a thrown TypeError when the request asked for video (the macOS loopback always does). Electron's
 *  typings do not list null, hence the cast. */
export const DENY_DISPLAY_MEDIA = null as unknown as Electron.Streams

/** The screen source for the Listen loopback, or null to deny. Never rejects (see loopback-grant.ts). */
export function acquireListenScreenSource(): Promise<Electron.DesktopCapturerSource | null> {
  return acquireLoopbackScreenSource<Electron.DesktopCapturerSource>({
    platform: process.platform,
    diagnose: () => screenPermission().diagnose(),
    getSources: () => desktopCapturer.getSources({ types: ['screen'] }),
    isUsable: isUsableScreenSource,
    noteAttempt: () => screenPermission().noteAttempt(),
    noteOutcome: (ok) => screenPermission().noteOutcome(ok),
    audit: (event, data) => auditLog(event, data),
    log: (message) => mainLog.warn(message)
  })
}

/** The boot half of a Repair the user just ran: re-probe once so this build is the one macOS lists, then
 *  open the Screen Recording pane. A no-op on every launch that does not follow a Repair, and off macOS. */
export function resumeScreenRepairOnBoot(): void {
  if (process.platform !== 'darwin') return
  void resumeScreenRepair({
    takePending: () => screenPermission().takePendingRepair(),
    probe: probeScreenWithHistory,
    openScreenRecordingPane: () => void shell.openExternal(SCREEN_RECORDING_PANE)
  })
}
