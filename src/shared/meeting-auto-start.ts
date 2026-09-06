/**
 * meeting-auto-start.ts — detect Teams / Zoom / Google Meet from a foreground-window snapshot
 * and decide whether Métis may start Listen.
 *
 * Pure: no Electron, no spawn, no Accessibility. The producer is main/foreground-watcher.ts
 * (Windows GetForegroundWindow titles; macOS NSWorkspace bundle id + localized app name).
 *
 * Runtime gate (hard): onboardingDone && recordingConsent. Settings defaults are ON, but
 * that only describes the saved preference. Before consent this module never says fire.
 */

export type MeetingPlatform = 'zoom' | 'teams' | 'meet'

/** Same shape as main/foreground-watcher ForegroundInfo (optional process is Windows-only). */
export interface MeetingForegroundInfo {
  windowId: string
  pid: number
  title: string
  /** Windows process name (Zoom, Teams, chrome, …). Absent on macOS helper lines. */
  process?: string
}

export type AutoStartMeetingsPref = {
  enabled: boolean
  zoom: boolean
  teams: boolean
  meet: boolean
}

export type AutoStartGateSettings = {
  onboardingDone: boolean
  recordingConsent: boolean
  autoStartMeetings: AutoStartMeetingsPref
}

export const DEFAULT_AUTO_START_MEETINGS: AutoStartMeetingsPref = {
  enabled: true,
  zoom: true,
  teams: true,
  meet: true
}

const ZOOM_BUNDLE = /^(us\.zoom\.xos|us\.zoom\.zoom)$/i
const TEAMS_BUNDLE = /^(com\.microsoft\.teams2|com\.microsoft\.teams)$/i
const MEET_BUNDLE = /google\.meet|googlemeet/i

const BROWSER_BUNDLE =
  /^(com\.google\.chrome|com\.google\.chrome\.canary|com\.microsoft\.edgemac|com\.microsoft\.edge|com\.apple\.safari|com\.brave\.browser|com\.operasoftware\.opera|org\.mozilla\.firefox|company\.thebrowser\.browser)/i
const BROWSER_PROCESS = /^(chrome|msedge|firefox|brave|opera|safari|iexplore|chromium)$/i
const BROWSER_TITLE_SUFFIX = /(google chrome|microsoft edge|firefox|brave|opera|safari|arc)$/i

const ZOOM_PROCESS = /^(zoom|zoom\.us)$/i
const TEAMS_PROCESS = /^(teams|ms-teams|msteams)$/i

function hay(info: MeetingForegroundInfo): { id: string; title: string; process: string } {
  return {
    id: (info.windowId ?? '').trim(),
    title: (info.title ?? '').trim(),
    process: (info.process ?? '').trim()
  }
}

export function isBrowserForeground(info: MeetingForegroundInfo): boolean {
  const { id, title, process } = hay(info)
  if (id && BROWSER_BUNDLE.test(id)) return true
  if (process && BROWSER_PROCESS.test(process)) return true
  if (title && BROWSER_TITLE_SUFFIX.test(title)) return true
  return false
}

function titleLooksLikeMeet(title: string): boolean {
  const t = title.toLowerCase()
  return t.includes('meet.google.com') || t.includes('google meet')
}

function isZoomNative(info: MeetingForegroundInfo): boolean {
  const { id, title, process } = hay(info)
  if (ZOOM_BUNDLE.test(id)) return true
  if (process && (ZOOM_PROCESS.test(process) || /zoom/i.test(process))) return true
  if (title && /\bzoom\b/i.test(title)) return true
  return false
}

function isTeamsNative(info: MeetingForegroundInfo): boolean {
  const { id, title, process } = hay(info)
  if (TEAMS_BUNDLE.test(id)) return true
  if (process && TEAMS_PROCESS.test(process)) return true
  if (title && /microsoft teams/i.test(title)) return true
  return false
}

/**
 * Classify the frontmost window. Browsers only match Google Meet (tab title must say
 * meet.google.com or Google Meet) so a Chrome doc about Zoom/Teams never starts Listen.
 */
export function matchMeetingPlatform(info: MeetingForegroundInfo): MeetingPlatform | null {
  const { id, title } = hay(info)
  if (isBrowserForeground(info)) {
    return titleLooksLikeMeet(title) ? 'meet' : null
  }
  if (isZoomNative(info)) return 'zoom'
  if (isTeamsNative(info)) return 'teams'
  if (titleLooksLikeMeet(title) || MEET_BUNDLE.test(id)) return 'meet'
  return null
}

/** Preference ON is not enough. Consent + finished onboarding are required every time. */
export function shouldAutoStartMeeting(
  settings: AutoStartGateSettings,
  platform: MeetingPlatform
): boolean {
  if (!settings.onboardingDone || !settings.recordingConsent) return false
  const pref = settings.autoStartMeetings
  if (!pref?.enabled) return false
  return pref[platform] === true
}

export type MeetingAutoStartSession = { platform: MeetingPlatform | null }

export function emptyMeetingAutoStartSession(): MeetingAutoStartSession {
  return { platform: null }
}

/**
 * One start per meeting session: while the same platform stays in front, do not fire again.
 * Leaving the meeting app (or switching to a different platform) opens a new session.
 * Never fires when already listening (do not auto-stop / restart).
 */
export function decideMeetingAutoStart(input: {
  info: MeetingForegroundInfo
  settings: AutoStartGateSettings
  listening: boolean
  session: MeetingAutoStartSession
}): { fire: boolean; platform: MeetingPlatform | null; session: MeetingAutoStartSession } {
  const platform = matchMeetingPlatform(input.info)
  if (!platform) {
    return { fire: false, platform: null, session: emptyMeetingAutoStartSession() }
  }
  if (input.session.platform === platform) {
    return { fire: false, platform, session: input.session }
  }
  const session: MeetingAutoStartSession = { platform }
  if (input.listening) return { fire: false, platform, session }
  return {
    fire: shouldAutoStartMeeting(input.settings, platform),
    platform,
    session
  }
}

/** Watcher should run only when a start is even possible. Before consent: never. */
export function meetingAutoStartWatcherEligible(settings: AutoStartGateSettings): boolean {
  return (
    !!settings.autoStartMeetings?.enabled &&
    !!settings.onboardingDone &&
    !!settings.recordingConsent
  )
}
