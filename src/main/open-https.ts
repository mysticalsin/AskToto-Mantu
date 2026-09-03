import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { shell } from 'electron'
import { mainLog } from './logger'

/**
 * Open an https URL in the user's default browser without letting a Windows spawn quirk abort the
 * caller (the Dust "Set up Dust automatically" Spawn EINVAL failure).
 *
 * Why this exists: `shell.openExternal` is the right first try, but on Windows it can reject with
 * `Error: spawn EINVAL` when the registered browser handler is a `.cmd`/`.bat` shim — Node's
 * CVE-2024-27980 mitigation refuses to CreateProcess those directly. That rejection used to bubble
 * out of beginDustDeviceLogin's catch as the raw "spawn EINVAL" string and abort a sign-in that had
 * already minted a valid device code. The consent page never mattered for minting; the user can
 * finish in a tab they open themselves. So:
 *   1. Try Electron's openExternal.
 *   2. On Windows, fall back to `cmd.exe /c start "" <url>` — cmd.exe is a real .exe (pinned under
 *      System32), `start` uses ShellExecute, and we never spawn a .cmd handler ourselves.
 *   3. macOS/Linux fall back to `open` / `xdg-open` the same way.
 *   4. Still never throw for a browser-open failure — callers that already hold a device code should
 *      keep going and show the manual link.
 *
 * SECURITY: only https is accepted. openExternal / start / open / xdg-open are all scheme-dispatch
 * primitives; a non-https URL off the wire would pick the handler (ms-msdt, file:, …). Callers must
 * already gate, and this function re-checks so a mistaken call cannot widen the surface.
 */

function system32(name: string): string {
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\${name}`
}

function comSpecExe(): string {
  const cs = process.env.ComSpec
  return cs && isAbsolute(cs) ? cs : system32('cmd.exe')
}

export function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

/** Spawn a short-lived OS opener; resolves once the child has started (not when the browser exits). */
export function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      detached: true
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Platform fallback when Electron's openExternal rejects (Windows .cmd browser handler → EINVAL). */
export async function openHttpsViaOs(url: string): Promise<void> {
  if (process.platform === 'win32') {
    // Empty title arg is required so `start` treats the next token as the URL, not a window title.
    await spawnDetached(comSpecExe(), ['/d', '/s', '/c', 'start', '""', url])
    return
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [url])
    return
  }
  await spawnDetached('xdg-open', [url])
}

/**
 * Best-effort browser open for a verified https URL. Never throws: a failure to open the browser
 * must not abort an OAuth device-code flow that already succeeded at the IdP.
 *
 * Returns whether something appeared to accept the open request (Electron or OS fallback). Callers
 * that show a "Browser didn't open? Click here" link should still always show it.
 */
export async function openHttpsExternal(url: string): Promise<boolean> {
  if (!isHttpsUrl(url)) {
    mainLog.warn('[open-https] refused non-https URL')
    return false
  }
  try {
    await shell.openExternal(url)
    return true
  } catch (e) {
    mainLog.warn(
      `[open-https] shell.openExternal failed (${e instanceof Error ? e.message : String(e)}); trying OS opener`
    )
  }
  try {
    await openHttpsViaOs(url)
    return true
  } catch (e) {
    mainLog.warn(
      `[open-https] OS opener failed (${e instanceof Error ? e.message : String(e)}); user must open the link manually`
    )
    return false
  }
}
