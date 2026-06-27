import { detectMac } from './mac'
import { detectWindows } from './win'

/** Returns "<app>|<detail>" when a live meeting is detected, else "". Never rejects. Cross-platform. */
export function detectMeeting(customApps: string[] = []): Promise<string> {
  if (process.platform === 'darwin') return detectMac(customApps)
  if (process.platform === 'win32') return detectWindows(customApps)
  // Linux: BY-DESIGN empty. AskToto targets macOS/Windows; meeting detection on Linux would require
  // a new implementation (e.g., parsing /proc or a desktop portal) and is not currently supported.
  return Promise.resolve('')
}
