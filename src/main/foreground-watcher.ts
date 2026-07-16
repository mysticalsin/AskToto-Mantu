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
 * The watcher is Windows-only by design (the whole background-screen-preprocess feature targets the Windows
 * pilot). On other platforms startForegroundWatcher() returns an inert handle that never fires — callers
 * degrade to their existing behavior (no pre-describe), never crash.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface ForegroundInfo {
  /** Win32 HWND as a decimal string — stable per top-level window for its lifetime. */
  windowId: string
  /** Owning process id (distinguishes two windows of different apps that reuse an HWND value over time). */
  pid: number
  /** Window title (control chars stripped); may be '' for untitled/secure windows. */
  title: string
}

export interface ForegroundWatcher {
  /** Kill the watcher process and stop emitting. Idempotent. */
  stop: () => void
  /** The most recent foreground window observed, or null before the first event. */
  current: () => ForegroundInfo | null
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
      [Console]::Out.WriteLine(($hwnd.ToString() + $tab + $procId.ToString() + $tab + $title))
      [Console]::Out.Flush()
    }
  } catch {}
  Start-Sleep -Milliseconds 800
}
`.trim()

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
 * up and reports via onError. stop() cancels restarts and kills the process.
 */
export function startForegroundWatcher(
  onChange: (info: ForegroundInfo) => void,
  opts: WatcherOpts = {}
): ForegroundWatcher {
  const platform = opts.platform ?? process.platform
  let latest: ForegroundInfo | null = null
  let child: ChildProcess | null = null
  let stopped = false
  let restarts = 0
  let restartTimer: NodeJS.Timeout | null = null

  if (platform !== 'win32') {
    // Inert handle on non-Windows: the feature simply never pre-describes there.
    return { stop: () => {}, current: () => null }
  }

  const emit = (info: ForegroundInfo): void => {
    // Defensive re-dedupe (the script already dedupes) so a restart that re-emits the current window
    // doesn't fire a spurious change.
    if (latest && latest.windowId === info.windowId && latest.pid === info.pid) return
    latest = info
    onChange(info)
  }

  const spawnOnce = (): void => {
    if (stopped) return
    const encoded = Buffer.from(WATCHER_PS, 'utf16le').toString('base64')
    let proc: ChildProcess
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (e) {
      opts.onError?.(e instanceof Error ? e.message : String(e))
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
      opts.onError?.(e instanceof Error ? e.message : String(e))
    })
    proc.on('exit', () => {
      if (stopped) return
      if (restarts >= MAX_RESTARTS) {
        opts.onError?.('foreground watcher exited too many times; giving up for this session')
        return
      }
      restarts++
      restartTimer = setTimeout(spawnOnce, RESTART_BACKOFF_MS)
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
    current: () => latest
  }
}
