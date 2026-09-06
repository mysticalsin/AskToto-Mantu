/**
 * foreground-watcher.ts — emit an event whenever the OS foreground (active) window changes.
 *
 * Electron has no cross-platform "active window changed" signal and this app deliberately ships no native
 * modules (active-win / ffi would add a compiled dependency + a fresh Windows-portability surface, the exact
 * class of bug this build spent days fixing). The lightest dependency-free option on Windows is a SINGLE
 * long-lived PowerShell process that P/Invokes GetForegroundWindow in a tight loop and prints ONE line only
 * when the window changes — so main reads a trickle of change events, not a poll-per-second spawn storm
 * (each powershell.exe cold start is ~100-300ms; spawning one every second would dwarf the work it does).
 *
 * macOS uses the same protocol from a different producer: the bundled `metis-mac-helper watch-frontmost`
 * Swift sidecar prints one identical `windowId \t pid \t title` line per NSWorkspace app activation
 * (windowId = bundle id; app-level granularity — intra-app window/tab switches are covered by
 * screen-preprocess's periodic content re-check, so no Accessibility permission is needed). Everything
 * downstream of the spawn — parsing, dedupe, restart budget, stop() — is shared between the platforms.
 *
 * On platforms with no producer (linux, or a mac install missing the helper binary)
 * startForegroundWatcher() returns an inert handle that never fires — callers degrade to their existing
 * behavior (no event-driven pre-describe), never crash.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { macWatcherSpawnSpec } from './mac-helper'
import { WINDOWS_POWERSHELL } from './win-security'

export interface ForegroundInfo {
  /** Windows: Win32 HWND as a decimal string — stable per top-level window for its lifetime.
   *  macOS: the frontmost app's bundle id (e.g. com.apple.finder) — app-level granularity. */
  windowId: string
  /** Owning process id (distinguishes two windows of different apps that reuse an HWND value over time). */
  pid: number
  /** Windows: window title. macOS: localized app name. Control chars/tabs stripped; may be ''. */
  title: string
  /** Windows: process name (Zoom, Teams, chrome). Omitted on 3-field mac helper lines. */
  process?: string
}

export interface ForegroundWatcher {
  /** Kill the watcher process and stop emitting. Idempotent. */
  stop: () => void
  /** The most recent foreground window observed, or null before the first event. */
  current: () => ForegroundInfo | null
  /** False when this handle can no longer report window changes at all: an inert platform (no producer,
   *  or a mac install missing the bundled helper), a producer that exhausted its restart budget, or a
   *  stopped watcher. Callers that INVALIDATE state on window changes must treat false as "the signal is
   *  gone" and stop trusting anything keyed to a window — a watcher that has given up looks exactly like
   *  a user who never switches apps (MQA-181). */
  healthy: () => boolean
}

/**
 * Parse one `HWND\tPID\tTITLE` line emitted by the watcher script into a ForegroundInfo. Exported for unit
 * tests (the spawn itself is Windows integration). Returns null for blank/malformed lines so a stray line
 * never yields a bogus window with NaN pid. The title keeps everything after the second tab verbatim (a
 * title can't contain a tab — the script strips them — but joining is safe if one ever slips through).
 */
export function parseForegroundLine(line: string): ForegroundInfo | null {
  const trimmed = line.replace(/[\r\n]+$/, '')
  if (!trimmed) return null
  const parts = trimmed.split('\t')
  if (parts.length < 2) return null
  const windowId = parts[0].trim()
  const pid = Number(parts[1])
  if (!windowId || !Number.isFinite(pid)) return null
  // 4-field Windows lines: HWND, pid, title, process. 3-field mac helper lines stay title-only.
  if (parts.length >= 4) {
    return { windowId, pid, title: parts[2], process: parts[3] }
  }
  return { windowId, pid, title: parts.slice(2).join('\t') }
}

// PowerShell 5.1 (always present on Windows) — Add-Type the three user32 calls once, then loop forever,
// printing only when the (HWND,PID) pair changes. Start-Sleep keeps CPU near zero between checks.
// Deliberately BACKTICK-FREE (backticks would terminate this JS template literal): tabs come from
// [char]9, and the title's control-char strip uses a single-quoted .NET regex (\t\r\n are regex escapes).
const WATCHER_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$tab = [char]9
$last = ''
while ($true) {
  try {
    $h = [FgWin]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][FgWin]::GetWindowText($h, $sb, $sb.Capacity)
    $procId = [uint32]0
    [void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $hwnd = $h.ToInt64()
    $key = "$hwnd-$procId"
    if ($key -ne $last) {
      $last = $key
      $title = ($sb.ToString() -replace '[\\t\\r\\n]', ' ')
      $procName = ''
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) { $procName = ($p.ProcessName -replace '[\\t\\r\\n]', '') }
      [Console]::Out.WriteLine(($hwnd.ToString() + $tab + $procId.ToString() + $tab + $title + $tab + $procName))
      [Console]::Out.Flush()
    }
  } catch {}
  Start-Sleep -Milliseconds 800
}
`.trim()

/**
 * The Windows producer's spawn spec — mirrors macWatcherSpawnSpec() for the other platform. Exported so
 * a unit test can assert the command without spawning a real powershell. The command is the pinned
 * absolute System32 path, never a bare `powershell.exe`: Windows' CreateProcess search order consults the
 * current working directory before PATH, so a bare name lets an attacker-planted binary in an
 * attacker-writable cwd run instead (see win-security.ts).
 */
export function winWatcherSpawnSpec(): { command: string; args: string[] } {
  return {
    command: WINDOWS_POWERSHELL,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(WATCHER_PS, 'utf16le').toString('base64')
    ]
  }
}

interface WatcherOpts {
  /** Injected for tests / non-standard platforms. Defaults to process.platform. */
  platform?: NodeJS.Platform
  onError?: (message: string) => void
}

const MAX_RESTARTS = 5
const RESTART_BACKOFF_MS = 2000

/**
 * Start watching the foreground window. `onChange` fires once per distinct active window (debounce/settle
 * is the caller's concern — this reports raw changes). The watcher self-restarts a crashed script up to
 * MAX_RESTARTS times (a killed powershell shouldn't silently end the feature for the session), then gives
 * up, reports via onError, and flips healthy() to false so callers can stop trusting the window signal.
 * stop() cancels restarts and kills the process.
 */
export function startForegroundWatcher(
  onChange: (info: ForegroundInfo) => void,
  opts: WatcherOpts = {}
): ForegroundWatcher {
  const platform = opts.platform ?? process.platform
  let latest: ForegroundInfo | null = null
  let child: ChildProcess | null = null
  let stopped = false
  let gaveUp = false
  let restarts = 0
  let restartTimer: NodeJS.Timeout | null = null

  // Resolve the per-platform producer command up front. No producer → inert handle: the feature simply
  // never pre-describes event-driven on that platform (mac additionally requires the bundled helper).
  let spawnSpec: { command: string; args: string[] } | null = null
  if (platform === 'win32') {
    spawnSpec = winWatcherSpawnSpec()
  } else if (platform === 'darwin') {
    spawnSpec = macWatcherSpawnSpec()
  }
  if (!spawnSpec) {
    return { stop: () => {}, current: () => null, healthy: () => false }
  }
  const { command, args } = spawnSpec

  const emit = (info: ForegroundInfo): void => {
    // Defensive re-dedupe (the script already dedupes) so a restart that re-emits the current window
    // doesn't fire a spurious change.
    if (latest && latest.windowId === info.windowId && latest.pid === info.pid) return
    latest = info
    onChange(info)
  }

  const spawnOnce = (): void => {
    if (stopped) return
    // One restart per attempt, whatever combination of error/exit/close the failure produces.
    let settled = false
    /** Every way an attempt can die routes here: a synchronous spawn throw, an async 'error' (ENOENT/
     *  EACCES — where node emits 'close' and NEVER 'exit', so hanging the restart off 'exit' alone left
     *  the watcher permanently dead while still claiming to watch), and a normal exit. */
    const failed = (message: string): void => {
      if (stopped || gaveUp || settled) return
      settled = true
      opts.onError?.(message)
      if (restarts >= MAX_RESTARTS) {
        gaveUp = true
        opts.onError?.('foreground watcher failed too many times; giving up for this session')
        return
      }
      restarts++
      restartTimer = setTimeout(spawnOnce, RESTART_BACKOFF_MS)
    }
    let proc: ChildProcess
    try {
      proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e))
      return
    }
    child = proc
    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const info = parseForegroundLine(line)
        if (info) emit(info)
      }
    })
    // stderr is drained (never buffered unbounded) but not surfaced line-by-line — a transient P/Invoke
    // hiccup is caught inside the loop; a fatal spawn/parse error shows up as an early exit handled below.
    proc.stderr?.on('data', () => {})
    proc.on('error', (e: Error) => {
      failed(e instanceof Error ? e.message : String(e))
    })
    proc.on('exit', () => {
      failed('foreground watcher exited')
    })
  }

  spawnOnce()

  return {
    stop: () => {
      stopped = true
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      if (child) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        child = null
      }
    },
    current: () => latest,
    healthy: () => !stopped && !gaveUp
  }
}
