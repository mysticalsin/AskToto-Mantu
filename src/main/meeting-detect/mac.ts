import { execFile } from 'node:child_process'
import { desktopCapturer } from 'electron'
import { MEETING_URL_PATTERNS, isMeetingWindow, titleLooksLikeMeeting } from './shared'

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

/**
 * Base AppleScript: enumerates every window of every known native app and browser,
 * accumulating "appName|windowTitle" lines into `out` (newline-separated).
 * Does NOT return early on a keyword match — the JS side applies isMeetingWindow.
 */
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

repeat with appName in nativeApps
  set an to appName as text
  if procNames contains an then
    try
      tell application "System Events" to set wins to name of windows of process an
      repeat with w in wins
        set wt to w as text
        if out is "" then
          set out to an & "|" & wt
        else
          set out to out & linefeed & an & "|" & wt
        end if
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
        if out is "" then
          set out to bn & "|" & wt
        else
          set out to out & linefeed & bn & "|" & wt
        end if
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
  // Emit a per-browser guarded block so we only reference a browser's scripting
  // dictionary when that browser is actually running.  A machine without Chrome
  // must never see `using terms from application "Google Chrome"` — that causes
  // an osascript compile error even when the `tell` is never reached.
  const chromiumBlocks = CHROMIUM_BROWSERS.map((bn) => {
    const escaped = bn.replace(/"/g, '\\"')
    return `if procNames contains "${escaped}" then
  try
    using terms from application "${escaped}"
      tell application "${escaped}"
        repeat with w in windows
          repeat with t in tabs of w
            set us to URL of t as text
            if ${urlChecks} then return "${escaped}" & "|" & us
          end repeat
        end repeat
      end tell
    end using terms from
  end try
end if`
  }).join('\n\n')
  return `${buildBaseMacScript()}
-- Browser URL detection (requires browser Automation permission; isolated per browser).
-- Each block is guarded by procNames so absent browsers never touch their dictionary.
-- Returns early on first URL match (high-confidence signal — keep early return here).
${chromiumBlocks}

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

/**
 * Parse the accumulated "app|title" lines from AppleScript and return the first
 * line that isMeetingWindow considers an active meeting, or '' if none.
 */
function firstMeetingLine(raw: string, customApps: string[] = []): string {
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const pipeIdx = trimmed.indexOf('|')
    if (pipeIdx === -1) continue
    const appName = trimmed.slice(0, pipeIdx)
    const title = trimmed.slice(pipeIdx + 1)
    if (isMeetingWindow(appName, title, customApps)) return trimmed
  }
  return ''
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

  // Full script ran without error and returned real output (not a permission sentinel).
  // All window titles were already gathered in this pass — no need for a second AppleScript.
  const fullSucceeded =
    !full.err && full.stdout !== SYSTEM_EVENTS_DENIED

  if (fullSucceeded && full.stdout) {
    // Browser URL match comes back as a single "browser|url" line (early return in AppleScript).
    // It won't contain a newline and won't match firstMeetingLine's isMeetingWindow check
    // (URL != window title), so handle it first.
    const isUrlResult = MEETING_URL_PATTERNS.some((p) => full.stdout.includes(p))
    if (isUrlResult) return full.stdout

    // Apply the smart isMeetingWindow gate over all accumulated lines.
    const match = firstMeetingLine(full.stdout, customApps)
    if (match) return match
  }

  if (fullSucceeded) {
    // Full script ran cleanly but found no qualified meeting — window titles were already
    // enumerated above. For custom apps, fall through to the CGWindow pass (which can catch
    // apps the AppleScript list doesn't cover); for built-ins only, we're done.
    if (!customApps.length) return ''
    return detectMacByWindowTitles(customApps)
  }

  // Full script failed (e.g., missing Chrome dictionary) or System Events was denied.
  // Run the title-only script which skips the browser-URL block that can cause failures.
  if (full.stdout !== SYSTEM_EVENTS_DENIED) {
    const title = await runOsaScript(buildTitleOnlyMacScript())
    if (title.stdout && title.stdout !== SYSTEM_EVENTS_DENIED) {
      const match = firstMeetingLine(title.stdout, customApps)
      if (match) return match
    }
    if (!title.err && title.stdout !== SYSTEM_EVENTS_DENIED && !customApps.length) return ''
  }

  // AppleScript found nothing/was blocked: fall back to CGWindow-backed window titles (this is also the
  // only path that honors custom meeting apps; it needs Screen Recording permission to read titles).
  return detectMacByWindowTitles(customApps)
}
