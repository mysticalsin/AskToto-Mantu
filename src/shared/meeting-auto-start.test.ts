import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_START_MEETINGS,
  decideMeetingAutoStart,
  emptyMeetingAutoStartSession,
  isBrowserForeground,
  matchMeetingPlatform,
  meetingAutoStartWatcherEligible,
  shouldAutoStartMeeting,
  type AutoStartGateSettings,
  type MeetingForegroundInfo
} from './meeting-auto-start'

function fg(partial: Partial<MeetingForegroundInfo> & Pick<MeetingForegroundInfo, 'windowId' | 'title'>): MeetingForegroundInfo {
  return { pid: 100, ...partial }
}

const ready: AutoStartGateSettings = {
  onboardingDone: true,
  recordingConsent: true,
  autoStartMeetings: { ...DEFAULT_AUTO_START_MEETINGS }
}

describe('matchMeetingPlatform', () => {
  it('matches Zoom by mac bundle us.zoom.xos', () => {
    expect(matchMeetingPlatform(fg({ windowId: 'us.zoom.xos', title: 'zoom.us' }))).toBe('zoom')
  })

  it('matches Zoom by Windows title or process', () => {
    expect(
      matchMeetingPlatform(fg({ windowId: '442211', title: 'Zoom Meeting', process: 'Zoom' }))
    ).toBe('zoom')
    expect(matchMeetingPlatform(fg({ windowId: '1', title: 'Zoom Workplace', process: 'Zoom' }))).toBe(
      'zoom'
    )
    expect(matchMeetingPlatform(fg({ windowId: '1', title: 'Weekly standup', process: 'Zoom' }))).toBe(
      'zoom'
    )
  })

  it('matches Teams by com.microsoft.teams2 and com.microsoft.teams', () => {
    expect(matchMeetingPlatform(fg({ windowId: 'com.microsoft.teams2', title: 'Microsoft Teams' }))).toBe(
      'teams'
    )
    expect(matchMeetingPlatform(fg({ windowId: 'com.microsoft.teams', title: 'Microsoft Teams' }))).toBe(
      'teams'
    )
  })

  it('matches Teams by Windows title or process', () => {
    expect(
      matchMeetingPlatform(
        fg({ windowId: '99', title: 'Standup | Microsoft Teams', process: 'ms-teams' })
      )
    ).toBe('teams')
    expect(matchMeetingPlatform(fg({ windowId: '99', title: 'Microsoft Teams', process: 'Teams' }))).toBe(
      'teams'
    )
  })

  it('matches Google Meet in a browser title (meet.google.com or Google Meet)', () => {
    expect(
      matchMeetingPlatform(
        fg({
          windowId: 'com.google.Chrome',
          title: 'Standup - meet.google.com - Google Chrome'
        })
      )
    ).toBe('meet')
    expect(
      matchMeetingPlatform(
        fg({
          windowId: '1234',
          title: 'Design review - Google Meet - Google Chrome',
          process: 'chrome'
        })
      )
    ).toBe('meet')
    expect(
      matchMeetingPlatform(
        fg({
          windowId: '55',
          title: 'Meet - Google Meet - Microsoft Edge',
          process: 'msedge'
        })
      )
    ).toBe('meet')
  })

  it('does not match random Chrome docs, Finder, or Slack', () => {
    expect(
      matchMeetingPlatform(
        fg({
          windowId: 'com.google.Chrome',
          title: 'How to use Zoom - Google Docs - Google Chrome'
        })
      )
    ).toBeNull()
    expect(
      matchMeetingPlatform(
        fg({
          windowId: 'com.google.Chrome',
          title: 'Building high-performing teams - Google Docs - Google Chrome'
        })
      )
    ).toBeNull()
    expect(matchMeetingPlatform(fg({ windowId: 'com.apple.finder', title: 'Finder' }))).toBeNull()
    expect(
      matchMeetingPlatform(fg({ windowId: 'com.tinyspeck.slackmacgap', title: 'Slack' }))
    ).toBeNull()
    expect(
      matchMeetingPlatform(fg({ windowId: '88', title: 'Inbox - Slack', process: 'Slack' }))
    ).toBeNull()
  })

  it('treats Chrome / Edge / Safari as browsers so Zoom-in-a-tab is not Zoom', () => {
    expect(
      isBrowserForeground(fg({ windowId: 'com.google.Chrome', title: 'Google Chrome' }))
    ).toBe(true)
    expect(
      matchMeetingPlatform(fg({ windowId: 'com.google.Chrome', title: 'Zoom - Google Chrome' }))
    ).toBeNull()
    expect(
      matchMeetingPlatform(fg({ windowId: 'com.apple.Safari', title: 'Safari' }))
    ).toBeNull()
  })
})

describe('shouldAutoStartMeeting runtime gate', () => {
  it('defaults prefer ON but still require onboardingDone and recordingConsent', () => {
    expect(DEFAULT_AUTO_START_MEETINGS).toEqual({
      enabled: true,
      zoom: true,
      teams: true,
      meet: true
    })
    expect(shouldAutoStartMeeting(ready, 'zoom')).toBe(true)
    expect(
      shouldAutoStartMeeting({ ...ready, onboardingDone: false }, 'zoom')
    ).toBe(false)
    expect(
      shouldAutoStartMeeting({ ...ready, recordingConsent: false }, 'teams')
    ).toBe(false)
    expect(
      shouldAutoStartMeeting(
        { ...ready, onboardingDone: false, recordingConsent: false },
        'meet'
      )
    ).toBe(false)
  })

  it('honors the master switch and per-platform toggles', () => {
    expect(
      shouldAutoStartMeeting(
        { ...ready, autoStartMeetings: { ...ready.autoStartMeetings, enabled: false } },
        'zoom'
      )
    ).toBe(false)
    expect(
      shouldAutoStartMeeting(
        { ...ready, autoStartMeetings: { ...ready.autoStartMeetings, zoom: false } },
        'zoom'
      )
    ).toBe(false)
    expect(
      shouldAutoStartMeeting(
        { ...ready, autoStartMeetings: { ...ready.autoStartMeetings, zoom: false } },
        'teams'
      )
    ).toBe(true)
    expect(
      shouldAutoStartMeeting(
        { ...ready, autoStartMeetings: { ...ready.autoStartMeetings, meet: false } },
        'meet'
      )
    ).toBe(false)
  })

  it('does not start the watcher before consent', () => {
    expect(meetingAutoStartWatcherEligible(ready)).toBe(true)
    expect(meetingAutoStartWatcherEligible({ ...ready, recordingConsent: false })).toBe(false)
    expect(meetingAutoStartWatcherEligible({ ...ready, onboardingDone: false })).toBe(false)
    expect(
      meetingAutoStartWatcherEligible({
        ...ready,
        autoStartMeetings: { ...ready.autoStartMeetings, enabled: false }
      })
    ).toBe(false)
  })
})

describe('decideMeetingAutoStart session debounce', () => {
  const zoom = fg({ windowId: 'us.zoom.xos', title: 'zoom.us' })
  const teams = fg({ windowId: 'com.microsoft.teams2', title: 'Microsoft Teams' })
  const finder = fg({ windowId: 'com.apple.finder', title: 'Finder' })

  it('fires once when joining, then stays quiet for the same platform', () => {
    const first = decideMeetingAutoStart({
      info: zoom,
      settings: ready,
      listening: false,
      session: emptyMeetingAutoStartSession()
    })
    expect(first.fire).toBe(true)
    expect(first.platform).toBe('zoom')

    const again = decideMeetingAutoStart({
      info: fg({ windowId: 'us.zoom.xos', title: 'Zoom Meeting', pid: 101 }),
      settings: ready,
      listening: false,
      session: first.session
    })
    expect(again.fire).toBe(false)
    expect(again.session.platform).toBe('zoom')
  })

  it('resets the session when leaving the meeting app so a later join can fire', () => {
    const joined = decideMeetingAutoStart({
      info: zoom,
      settings: ready,
      listening: false,
      session: emptyMeetingAutoStartSession()
    })
    const left = decideMeetingAutoStart({
      info: finder,
      settings: ready,
      listening: false,
      session: joined.session
    })
    expect(left.fire).toBe(false)
    expect(left.session.platform).toBeNull()

    const rejoined = decideMeetingAutoStart({
      info: zoom,
      settings: ready,
      listening: false,
      session: left.session
    })
    expect(rejoined.fire).toBe(true)
  })

  it('never fires while already listening (does not auto-stop)', () => {
    const decision = decideMeetingAutoStart({
      info: teams,
      settings: ready,
      listening: true,
      session: emptyMeetingAutoStartSession()
    })
    expect(decision.fire).toBe(false)
    expect(decision.session.platform).toBe('teams')
  })

  it('does not fire before consent even when the matcher hits', () => {
    const decision = decideMeetingAutoStart({
      info: zoom,
      settings: { ...ready, recordingConsent: false },
      listening: false,
      session: emptyMeetingAutoStartSession()
    })
    expect(decision.fire).toBe(false)
    expect(decision.platform).toBe('zoom')
  })
})
