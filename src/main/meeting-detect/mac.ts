import { execFile } from 'node:child_process'
import { desktopCapturer } from 'electron'
import { MEETING_KEYWORDS, MEETING_URL_PATTERNS, titleLooksLikeMeeting } from './shared'

const MAC_NATIVE_APPS = [
  'zoom.us',
  'Microsoft Teams',
  'Microsoft Teams (work or school)',
  'MSTeams',
  'Cisco Webex Meetings',
  'Webex',
  'RingCentral',
  'GoTo Meeting',
  'GoTo',
  'Slack',
  'Discord'
]

const MAC_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Vivaldi', 'Arc', 'Safari']
const CHROMIUM_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Vivaldi']

const SYSTEM_EVENTS_DENIED = 'SYSTEM_EVENTS_DENIED'

function appleStringList(items: string[]): string {
  return items.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(', ')
}

function buildBaseMacScript(): string {
  return `
set out to ""
set sysEventsFailed to false
try
  tell application "System Events" to set procNames to name of every process
on error
  set procNames to {}
  set sysEventsFailed to true
end try

set nativeApps to {${appleStringList(MAC_NATIVE_APPS)}}
set browsers to {${appleStringList(MAC_BROWSERS)}}
set keywords to {${appleStringList(MEETING_KEYWORDS)}}

repeat with appName in nativeApps
  set an to appName as text
  if procNames contains an then
    try
      tell application "System Events" to set wins to name of windows of process an
      repeat with w in wins
        set wt to w as text
        repeat with kw in keywords
          ignoring case
            if wt contains (kw as text) then return an & "|" & wt
          end ignoring
        end repeat
      end repeat
    end try
  end if
end repeat

repeat with bName in browsers
  set bn to bName as text
  if procNames contains bn then
    try
      tell application "System Events" to set wins to name of windows of process bn
      repeat with w in wins
        set wt to w as text
        repeat with kw in keywords
          ignoring case
            if wt contains (kw as text) then return bn & "|" & wt
          end ignoring
        end repeat
      end repeat
    end try
  end if
end repeat
`
}

function buildTitleOnlyMacScript(): string {
  return `${buildBaseMacScript()}
if sysEventsFailed then return "${SYSTEM_EVENTS_DENIED}"
return out
`
}

function buildFullMacScript(): string {
  const urlChecks = MEETING_URL_PATTERNS.map((p) => `us contains "${p}"`).join(' or ')
  return `${buildBaseMacScript()}
-- Browser URL detection (requires browser Automation permission; isolated per browser).
repeat with bName in {${appleStringList(CHROMIUM_BROWSERS)}}
  set bn to bName as text
  if procNames contains bn then
    try
      using terms from application "Google Chrome"
        tell application bn
          repeat with w in windows
            repeat with t in tabs of w
              set us to URL of t as text
              if ${urlChecks} then return bn & "|" & us
            end repeat
          end repeat
        end tell
      end using terms from
    end try
  end if
end repeat

if procNames contains "Arc" then
  try
    using terms from application "Google Chrome"
      tell application "Arc"
        repeat with w in windows
          repeat with t in tabs of w
            set us to URL of t as text
            if ${urlChecks} then return "Arc|" & us
          end repeat
        end repeat
      end tell
    end using terms from
  end try
end if

if procNames contains "Safari" then
  try
    tell application "Safari"
      repeat with w in windows
        repeat with t in tabs of w
          set us to URL of t as text
          if ${urlChecks} then return "Safari|" & us
        end repeat
      end repeat
    end tell
  end try
end if

if sysEventsFailed then return "${SYSTEM_EVENTS_DENIED}"
return out
`
}

function runOsaScript(script: string): Promise<{ stdout: string; err: Error | null }> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 4500 }, (err, stdout) => {
      resolve({ stdout: (stdout || '').trim(), err: err || null })
    })
  })
}

/** CGWindow-backed fallback: enumerate window titles without AppleScript/Accessibility. */
async function detectMacByWindowTitles(customApps: string[] = []): Promise<string> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    for (const source of sources) {
      if (titleLooksLikeMeeting(source.name, customApps)) return `CGWindow|${source.name}`
    }
  } catch {
    // Fail open.
  }
  return ''
}

export async function detectMac(customApps: string[] = []): Promise<string> {
  const full = await runOsaScript(buildFullMacScript())
  if (full.stdout && full.stdout !== SYSTEM_EVENTS_DENIED) return full.stdout

  // Full script succeeded but found nothing. Still give user-defined custom apps a window-title pass
  // (the AppleScript only knows the built-in browsers/apps) before giving up.
  if (!full.err && full.stdout !== SYSTEM_EVENTS_DENIED && !customApps.length) return ''

  // Full script failed (e.g., missing Chrome dictionary) or System Events was denied.
  if (full.stdout !== SYSTEM_EVENTS_DENIED) {
    const title = await runOsaScript(buildTitleOnlyMacScript())
    if (title.stdout && title.stdout !== SYSTEM_EVENTS_DENIED) return title.stdout
    if (!title.err && title.stdout !== SYSTEM_EVENTS_DENIED && !customApps.length) return ''
  }

  // AppleScript found nothing/was blocked: fall back to CGWindow-backed window titles (this is also the
  // only path that honors custom meeting apps; it needs Screen Recording permission to read titles).
  return detectMacByWindowTitles(customApps)
}
