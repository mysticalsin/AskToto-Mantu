/**
 * Cross-platform permission/status helpers for AskToto.
 *
 * macOS needs Accessibility + Screen Recording + Mic permissions.
 * Windows needs Mic permission (system audio is captured via loopback without a special permission),
 * and screen recording is per-capture via desktopCapturer (user must approve each app in Settings → Privacy).
 */

import { systemPreferences } from 'electron'

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'

export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
  accessibility: PermissionStatus
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
  // Electron does not expose a Windows mic permission API. We infer from navigator.getUserMedia at runtime
  // or treat it as unknown. The renderer will prompt via getUserMedia if needed.
  return 'unknown'
}

function windowsScreenStatus(): PermissionStatus {
  // Windows screen capture permission is per-app and checked when desktopCapturer is first used.
  return 'unknown'
}

function windowsAccessibilityStatus(): PermissionStatus {
  // Windows has no Accessibility permission for window enumeration; UI Automation works without it.
  return 'not-required'
}

export function getPlatformPermissions(): PlatformPermissions {
  if (process.platform === 'darwin') {
    return {
      microphone: macStatus('microphone'),
      screenRecording: macStatus('screen'),
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
    }
  }
  if (process.platform === 'win32') {
    return {
      microphone: windowsMicStatus(),
      screenRecording: windowsScreenStatus(),
      accessibility: 'not-required'
    }
  }
  return {
    microphone: 'not-required',
    screenRecording: 'not-required',
    accessibility: 'not-required'
  }
}
