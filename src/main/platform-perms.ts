/**
 * Cross-platform permission/status helpers for Métis.
 *
 * macOS needs Screen Recording + Mic permissions.
 * Windows needs Mic permission (system audio is captured via loopback without a special permission),
 * and screen recording is per-capture via desktopCapturer (user must approve each app in Settings → Privacy).
 */

import { systemPreferences } from 'electron'

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'

export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
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
  // Windows screen capture permission is per-app and checked when desktopCapturer is first used.
  return 'unknown'
}

export function getPlatformPermissions(): PlatformPermissions {
  if (process.platform === 'darwin') {
    return {
      microphone: macStatus('microphone'),
      screenRecording: macStatus('screen')
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
