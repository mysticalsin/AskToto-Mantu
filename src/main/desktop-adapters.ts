/**
 * Métis 2.0 Cap 2 — thin OS adapters for the video allowlist.
 * No new mic/ASR. No silent app substitution. Photo never uploaded to Jev.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  WINDOWS_DESKTOP_EQUIVALENTS,
  type DesktopActionRequest,
  type DesktopActionResult,
  type DesktopAdapterId
} from '@shared/desktop-actions'

const execFileAsync = promisify(execFile)

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

async function macOpenApp(name: string): Promise<{ ok: boolean; detail: string }> {
  const r = await run('/usr/bin/open', ['-a', name])
  if (!r.ok) {
    return {
      ok: false,
      detail: `Could not open ${name}. ${r.stderr || 'missing app?'}`.trim()
    }
  }
  return { ok: true, detail: `Opened ${name}` }
}

async function macOpenUrl(url: string, app?: string): Promise<{ ok: boolean; detail: string }> {
  const args = app ? ['-a', app, url] : [url]
  const r = await run('/usr/bin/open', args)
  if (!r.ok) return { ok: false, detail: r.stderr || `open failed for ${url}` }
  return { ok: true, detail: `Opened ${url}` }
}

async function macOsascript(source: string): Promise<{ ok: boolean; detail: string }> {
  const r = await run('/usr/bin/osascript', ['-e', source])
  if (!r.ok) return { ok: false, detail: r.stderr || 'osascript failed' }
  return { ok: true, detail: r.stdout.trim() || 'ok' }
}

async function winStart(target: string): Promise<{ ok: boolean; detail: string }> {
  // cmd /c start "" <target> — target must not be free-form shell.
  const r = await run('cmd.exe', ['/d', '/s', '/c', 'start', '', target])
  if (!r.ok) return { ok: false, detail: r.stderr || `start failed for ${target}` }
  return { ok: true, detail: `Started ${target}` }
}

export async function executeDesktopAction(
  req: DesktopActionRequest,
  platform: DesktopAdapterPlatform = detectDesktopAdapterPlatform()
): Promise<DesktopActionResult> {
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
      const title = req.args.title
      // Title exactly as requested (Cap1: hello).
      const safe = title.replace(/["\\]/g, '')
      const script =
        'tell application "Notes"\n' +
        'activate\n' +
        `make new note with properties {name:"${safe}", body:"${safe}"}\n` +
        'end tell'
      const open = await macOpenApp('Notes')
      if (!open.ok) return fail(req.id, open.detail, { preferredMissing: true })
      const r = await macOsascript(script)
      return r.ok ? okResult(req.id, 'unknown', `note title=${title}`) : fail(req.id, r.detail)
    }
    case 'desktop.open_arc': {
      const r = await macOpenApp('Arc')
      return r.ok
        ? okResult(req.id, 'unknown', r.detail)
        : fail(req.id, 'Arc is not available. No silent browser swap.', { preferredMissing: true })
    }
    case 'desktop.google_search': {
      const q = encodeURIComponent(req.args.q)
      const url = `https://www.google.com/search?q=${q}`
      // Prefer Arc when present; if Arc missing, open via default handler but surface note.
      const viaArc = await macOpenUrl(url, 'Arc')
      if (viaArc.ok) return okResult(req.id, 'unknown', viaArc.detail)
      const viaDefault = await macOpenUrl(url)
      return viaDefault.ok
        ? okResult(req.id, 'unknown', `${viaDefault.detail} (Arc missing; used default handler)`)
        : fail(req.id, viaDefault.detail)
    }
    case 'desktop.open_x': {
      const url = 'https://x.com'
      const viaArc = await macOpenUrl(url, 'Arc')
      if (viaArc.ok) return okResult(req.id, 'unknown', viaArc.detail)
      const viaDefault = await macOpenUrl(url)
      return viaDefault.ok
        ? okResult(req.id, 'unknown', viaDefault.detail)
        : fail(req.id, viaDefault.detail)
    }
    case 'desktop.photo_booth_capture': {
      // Permission-gated by OS. Capture stays local — never sent to /v1/decide.
      const open = await macOpenApp('Photo Booth')
      if (!open.ok) return fail(req.id, open.detail, { preferredMissing: true })
      // Best-effort shutter via UI scripting; outcome unknown without AX verify.
      const shutter =
        'tell application "Photo Booth" to activate\n' +
        'delay 0.8\n' +
        'tell application "System Events"\n' +
        '  if exists process "Photo Booth" then\n' +
        '    tell process "Photo Booth" to keystroke return\n' +
        '  end if\n' +
        'end tell'
      const r = await macOsascript(shutter)
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
      const sticky = await winStart('shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App')
      if (sticky.ok) return okResult(req.id, 'unknown', sticky.detail)
      const notepad = await winStart('notepad.exe')
      return notepad.ok
        ? okResult(req.id, 'unknown', `${notepad.detail} (Sticky Notes missing; Notepad disclosed)`)
        : fail(req.id, `${disc.note} ${notepad.detail}`, { preferredMissing: true })
    }
    case 'desktop.create_note': {
      // Disclosed analogue: open Notepad; title file not auto-named without user path — unknown.
      const r = await winStart('notepad.exe')
      return r.ok
        ? okResult(req.id, 'unknown', `Notepad opened for title=${req.args.title} (${disc.note})`)
        : fail(req.id, r.detail, { preferredMissing: true })
    }
    case 'desktop.open_arc': {
      const r = await winStart('arc.exe')
      return r.ok
        ? okResult(req.id, 'unknown', r.detail)
        : fail(req.id, 'Arc is not available on this PC. No silent Edge/Chrome swap.', {
            preferredMissing: true
          })
    }
    case 'desktop.google_search': {
      const q = encodeURIComponent(req.args.q)
      const url = `https://www.google.com/search?q=${q}`
      const r = await winStart(url)
      return r.ok ? okResult(req.id, 'unknown', r.detail) : fail(req.id, r.detail)
    }
    case 'desktop.open_x': {
      const r = await winStart('https://x.com')
      return r.ok ? okResult(req.id, 'unknown', r.detail) : fail(req.id, r.detail)
    }
    case 'desktop.photo_booth_capture': {
      const r = await winStart('microsoft.windows.camera:')
      return r.ok
        ? okResult(req.id, 'unknown', `Camera opened (${disc.note})`)
        : fail(req.id, r.detail, { preferredMissing: true })
    }
  }
}
