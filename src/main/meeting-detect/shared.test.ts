import { describe, it, expect } from 'vitest'
import { titleLooksLikeMeeting, MEETING_KEYWORDS } from './shared'

describe('titleLooksLikeMeeting', () => {
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

describe('MEETING_KEYWORDS', () => {
  it('covers the major platforms', () => {
    expect(MEETING_KEYWORDS).toContain('zoom')
    expect(MEETING_KEYWORDS).toContain('google meet')
    expect(MEETING_KEYWORDS).toContain('teams meeting')
  })
})
