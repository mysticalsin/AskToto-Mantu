/**
 * Métis 2.0 Cap 2 — thin OS adapters for the video allowlist.
 * No new mic/ASR. No silent app substitution. Photo never uploaded to Jev.
 */

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import {
  WINDOWS_DESKTOP_EQUIVALENTS,
  type DesktopActionRequest,
  type DesktopActionResult,
  type DesktopAdapterId
} from '@shared/desktop-actions'

const execFileAsync = promisify(execFile)

// This inherited layer deliberately remains a fixed demo allowlist. Keep every executable,
// URL, and AppleScript literal in source: future command ingress must not be able to turn text
// into an OS command or script.
const FIXED_DEMO_NOTE_TITLE = 'hello'
const FIXED_DEMO_SEARCH_QUERY = 'Norbert Wiener'
const GOOGLE_NORBERT_WIENER_URL = 'https://www.google.com/search?q=Norbert%20Wiener'
const X_URL = 'https://x.com'
const WINDOWS_ROOT = process.env.SystemRoot || 'C:\\Windows'
const WINDOWS_EXPLORER = win32.join(WINDOWS_ROOT, 'explorer.exe')
const WINDOWS_NOTEPAD = win32.join(WINDOWS_ROOT, 'notepad.exe')
const WINDOWS_STICKY_NOTES = 'shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App'
const WINDOWS_CAMERA = 'microsoft.windows.camera:'
const CREATE_HELLO_NOTE_SCRIPT =
  'tell application "Notes"\n' +
  'activate\n' +
  'make new note with properties {name:"hello", body:"hello"}\n' +
  'end tell'
const PHOTO_BOOTH_SHUTTER_SCRIPT =
  'tell application "Photo Booth" to activate\n' +
  'delay 0.8\n' +
  'tell application "System Events"\n' +
  '  if exists process "Photo Booth" then\n' +
  '    tell process "Photo Booth" to keystroke return\n' +
  '  end if\n' +
  'end tell'

type MacAppName = 'Notes' | 'Arc' | 'Photo Booth'
type MacUrl = typeof GOOGLE_NORBERT_WIENER_URL | typeof X_URL
type WindowsShellTarget = typeof WINDOWS_STICKY_NOTES | typeof GOOGLE_NORBERT_WIENER_URL | typeof X_URL | typeof WINDOWS_CAMERA
type MacAppleScript = typeof CREATE_HELLO_NOTE_SCRIPT | typeof PHOTO_BOOTH_SHUTTER_SCRIPT

export type DesktopAdapterPlatform = 'darwin' | 'win32' | 'linux' | 'other'

export function detectDesktopAdapterPlatform(
  platform: NodeJS.Platform = process.platform
): DesktopAdapterPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'other'
}

async function run(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: opts?.timeoutMs ?? 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || 'exec failed')
    }
  }
}

function fail(
  id: DesktopAdapterId,
  detail: string,
  extra?: Partial<DesktopActionResult>
): DesktopActionResult {
  return { id, ok: false, outcome: 'failed', detail, ...extra }
}

function okResult(
  id: DesktopAdapterId,
  outcome: DesktopActionResult['outcome'] = 'unknown',
  detail?: string
): DesktopActionResult {
  return { id, ok: true, outcome, detail }
}

async function macOpenApp(name: MacAppName): Promise<{ ok: boolean; detail: string }> {
  const r = await run('/usr/bin/open', ['-a', name])
  if (!r.ok) {
    return {
      ok: false,
      detail: `Could not open ${name}. ${r.stderr || 'missing app?'}`.trim()
    }
  }
  return { ok: true, detail: `Opened ${name}` }
}

async function macOpenUrl(url: MacUrl, app?: 'Arc'): Promise<{ ok: boolean; detail: string }> {
  const args = app ? ['-a', app, url] : [url]
  const r = await run('/usr/bin/open', args)
  if (!r.ok) return { ok: false, detail: r.stderr || `open failed for ${url}` }
  return { ok: true, detail: `Opened ${url}` }
}

async function macOsascript(source: MacAppleScript): Promise<{ ok: boolean; detail: string }> {
  const r = await run('/usr/bin/osascript', ['-e', source])
  if (!r.ok) return { ok: false, detail: r.stderr || 'osascript failed' }
  return { ok: true, detail: r.stdout.trim() || 'ok' }
}

async function winOpenTarget(target: WindowsShellTarget): Promise<{ ok: boolean; detail: string }> {
  // explorer.exe is pinned to SystemRoot. Unlike `cmd /c start`, it does not parse a shell command.
  const r = await run(WINDOWS_EXPLORER, [target])
  if (!r.ok) return { ok: false, detail: r.stderr || `open failed for ${target}` }
  return { ok: true, detail: `Open request accepted for ${target}` }
}

async function winOpenNotepad(): Promise<{ ok: boolean; detail: string }> {
  const r = await run(WINDOWS_NOTEPAD, [])
  if (!r.ok) return { ok: false, detail: r.stderr || 'Notepad launch failed' }
  return { ok: true, detail: 'Notepad launch request accepted' }
}

function fixedDemoRequestError(req: DesktopActionRequest): string | null {
  if (req.id === 'desktop.create_note' && req.args.title !== FIXED_DEMO_NOTE_TITLE) {
    return 'Unsupported fixed-demo note title'
  }
  if (req.id === 'desktop.google_search' && req.args.q !== FIXED_DEMO_SEARCH_QUERY) {
    return 'Unsupported fixed-demo search query'
  }
  return null
}

export async function executeDesktopAction(
  req: DesktopActionRequest,
  platform: DesktopAdapterPlatform = detectDesktopAdapterPlatform()
): Promise<DesktopActionResult> {
  const requestError = fixedDemoRequestError(req)
  if (requestError) return fail(req.id, requestError, { outcome: 'unsupported' })
  if (platform === 'darwin') return executeMac(req)
  if (platform === 'win32') return executeWin(req)
  return fail(req.id, `Desktop adapters unsupported on ${platform}`, { outcome: 'unsupported' })
}

async function executeMac(req: DesktopActionRequest): Promise<DesktopActionResult> {
  switch (req.id) {
    case 'desktop.open_notes': {
      const r = await macOpenApp('Notes')
      return r.ok ? okResult(req.id, 'unknown', r.detail) : fail(req.id, r.detail, { preferredMissing: true })
    }
    case 'desktop.create_note': {
      const open = await macOpenApp('Notes')
      if (!open.ok) return fail(req.id, open.detail, { preferredMissing: true })
      const r = await macOsascript(CREATE_HELLO_NOTE_SCRIPT)
      return r.ok
        ? okResult(req.id, 'unknown', `Note creation requested for ${FIXED_DEMO_NOTE_TITLE}`)
        : fail(req.id, r.detail)
    }
    case 'desktop.open_arc': {
      const r = await macOpenApp('Arc')
      return r.ok
        ? okResult(req.id, 'unknown', r.detail)
        : fail(req.id, 'Arc is not available. No silent browser swap.', { preferredMissing: true })
    }
    case 'desktop.google_search': {
      // Prefer Arc when present; if Arc missing, open via default handler but surface note.
      const viaArc = await macOpenUrl(GOOGLE_NORBERT_WIENER_URL, 'Arc')
      if (viaArc.ok) return okResult(req.id, 'unknown', viaArc.detail)
      const viaDefault = await macOpenUrl(GOOGLE_NORBERT_WIENER_URL)
      return viaDefault.ok
        ? okResult(req.id, 'unknown', `${viaDefault.detail} (Arc missing; used default handler)`)
        : fail(req.id, viaDefault.detail)
    }
    case 'desktop.open_x': {
      const viaArc = await macOpenUrl(X_URL, 'Arc')
      if (viaArc.ok) return okResult(req.id, 'unknown', viaArc.detail)
      const viaDefault = await macOpenUrl(X_URL)
      return viaDefault.ok
        ? okResult(req.id, 'unknown', viaDefault.detail)
        : fail(req.id, viaDefault.detail)
    }
    case 'desktop.photo_booth_capture': {
      // Permission-gated by OS. Capture stays local — never sent to /v1/decide.
      const open = await macOpenApp('Photo Booth')
      if (!open.ok) return fail(req.id, open.detail, { preferredMissing: true })
      // Best-effort shutter via UI scripting; outcome unknown without AX verify.
      const r = await macOsascript(PHOTO_BOOTH_SHUTTER_SCRIPT)
      return r.ok
        ? okResult(req.id, 'unknown', 'Photo Booth capture attempted (local only)')
        : fail(req.id, r.detail)
    }
  }
}

async function executeWin(req: DesktopActionRequest): Promise<DesktopActionResult> {
  const disc = WINDOWS_DESKTOP_EQUIVALENTS[req.id]
  switch (req.id) {
    case 'desktop.open_notes': {
      // Prefer Sticky Notes AppX; fall back Notepad with disclosure in detail.
      const sticky = await winOpenTarget(WINDOWS_STICKY_NOTES)
      if (sticky.ok) return okResult(req.id, 'unknown', sticky.detail)
      const notepad = await winOpenNotepad()
      return notepad.ok
        ? okResult(req.id, 'unknown', `${notepad.detail} (Sticky Notes missing; Notepad disclosed)`)
        : fail(req.id, `${disc.note} ${notepad.detail}`, { preferredMissing: true })
    }
    case 'desktop.create_note': {
      // Disclosed analogue: open Notepad; title file not auto-named without user path — unknown.
      const r = await winOpenNotepad()
      return r.ok
        ? okResult(req.id, 'unknown', `Notepad opened for ${FIXED_DEMO_NOTE_TITLE} (${disc.note})`)
        : fail(req.id, r.detail, { preferredMissing: true })
    }
    case 'desktop.open_arc': {
      return fail(req.id, 'Arc launch is unavailable without a trusted installed-app path. No silent Edge/Chrome swap.', {
        outcome: 'unsupported',
        preferredMissing: true
      })
    }
    case 'desktop.google_search': {
      const r = await winOpenTarget(GOOGLE_NORBERT_WIENER_URL)
      return r.ok ? okResult(req.id, 'unknown', r.detail) : fail(req.id, r.detail)
    }
    case 'desktop.open_x': {
      const r = await winOpenTarget(X_URL)
      return r.ok ? okResult(req.id, 'unknown', r.detail) : fail(req.id, r.detail)
    }
    case 'desktop.photo_booth_capture': {
      const r = await winOpenTarget(WINDOWS_CAMERA)
      return r.ok
        ? okResult(req.id, 'unknown', `Camera opened (${disc.note})`)
        : fail(req.id, r.detail, { preferredMissing: true })
    }
  }
}
