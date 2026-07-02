/**
 * Shared meeting-detection constants and helpers used across platforms.
 */

/** Window-title keywords that indicate an active meeting. */
export const MEETING_KEYWORDS = [
  'meeting',
  'zoom meeting',
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
  'calling',
  'in-call'
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
 * Teams shell tabs — titles whose prefix (before "| Microsoft Teams" or "| Teams") is
 * one of these are navigation/idle states, not active meetings.
 */
const TEAMS_SHELL_TABS = new Set([
  'chat',
  'activity',
  'calendar',
  'teams',
  'files',
  'settings',
  'calls',
  'store',
  'apps',
  'help',
  'home',
  'communities',
  'more',
  "what's new",
  'whats new',
  'tasks',
  'planner',
  'viva'
])

/**
 * Authoritative gate: returns true when a process/window pair represents an active meeting.
 *
 * @param procName - process name (lowercased or mixed — compared case-insensitively)
 * @param title    - window title (mixed case — compared case-insensitively internally)
 * @param customApps - user-supplied extra app names (Settings → custom meeting apps)
 */
export function isMeetingWindow(
  procName: string,
  title: string,
  customApps: string[] = []
): boolean {
  const p = procName.toLowerCase()
  const t = title.toLowerCase()

  // --- Custom apps (user-defined) -----------------------------------------------
  for (const app of customApps) {
    if (app && (p.includes(app.toLowerCase()) || t.includes(app.toLowerCase()))) return true
  }

  // --- Microsoft Teams -----------------------------------------------------------
  const isTeamsProc = p.includes('teams')
  const isTeamsTitle = t.includes('microsoft teams') || t.includes('| teams')

  if (isTeamsProc || isTeamsTitle) {
    // Bare "Microsoft Teams" / "Teams" with no pipe-delimited subject → idle shell
    if (t === 'microsoft teams' || t === 'teams') return false

    // Unambiguous in-call signals: safe to match anywhere in the full title.
    // 'call' is intentionally excluded here — 'Calls | Microsoft Teams' contains 'call'
    // as a substring and would produce a false positive.
    const TEAMS_UNAMBIGUOUS_SIGNALS = ['meeting', 'huddle', 'webinar', 'calling', 'in-call']
    if (TEAMS_UNAMBIGUOUS_SIGNALS.some((s) => t.includes(s))) return true

    // "Non-tab subject → meeting" heuristic only applies when we have a confirmed Teams
    // process (procName not empty). Without a proc name we can't distinguish a Teams
    // channel window ("General | Microsoft Teams") from a meeting window that has no
    // explicit call/meeting keyword — stay conservative and return false.
    if (!p) return false

    // Extract the subject prefix (the part before "| microsoft teams" or "| teams")
    const pipePatterns = ['| microsoft teams', '| teams']
    for (const pat of pipePatterns) {
      const idx = t.indexOf(pat)
      if (idx !== -1) {
        const prefix = t.slice(0, idx).trim()
        if (!prefix) return false // no subject → idle
        // If the prefix is a known shell tab, it's not a meeting.
        // This catches 'calls | microsoft teams' (prefix = 'calls') before we check
        // the ambiguous 'call' signal below.
        if (TEAMS_SHELL_TABS.has(prefix)) return false
        // All signals (including the ambiguous 'call') are safe to check against the
        // prefix alone, because the shell-tab guard above has already filtered out
        // the 'calls' navigation tab.
        const TEAMS_ALL_SIGNALS = [...TEAMS_UNAMBIGUOUS_SIGNALS, 'call']
        if (TEAMS_ALL_SIGNALS.some((s) => prefix.includes(s))) return true
        // Non-tab, non-empty subject with a confirmed Teams proc → meeting if:
        //   prefix has 2+ words (calendar event subjects always have 2+ words;
        //   single-word prefixes are typically channel names like "General", "Random")
        if (prefix.split(/\s+/).length >= 2) return true
        // Single-word, no signal → likely a channel window, not a meeting
        return false
      }
    }

    // Proc says Teams but title has no "| teams" / "| microsoft teams" pipe:
    // Check the ambiguous 'call' signal against the whole title (there is no
    // shell-tab pipe structure to confuse us here).
    if (t.includes('call')) return true

    // No pipe and no signal → not a meeting
    return false
  }

  // --- Zoom ----------------------------------------------------------------------
  const isZoomProc = p.includes('zoom')
  const isZoomTitle = t.includes('zoom')

  if (isZoomProc || isZoomTitle) {
    // Explicit meeting/webinar signals
    if (t.includes('zoom meeting') || t.includes('meeting') || t.includes('webinar')) return true
    // Idle Zoom home screen variants → not a meeting.
    // Explicit allowlist so 'zoom workplace - with alice' is not caught.
    const ZOOM_IDLE_TITLES = new Set([
      'zoom',
      'zoom workplace',
      'zoom workplace - home',
      'zoom workplace — home' // em-dash variant
    ])
    if (ZOOM_IDLE_TITLES.has(t)) return false
    // Any other zoom window — be conservative
    return false
  }

  // --- Slack ---------------------------------------------------------------------
  if (p.includes('slack') || t.includes('slack')) {
    return t.includes('huddle') || t.includes('call')
  }

  // --- Webex / GoTo --------------------------------------------------------------
  if (
    p.includes('webex') ||
    p.includes('gotomeeting') ||
    t.includes('webex') ||
    t.includes('gotomeeting') ||
    t.includes('gotowebinar')
  )
    return true

  // --- Generic fallback ----------------------------------------------------------
  return MEETING_KEYWORDS.some((kw) => t.includes(kw.toLowerCase()))
}

/**
 * Returns true if a window title looks like an active meeting rather than a chat window.
 * Delegates to isMeetingWindow with an empty process name.
 */
export function titleLooksLikeMeeting(title: string, customApps: string[] = []): boolean {
  return isMeetingWindow('', title, customApps)
}

/**
 * Decide whether a window-title-detected meeting should auto-start, cross-referenced against today's
 * calendar. Degrades OPEN (returns true) whenever the calendar cannot disprove it: a browser-URL meeting
 * (already high-confidence), an unavailable calendar (events === null — signed out / no Azure / Graph
 * error), or an empty agenda. Only an available, NON-empty agenda with NO title match returns false — which
 * suppresses a likely chat-window false positive like "Q4 Review | Microsoft Teams".
 *
 * @param detail  window-title part after the "app|" prefix (e.g. "Q4 Review | Microsoft Teams" or a join URL)
 * @param events  today's calendar events, or null when the calendar is unavailable
 */
export function titleMatchesCalendar(detail: string, events: { subject: string }[] | null): boolean {
  const d = detail.trim()
  if (!d || /^https?:\/\//i.test(d)) return true // browser meeting → already matched by URL pattern
  if (events === null) return true // calendar unavailable → keep title-only behavior
  if (events.length === 0) return true // nothing to match against → don't block
  const title = d.toLowerCase()
  return events.some((ev) => {
    const subj = ev.subject.trim().toLowerCase()
    // >=4 chars guards against tiny subjects ("Q4") matching half the window titles on screen.
    return subj.length >= 4 && (title.includes(subj) || subj.includes(title))
  })
}
