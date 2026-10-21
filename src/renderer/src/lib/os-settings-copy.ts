/**
 * The words every permission row uses when the operating system has refused something (C32, Apple HIG Privacy
 * and Settings): one action titled for the platform, opening the exact pane, and one sentence that says where to
 * click once it is open. Platform is a parameter so every row can be rendered for macOS and Windows on any host.
 *
 * Pane names: macOS 15 calls Screen Recording "Screen & System Audio Recording" and Login Items "Login Items &
 * Extensions" (macOS 13/14: "Screen Recording", "Login Items"); the copy names the shared start of each.
 */
import { isWindows } from './keys'

export type OsSettingsTarget = 'microphone' | 'screenRecording' | 'notifications' | 'loginItems'

/** The one button that opens the OS pane: macOS says System Settings, Windows says Settings. */
export function openSettingsTitle(windows: boolean = isWindows): 'Open System Settings' | 'Open Settings' {
  return windows ? 'Open Settings' : 'Open System Settings'
}

/** The one action when a change only applies to the next process (macOS Screen Recording). */
export const RELAUNCH_TITLE = 'Relaunch'

const WHERE: Record<OsSettingsTarget, { mac: string; windows: string }> = {
  microphone: {
    mac: 'Turn on Métis in System Settings › Privacy & Security › Microphone.',
    windows:
      'Turn on Microphone access and Let desktop apps access your microphone in Settings › Privacy & security › Microphone.'
  },
  screenRecording: {
    mac: 'Turn on Métis in System Settings › Privacy & Security › Screen & System Audio Recording, then relaunch Métis.',
    windows: 'Turn on screen capture for desktop apps in Settings › Privacy & security, on the page that opens.'
  },
  notifications: {
    mac: 'Turn on Allow Notifications for Métis in System Settings › Notifications.',
    windows: 'Turn on notifications for Métis in Settings › System › Notifications.'
  },
  loginItems: {
    mac: 'Turn on Métis in System Settings › General › Login Items.',
    windows: 'Turn on Métis in Settings › Apps › Startup.'
  }
}

/** Where to click in the pane the action opens. */
export function osSettingsWhere(target: OsSettingsTarget, windows: boolean = isWindows): string {
  return windows ? WHERE[target].windows : WHERE[target].mac
}
