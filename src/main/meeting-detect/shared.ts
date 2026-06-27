/**
 * Shared meeting-detection constants and helpers used across platforms.
 */

/** Window-title keywords that indicate an active meeting. */
export const MEETING_KEYWORDS = [
  'meeting',
  'zoom',
  'zoom webinar',
  'call with',
  'in a call',
  'teams meeting',
  'microsoft teams call',
  'slack | huddle',
  'slack call',
  'huddle',
  'webex',
  'gotomeeting',
  'google meet',
  'conference',
  'webinar',
  'room'
]

/** Browser URL fragments used for more precise meeting detection. */
export const MEETING_URL_PATTERNS = [
  'meet.google.com/',
  'zoom.us/j/',
  'zoom.us/wc/',
  'teams.microsoft.com/l/meetup',
  'teams.live.com/meet',
  'whereby.com/',
  'webex.com/meet'
]

/**
 * Returns true if a window title looks like an active meeting rather than a chat window.
 * Used as a conservative filter after platform-specific detection.
 */
export function titleLooksLikeMeeting(title: string, customApps: string[] = []): boolean {
  const t = title.toLowerCase()
  // Slack/Teams chat-only windows should not trigger.
  if (t.includes('slack') && !t.includes('huddle') && !t.includes('call')) return false
  if (t.includes('teams') && !t.includes('meeting') && !t.includes('call')) return false
  // User-supplied custom meeting app names (e.g., "Around", "Chime", "Jitsi").
  for (const app of customApps) {
    if (app && t.includes(app.toLowerCase())) return true
  }
  return MEETING_KEYWORDS.some((kw) => t.includes(kw.toLowerCase()))
}
