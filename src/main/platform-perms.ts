/**
 * Cross-platform permission/status helpers for Métis.
 *
 * macOS needs Screen Recording + Mic permissions.
 * Windows needs Mic permission (system audio is captured via loopback without a special permission),
 * and screen recording is per-capture via desktopCapturer (user must approve each app in Settings → Privacy).
 */

import { app, systemPreferences } from 'electron'
import { readFileSync } from 'node:fs'

export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'

export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
}

// TEMP QA SCAFFOLDING — DO NOT SHIP. Real Screen Recording TCC state can't be flipped from a headless
// test run, so this file-based override lets a Playwright driver simulate the user toggling System
// Settings mid-session (rewrite the file; the live-poll picks it up). Dev-only (!app.isPackaged).
function qaForcedScreenStatus(): PermissionStatus | null {
  if (app.isPackaged) return null
  const file = process.env.ASKTOTO_QA_FORCE_SCREEN_STATUS_FILE
  if (!file) return null
  try {
    const v = readFileSync(file, 'utf8').trim()
    return v === 'granted' || v === 'denied' || v === 'unknown' ? v : null
  } catch {
    return null
  }
}

function macStatus(accessType: 'microphone' | 'camera' | 'screen'): PermissionStatus {
  if (accessType === 'screen') {
    const forced = qaForcedScreenStatus()
    if (forced) return forced
  }
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
