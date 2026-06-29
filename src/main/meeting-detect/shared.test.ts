import { describe, it, expect } from 'vitest'
import { isMeetingWindow, titleLooksLikeMeeting, titleMatchesCalendar, MEETING_KEYWORDS } from './shared'

// ---------------------------------------------------------------------------
// isMeetingWindow — Teams (meeting = true)
// ---------------------------------------------------------------------------
describe('isMeetingWindow — Teams meetings (should return true)', () => {
  it('subject-titled Teams window: "Weekly Sync | Microsoft Teams"', () => {
    expect(isMeetingWindow('MSTeams', 'Weekly Sync | Microsoft Teams')).toBe(true)
  })

  it('subject-titled Teams window: "Project Standup | Microsoft Teams"', () => {
    expect(isMeetingWindow('MSTeams', 'Project Standup | Microsoft Teams')).toBe(true)
  })

  it('explicit meeting signal: "Meeting | Microsoft Teams"', () => {
    expect(isMeetingWindow('Microsoft Teams', 'Meeting | Microsoft Teams')).toBe(true)
  })

  it('explicit call signal: "Call with Acme | Microsoft Teams"', () => {
    expect(isMeetingWindow('MSTeams', 'Call with Acme | Microsoft Teams')).toBe(true)
  })

  it('Q4 Review meeting in title', () => {
    expect(isMeetingWindow('Teams', 'Q4 Review — Teams meeting')).toBe(true)
  })

  it('Microsoft Teams call in title', () => {
    expect(isMeetingWindow('Teams', 'Microsoft Teams call')).toBe(true)
  })

  it('Teams Call in title', () => {
    expect(isMeetingWindow('Teams', 'Teams Call')).toBe(true)
  })

  it('Q4 Review with Teams call suffix', () => {
    expect(isMeetingWindow('Teams', 'Q4 Review | Microsoft Teams call')).toBe(true)
  })

  it('meeting keyword before pipe', () => {
    expect(isMeetingWindow('Teams', 'Q4 Review meeting | Microsoft Teams')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isMeetingWindow — Teams (non-meeting = false)
// ---------------------------------------------------------------------------
describe('isMeetingWindow — Teams non-meetings (should return false)', () => {
  it('Chat tab', () => {
    expect(isMeetingWindow('MSTeams', 'Chat | Microsoft Teams')).toBe(false)
  })

  it('Activity tab', () => {
    expect(isMeetingWindow('MSTeams', 'Activity | Microsoft Teams')).toBe(false)
  })

  it('Calendar tab', () => {
    expect(isMeetingWindow('MSTeams', 'Calendar | Microsoft Teams')).toBe(false)
  })

  it('Bare "Microsoft Teams" title', () => {
    expect(isMeetingWindow('MSTeams', 'Microsoft Teams')).toBe(false)
  })

  it('General channel window (old format)', () => {
    expect(isMeetingWindow('Teams', 'General | Microsoft Teams')).toBe(false)
  })

  it('Chat channel window', () => {
    expect(isMeetingWindow('Teams', 'Chat | Microsoft Teams')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isMeetingWindow — Zoom (meeting = true)
// ---------------------------------------------------------------------------
describe('isMeetingWindow — Zoom meetings (should return true)', () => {
  it('"Zoom Meeting" title', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom Meeting')).toBe(true)
  })

  it('"Meeting" title on zoom proc', () => {
    expect(isMeetingWindow('zoom.us', 'Meeting')).toBe(true)
  })

  it('nativeWindowMatches compat: zoom proc + meeting title', () => {
    expect(isMeetingWindow('zoom', 'Zoom Meeting')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isMeetingWindow — Zoom (non-meeting = false)
// ---------------------------------------------------------------------------
describe('isMeetingWindow — Zoom non-meetings (should return false)', () => {
  it('"Zoom Workplace" is idle home screen', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom Workplace')).toBe(false)
  })

  it('"Zoom" alone is idle', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom')).toBe(false)
  })

  it('"Zoom Workplace — Home" variant', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom Workplace — Home')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// titleLooksLikeMeeting — Google Meet / Webex / Slack
// ---------------------------------------------------------------------------
describe('titleLooksLikeMeeting — specific platforms', () => {
  it('Google Meet title returns true', () => {
    expect(titleLooksLikeMeeting('Project Sync - Google Meet')).toBe(true)
  })

  it('Webex returns true', () => {
    expect(titleLooksLikeMeeting('Webex')).toBe(true)
  })

  it('Webex meeting title returns true', () => {
    expect(titleLooksLikeMeeting('Client Sync — Webex Meeting')).toBe(true)
  })

  it('Slack huddle returns true', () => {
    expect(titleLooksLikeMeeting('Engineering | Slack | huddle')).toBe(true)
  })

  it('Slack call returns true', () => {
    expect(titleLooksLikeMeeting('slack call')).toBe(true)
  })

  it('Slack chat-only returns false', () => {
    expect(titleLooksLikeMeeting('Project | Slack')).toBe(false)
  })

  it('GoToMeeting returns true', () => {
    expect(titleLooksLikeMeeting('GoTo Meeting')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// titleLooksLikeMeeting — existing passing cases
// ---------------------------------------------------------------------------
describe('titleLooksLikeMeeting (existing cases)', () => {
  it('detects common meeting titles', () => {
    expect(titleLooksLikeMeeting('Zoom Meeting')).toBe(true)
    expect(titleLooksLikeMeeting('Google Meet — Q4 Review')).toBe(true)
    expect(titleLooksLikeMeeting('Webex')).toBe(true)
  })

  it('rejects Slack/Teams chat-only windows', () => {
    expect(titleLooksLikeMeeting('Project | Slack')).toBe(false)
    expect(titleLooksLikeMeeting('General | Microsoft Teams')).toBe(false)
  })

  it('honours user-supplied custom apps', () => {
    expect(titleLooksLikeMeeting('Around — standup', ['Around'])).toBe(true)
    expect(titleLooksLikeMeeting('Chime', ['Chime'])).toBe(true)
    expect(titleLooksLikeMeeting('VS Code', ['Around'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// MEETING_KEYWORDS sanity check (updated: 'zoom' removed as standalone keyword)
// ---------------------------------------------------------------------------
describe('MEETING_KEYWORDS', () => {
  it('covers the major platforms', () => {
    expect(MEETING_KEYWORDS).toContain('google meet')
    expect(MEETING_KEYWORDS).toContain('teams meeting')
    expect(MEETING_KEYWORDS).toContain('webex')
    expect(MEETING_KEYWORDS).toContain('meeting')
  })

  it('does not contain standalone "zoom" (handled by isMeetingWindow logic)', () => {
    // 'zoom' alone caused idle Zoom home false-positives; removed from generic list.
    expect(MEETING_KEYWORDS).not.toContain('zoom')
  })
})

// ---------------------------------------------------------------------------
// isMeetingWindow — custom apps
// ---------------------------------------------------------------------------
describe('isMeetingWindow — custom apps', () => {
  it('matches custom app in proc name', () => {
    expect(isMeetingWindow('around', 'Weekly standup', ['Around'])).toBe(true)
  })

  it('matches custom app in title', () => {
    expect(isMeetingWindow('chrome', 'Client call — Chime', ['Chime'])).toBe(true)
  })

  it('rejects unrelated proc with custom app configured', () => {
    expect(isMeetingWindow('Code', 'main.ts - AskToto', ['Around'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isMeetingWindow regressions (audit)
// ---------------------------------------------------------------------------
describe('isMeetingWindow regressions (audit)', () => {
  it('Teams Calls tab is NOT a meeting', () => {
    expect(isMeetingWindow('MSTeams', 'Calls | Microsoft Teams')).toBe(false)
  })

  it('real Teams call IS a meeting', () => {
    expect(isMeetingWindow('MSTeams', 'Call with Alice | Microsoft Teams')).toBe(true)
  })

  it('Teams call window without pipe IS a meeting', () => {
    expect(isMeetingWindow('MSTeams', 'Teams Call')).toBe(true)
  })

  it('Zoom Workplace - Home is NOT a meeting', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom Workplace - Home')).toBe(false)
  })

  it('bare Zoom is NOT a meeting', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom')).toBe(false)
  })

  it('Zoom Meeting IS a meeting', () => {
    expect(isMeetingWindow('zoom.us', 'Zoom Meeting')).toBe(true)
  })
})

describe('titleMatchesCalendar — auto-start gating against the agenda', () => {
  const events = [{ subject: 'Q3 Roadmap Review' }, { subject: 'Standup' }, { subject: '1:1 with Sam' }]

  it('degrades OPEN when the calendar is unavailable (null)', () => {
    expect(titleMatchesCalendar('Q4 Review | Microsoft Teams', null)).toBe(true)
  })

  it('degrades OPEN on an empty agenda (nothing to match against)', () => {
    expect(titleMatchesCalendar('Q4 Review | Microsoft Teams', [])).toBe(true)
  })

  it('always allows a browser-URL meeting regardless of the agenda', () => {
    expect(titleMatchesCalendar('https://teams.microsoft.com/l/meetup-join/xyz', [])).toBe(true)
    expect(titleMatchesCalendar('https://meet.google.com/abc-defg-hij', events)).toBe(true)
  })

  it('allows when the window title matches a calendar event (substring, either direction)', () => {
    expect(titleMatchesCalendar('Q3 Roadmap Review | Microsoft Teams', events)).toBe(true)
    expect(titleMatchesCalendar('Standup', events)).toBe(true)
  })

  it('SUPPRESSES a non-matching title when the agenda is available and non-empty', () => {
    // The motivating false positive: a Teams chat window with no matching calendar event.
    expect(titleMatchesCalendar('Random Banter | Microsoft Teams', events)).toBe(false)
  })

  it('ignores sub-4-char event subjects so tiny names can not match everything', () => {
    expect(titleMatchesCalendar('Planning sync', [{ subject: 'AI' }])).toBe(false)
  })

  it('empty / whitespace detail degrades open', () => {
    expect(titleMatchesCalendar('   ', events)).toBe(true)
  })
})
