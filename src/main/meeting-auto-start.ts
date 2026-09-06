/**
 * meeting-auto-start.ts — own a foreground-watcher and start Listen when a meeting app is joined.
 *
 * Does not restore Accessibility. Uses the existing watcher producer (Windows titles / macOS
 * NSWorkspace bundle ids). Does not auto-stop. One start per meeting session.
 */
import type { ForegroundInfo, ForegroundWatcher } from './foreground-watcher'
import {
  decideMeetingAutoStart,
  emptyMeetingAutoStartSession,
  meetingAutoStartWatcherEligible,
  type AutoStartGateSettings,
  type MeetingAutoStartSession,
  type MeetingPlatform
} from '@shared/meeting-auto-start'

export interface MeetingAutoStartDeps {
  startWatcher: (onChange: (info: ForegroundInfo) => void) => ForegroundWatcher
  getSettings: () => AutoStartGateSettings
  isListening: () => boolean
  startListen: (platform: MeetingPlatform) => void
  log?: (message: string) => void
  audit?: (event: 'meeting.auto_start', data: { platform: MeetingPlatform }) => void
}

export interface MeetingAutoStart {
  refresh: () => void
  stop: () => void
}

export function createMeetingAutoStart(deps: MeetingAutoStartDeps): MeetingAutoStart {
  let watcher: ForegroundWatcher | null = null
  let session: MeetingAutoStartSession = emptyMeetingAutoStartSession()

  const onChange = (info: ForegroundInfo): void => {
    const settings = deps.getSettings()
    if (!meetingAutoStartWatcherEligible(settings)) return
    const decision = decideMeetingAutoStart({
      info,
      settings,
      listening: deps.isListening(),
      session
    })
    session = decision.session
    if (!decision.fire || !decision.platform) return
    deps.log?.(`auto-start Listen for ${decision.platform}`)
    deps.audit?.('meeting.auto_start', { platform: decision.platform })
    deps.startListen(decision.platform)
  }

  const stop = (): void => {
    watcher?.stop()
    watcher = null
    session = emptyMeetingAutoStartSession()
  }

  const refresh = (): void => {
    const eligible = meetingAutoStartWatcherEligible(deps.getSettings())
    if (!eligible) {
      stop()
      return
    }
    if (watcher) return
    session = emptyMeetingAutoStartSession()
    watcher = deps.startWatcher(onChange)
  }

  return { refresh, stop }
}
