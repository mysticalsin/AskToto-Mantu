/**
 * Cross-platform permission/status helpers for Métis.
 *
 * macOS needs Screen Recording + Mic permissions.
 * Windows needs Mic permission (system audio is captured via loopback without a special permission),
 * and screen recording is per-capture via desktopCapturer (user must approve each app in Settings → Privacy).
 */

import { desktopCapturer, systemPreferences } from 'electron'

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'

export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
}

/**
 * Evidence from an ACTUAL capture attempt, rather than an OS flag.
 *
 * Windows has no queryable screen-recording permission: `systemPreferences.getMediaAccessStatus` has no
 * 'screen' accessType there, so status was hardcoded 'unknown' forever and the readiness UI could never
 * tell a Windows user whether screenshots would work until one failed mid-meeting. A 1px desktopCapturer
 * probe answers the only question that matters — can this app actually capture right now — and unlike on
 * macOS it raises no prompt, so it is safe to run unattended at startup.
 *
 * Null means "never probed"; callers fall back to 'unknown' rather than guessing 'granted'.
 */
let screenProbeResult: PermissionStatus | null = null

/** Test seam, and the reset point if the OS-level grant could have changed underneath us. */
export function clearScreenProbe(): void {
  screenProbeResult = null
}

/**
 * Attempt a minimal screen capture and remember whether it worked. Returns true when at least one
 * source came back. On macOS this ALSO registers the app with TCC and raises the system prompt, which is
 * why it is called during onboarding there rather than silently at boot.
 */
export async function probeScreenCapture(): Promise<boolean> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    })
    screenProbeResult = sources.length > 0 ? 'granted' : 'denied'
    return sources.length > 0
  } catch {
    // A throw here is the OS refusing the capture, which is exactly a denial.
    screenProbeResult = 'denied'
    return false
  }
}

function macStatus(accessType: 'microphone' | 'camera' | 'screen'): PermissionStatus {
  if (systemPreferences.getMediaAccessStatus) {
    const s = systemPreferences.getMediaAccessStatus(accessType)
    if (s === 'granted') return 'granted'
    if (s === 'denied') return 'denied'
  }
  return 'unknown'
}

function windowsMicStatus(): PermissionStatus {
  // systemPreferences.getMediaAccessStatus('microphone') is supported on win32 as well as darwin
  // (electron.d.ts marks it `@platform win32,darwin`) — it reads the Windows privacy toggle directly,
  // mapped the same way as the macOS path (macStatus above). It stays 'not-determined' (-> 'unknown')
  // until the app has actually attempted a capture once; the renderer probes via getUserMedia for that.
  return macStatus('microphone')
}

function windowsScreenStatus(): PermissionStatus {
  // Windows exposes no queryable screen-capture permission, so the only honest answer is whatever an
  // actual capture attempt produced (probeScreenCapture, run at startup). Unprobed stays 'unknown' —
  // never assume 'granted', or the readiness UI would promise a capability it has not demonstrated.
  return screenProbeResult ?? 'unknown'
}

export function getPlatformPermissions(): PlatformPermissions {
  if (process.platform === 'darwin') {
    // The TCC status is authoritative on macOS. Fall back to probe evidence only when TCC is
    // non-committal ('not-determined' → 'unknown'), so a successful capture still reads as ready.
    const screen = macStatus('screen')
    return {
      microphone: macStatus('microphone'),
      screenRecording: screen === 'unknown' ? (screenProbeResult ?? 'unknown') : screen
    }
  }
  if (process.platform === 'win32') {
    return {
      microphone: windowsMicStatus(),
      screenRecording: windowsScreenStatus()
    }
  }
  return {
    microphone: 'not-required',
    screenRecording: 'not-required'
  }
}
