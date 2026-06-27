import { execFile } from 'node:child_process'
import { MEETING_KEYWORDS, MEETING_URL_PATTERNS, titleLooksLikeMeeting } from './shared'

export const TEAMS_TOKENS = ['teams meeting', 'microsoft teams call', 'teams call']
export const SLACK_TOKENS = ['slack | huddle', 'slack call', 'huddle', 'slack huddle']

const PS_LIST_WINDOWS =
  "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { \"$($_.ProcessName)|$($_.MainWindowTitle)\" }"

/**
 * Windows UI Automation script to grab the active browser tab URL from Chrome/Edge/Brave.
 * Falls back gracefully if UI Automation is unavailable.
 */
const PS_BROWSER_URL = `
Add-Type -AssemblyName UIAutomationClient
$cond = [System.Windows.Automation.AutomationElement]::RootElement
function Get-ActiveBrowserUrl($procName) {
  $proc = Get-Process | Where-Object { $_.ProcessName -eq $procName -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { return $null }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if (-not $root) { return $null }
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $eds = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($el in $eds) {
    try {
      $val = $el.GetCurrentPattern([System.Windows.Automation.PatternIdentifiers]::ValuePattern)
      if ($val) {
        $v = $val.Current.Value
        if ($v -match '^(https?://|www\\.)') { return $v }
      }
    } catch {}
  }
  return $null
}
$names = @('chrome','msedge','brave')
foreach ($n in $names) {
  $url = Get-ActiveBrowserUrl $n
  if ($url) { Write-Output "$n|$url"; break }
}
`

function runPowerShell(script: string, timeout = 4500): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('')
        resolve((stdout || '').trim())
      }
    )
  })
}

/** Native app detection by process name + window title. */
async function detectNativeApps(customApps: string[] = []): Promise<string> {
  const stdout = await runPowerShell(PS_LIST_WINDOWS)
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('|')
    const procName = (parts[0] || '').toLowerCase()
    const title = parts.slice(1).join('|')

    if (nativeWindowMatches(procName, title, customApps)) {
      return trimmed
    }
  }
  return ''
}

/**
 * Pure function to decide whether a single Windows process/window pair is a meeting.
 * Exported for unit testing.
 */
export function nativeWindowMatches(procName: string, title: string, customApps: string[] = []): boolean {
  const p = procName.toLowerCase()
  const t = title.toLowerCase()

  for (const app of customApps) {
    if (app && (p.includes(app.toLowerCase()) || t.includes(app.toLowerCase()))) return true
  }

  if (p.includes('zoom') && t.includes('meeting')) return true
  if (
    p.includes('teams') &&
    (TEAMS_TOKENS.some((token) => t.includes(token)) ||
      (t.includes('teams') && MEETING_KEYWORDS.some((k) => t.includes(k.toLowerCase()))))
  )
    return true
  if (
    p.includes('slack') &&
    (SLACK_TOKENS.some((token) => t.includes(token)) ||
      (t.includes('slack') && MEETING_KEYWORDS.some((k) => t.includes(k.toLowerCase()))))
  )
    return true
  if (p.includes('webex') || p.includes('gotomeeting')) return true
  const compact = t.replace(/\s+/g, '')
  if (compact.includes('gotomeeting') || compact.includes('gotowebinar')) return true
  return false
}

/** Browser URL detection via UI Automation. */
async function detectBrowserUrl(): Promise<string> {
  const stdout = await runPowerShell(PS_BROWSER_URL, 6000)
  if (!stdout) return ''
  const parts = stdout.split('|')
  const procName = parts[0] || ''
  const url = parts.slice(1).join('|')
  const urlLower = url.toLowerCase()
  if (MEETING_URL_PATTERNS.some((p) => urlLower.includes(p))) {
    return `${procName}|${url}`
  }
  return ''
}

/** Window-title fallback using desktopCapturer (disabled in production on Windows by content protection). */
// async function detectByWindowTitles(): Promise<string> {
//   // Electron's desktopCapturer on Windows requires the app itself be capturable;
//   // using it here is risky and slow. We prefer UIA and native title matching.
//   return ''
// }

export async function detectWindows(customApps: string[] = []): Promise<string> {
  // Try browser URL detection first (most precise for Google Meet/Teams web).
  const browser = await detectBrowserUrl()
  if (browser) return browser

  // Fall back to native app window titles.
  const native = await detectNativeApps(customApps)
  if (native) return native

  return ''
}
