/**
 * Métis desktop adapters (V03): thin OS adapters for the voice action catalog.
 *
 * Rules every branch here keeps:
 * - Every process starts through src/main/infra/process/desktop-exec.ts: `execFile`/`spawn` with an argv array
 *   and `shell: false`. The executable and every URL scheme and host are fixed in this file or built by
 *   safe-targets.ts; spoken text is only ever a single argv element or data written to a file.
 * - AppleScript is a static literal. Spoken text reaches it as argv (`on run argv`), never by interpolation, so
 *   it can never become script. There is no `do shell script` and no `cmd /c`.
 * - Targets are allowlisted: https Google search and the fixed X address in a browser, fixed bundle ids and
 *   executables. A request that fails the catalog's validation never reaches a process.
 * - No silent app substitution: Arc is used only when named, and a missing Arc is a visible failure.
 * - `verified` requires a receipt bound to this dispatch (the envelope main derived) that records an observed
 *   fact: the frontmost app came up, Notes returned the new note's id, a file was written. Handing a URL to the
 *   operating system proves nothing and stays `unknown`. An acknowledgement that may follow an effect (timeout,
 *   odd exit) is `unknown`, never `failed`, and nothing is ever retried.
 * - Photo capture stays local: nothing here sends it anywhere.
 */
import { win32 } from 'node:path'
import {
  WINDOWS_DESKTOP_EQUIVALENTS,
  type DesktopActionRequest,
  type DesktopActionResult,
  type DesktopAdapterId
} from '@shared/desktop-actions'
import { validateDesktopRequest } from '@shared/voice/catalog'
import type { ActionEnvelope } from './action-guard'
import { runDesktopExec, spawnDesktopGui, type DesktopExec, type DesktopSpawnGui } from './infra/process/desktop-exec'
import type { FrontmostVerifier } from './desktop-frontmost-verifier'
import { googleSearchUrl, isAllowedBrowserUrl, noteHtml, noteText, planWindowsNote, X_URL } from './voice/safe-targets'

const WINDOWS_ROOT = process.env.SystemRoot || 'C:\\Windows'
const WINDOWS_EXPLORER = win32.join(WINDOWS_ROOT, 'explorer.exe')
const WINDOWS_NOTEPAD = win32.join(WINDOWS_ROOT, 'notepad.exe')
const WINDOWS_STICKY_NOTES = 'shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App'
const WINDOWS_CAMERA = 'microsoft.windows.camera:'
const MAC_OPEN = '/usr/bin/open'
const MAC_OSASCRIPT = '/usr/bin/osascript'

/** The one list of target apps: the adapters dispatch to them and the pre-dispatch preflight checks the same ones. */
export const DESKTOP_BUNDLE_IDS = {
  notes: 'com.apple.Notes',
  arc: 'company.thebrowser.Browser',
  photoBooth: 'com.apple.PhotoBooth',
  systemEvents: 'com.apple.systemevents'
} as const
const BUNDLE_NOTES = DESKTOP_BUNDLE_IDS.notes
const BUNDLE_ARC = DESKTOP_BUNDLE_IDS.arc
const BUNDLE_PHOTO_BOOTH = DESKTOP_BUNDLE_IDS.photoBooth
const BUNDLE_SYSTEM_EVENTS = DESKTOP_BUNDLE_IDS.systemEvents

/** How long the frontmost stream has to show the app after the launch was acknowledged. */
const FRONTMOST_WINDOW_MS = 3_000
/** A first automation request shows a system prompt the person may still be reading. */
const NOTES_SCRIPT_TIMEOUT_MS = 45_000
/** AppleScript's "not authorized to send Apple events" error: the request was refused, so nothing happened. */
const APPLE_EVENTS_DENIED = '-1743'
const NOTE_ID = /^x-coredata:\/\/\S{1,500}$/
/** The first argv item is a fixed word that never starts with a dash, so osascript cannot read a spoken title as an option. */
const ARGV_MARKER = 'metis-voice-argv'

// A static script. `argv` is [marker, name, html]; the person's text is data and is never part of this source.
const CREATE_NOTE_SCRIPT_LINES = [
  'on run argv',
  'set noteName to item 2 of argv',
  'set noteBody to item 3 of argv',
  'tell application "Notes"',
  'set newNote to make new note with properties {name:noteName, body:noteBody}',
  'activate',
  'return id of newNote',
  'end tell',
  'end run'
] as const
const PHOTO_BOOTH_SHUTTER_SCRIPT_LINES = [
  'tell application "Photo Booth" to activate',
  'delay 0.8',
  'tell application "System Events"',
  '  if exists process "Photo Booth" then',
  '    tell process "Photo Booth" to keystroke return',
  '  end if',
  'end tell'
] as const

export type DesktopAdapterPlatform = 'darwin' | 'win32' | 'linux' | 'other'

export function detectDesktopAdapterPlatform(platform: NodeJS.Platform = process.platform): DesktopAdapterPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'other'
}

export interface NoteFileSystem {
  mkdir(directory: string): Promise<void>
  /** Create the file only if it does not exist (flag `wx`); rejects with `code: 'EEXIST'` otherwise. */
  writeNewFile(file: string, contents: string): Promise<void>
  sizeOf(file: string): Promise<number>
}

/** Everything OS-facing, injected. Absent entries fail closed (no verification, no assumed permission). */
export interface DesktopAdapterDeps {
  exec: DesktopExec
  spawnGui: DesktopSpawnGui
  frontmost?: FrontmostVerifier
  /** Read-only Automation consent for one app (G10). Missing reads as unknown. */
  automationStatus?(bundleId: string): Promise<'granted' | 'denied' | 'unknown'>
  /** In-process Accessibility trust, read without the prompt flag. Missing reads as not trusted. */
  accessibilityTrusted?(): boolean
  /** Whether a Mac app is installed. Missing means "do not claim it is absent". */
  macAppInstalled?(app: 'Arc'): Promise<boolean>
  documentsDir?(): string | null
  notesFs?: NoteFileSystem
}

export interface ExecuteDesktopOptions {
  platform?: DesktopAdapterPlatform
  /** What main derived for this dispatch. Without it nothing can be reported verified. */
  envelope?: ActionEnvelope
  deps?: Partial<DesktopAdapterDeps>
}

interface Context {
  req: DesktopActionRequest
  envelope: ActionEnvelope | undefined
  deps: DesktopAdapterDeps
}

function fail(id: DesktopAdapterId, detail: string, extra?: Partial<DesktopActionResult>): DesktopActionResult {
  return { id, ok: false, outcome: 'failed', detail, ...extra }
}

function okResult(id: DesktopAdapterId, detail?: string): DesktopActionResult {
  return { id, ok: true, outcome: 'unknown', detail }
}

function unknownResult(id: DesktopAdapterId, detail: string): DesktopActionResult {
  return { id, ok: false, outcome: 'unknown', detail }
}

/** Verified only with an envelope to bind the receipt to; otherwise the honest outcome is unknown. */
function verified(ctx: Context, observation: string, detail: string): DesktopActionResult {
  if (!ctx.envelope) return okResult(ctx.req.id, detail)
  return {
    id: ctx.req.id,
    ok: true,
    outcome: 'verified',
    detail,
    receipt: {
      idempotencyKey: ctx.envelope.idempotencyKey,
      argsHash: ctx.envelope.argsHash,
      observation
    }
  }
}

/** Start the frontmost stream, launch, then see whether the app came up. Cancels the stream on every path. */
async function launchAndObserve(
  ctx: Context,
  bundleId: string,
  launch: () => Promise<{ ok: boolean }>
): Promise<{ acknowledged: boolean; frontmost: boolean }> {
  const observation = ctx.deps.frontmost?.observe(bundleId, FRONTMOST_WINDOW_MS)
  try {
    const ready = observation ? await observation.ready() : false
    const launched = await launch()
    if (!launched.ok) return { acknowledged: false, frontmost: false }
    return { acknowledged: true, frontmost: Boolean(observation && ready && (await observation.matched())) }
  } finally {
    observation?.cancel()
  }
}

async function macOpenBundle(ctx: Context, bundleId: string, label: string): Promise<DesktopActionResult> {
  const result = await launchAndObserve(ctx, bundleId, async () => ({
    ok: (await ctx.deps.exec(MAC_OPEN, ['-b', bundleId])).ok
  }))
  const id = ctx.req.id
  if (!result.acknowledged) return unknownResult(id, `${label} launch acknowledgment is uncertain.`)
  if (result.frontmost) return verified(ctx, `${bundleId} became the frontmost app`, `Opened ${label}`)
  return okResult(id, `Opened ${label}`)
}

/** Hand an allowlisted https URL to the default browser, or to Arc when it was named. No readback exists. */
async function macOpenUrl(ctx: Context, url: string, browser: 'arc' | undefined): Promise<DesktopActionResult> {
  const id = ctx.req.id
  if (!isAllowedBrowserUrl(url)) return fail(id, 'url_not_allowed', { outcome: 'unsupported' })
  if (browser === 'arc' && ctx.deps.macAppInstalled && !(await ctx.deps.macAppInstalled('Arc'))) {
    return fail(id, 'preferred_missing', { preferredMissing: true })
  }
  const args = browser === 'arc' ? ['-b', BUNDLE_ARC, url] : [url]
  const acknowledged = (await ctx.deps.exec(MAC_OPEN, args)).ok
  return acknowledged
    ? okResult(id, 'Opened the page')
    : unknownResult(id, 'Browser launch acknowledgment is uncertain.')
}

async function winOpenTarget(ctx: Context, target: string): Promise<DesktopActionResult> {
  // explorer.exe is pinned to SystemRoot. Unlike `cmd /c start`, it does not parse a shell command.
  const id = ctx.req.id
  const acknowledged = (await ctx.deps.exec(WINDOWS_EXPLORER, [target])).ok
  return acknowledged
    ? okResult(id, 'Open request accepted')
    : unknownResult(id, 'Windows app launch acknowledgment is uncertain.')
}

async function winOpenUrl(ctx: Context, url: string): Promise<DesktopActionResult> {
  if (!isAllowedBrowserUrl(url)) return fail(ctx.req.id, 'url_not_allowed', { outcome: 'unsupported' })
  return winOpenTarget(ctx, url)
}

function searchUrl(req: Extract<DesktopActionRequest, { id: 'desktop.google_search' }>): string | null {
  return googleSearchUrl(req.args.q)
}

async function createNoteMac(
  ctx: Context,
  req: Extract<DesktopActionRequest, { id: 'desktop.create_note' }>
): Promise<DesktopActionResult> {
  const id = req.id
  // Read-only consent check. A refusal here means nothing was attempted, so it is a clean failure.
  if ((await ctx.deps.automationStatus?.(BUNDLE_NOTES)) === 'denied') return fail(id, 'automation_denied')
  const args: string[] = []
  for (const line of CREATE_NOTE_SCRIPT_LINES) args.push('-e', line)
  args.push(ARGV_MARKER, req.args.title, noteHtml(req.args.title, req.args.body))
  const run = await ctx.deps.exec(MAC_OSASCRIPT, args, { timeoutMs: NOTES_SCRIPT_TIMEOUT_MS })
  if (!run.ok) {
    // Only the system's explicit "not authorized" error proves the note was not made. A timeout or any other
    // failure may follow an effect, so it is unknown and is never retried.
    if (!run.timedOut && run.stderr.includes(APPLE_EVENTS_DENIED)) return fail(id, 'automation_denied')
    return unknownResult(id, 'AppleScript acknowledgment is uncertain.')
  }
  const noteId = run.stdout.trim()
  if (NOTE_ID.test(noteId)) return verified(ctx, 'Notes returned the id of the new note', 'Created the note')
  return okResult(id, 'Note creation requested')
}

const WINDOWS_NOTE_ATTEMPTS = 20

async function createNoteWindows(
  ctx: Context,
  req: Extract<DesktopActionRequest, { id: 'desktop.create_note' }>
): Promise<DesktopActionResult> {
  const id = req.id
  const documents = ctx.deps.documentsDir?.()
  const fs = ctx.deps.notesFs
  if (!documents || !fs) return fail(id, 'documents_unavailable')
  const plan = planWindowsNote(documents, req.args.title)
  if (!plan) return fail(id, 'documents_unavailable')
  const contents = noteText(req.args.title, req.args.body)
  try {
    await fs.mkdir(plan.directory)
  } catch {
    return fail(id, 'note_folder_unavailable')
  }
  let written: string | null = null
  for (let attempt = 1; attempt <= WINDOWS_NOTE_ATTEMPTS && written === null; attempt++) {
    const file = plan.pathFor(attempt)
    try {
      await fs.writeNewFile(file, contents)
      written = file
    } catch (error) {
      const code = ((): unknown => {
        try {
          return (error as { code?: unknown }).code
        } catch {
          return undefined
        }
      })()
      // The name is taken: the next attempt picks the next free name. Anything else may have left a partial file.
      if (code !== 'EEXIST') return unknownResult(id, 'The note file may not have been written.')
    }
  }
  if (written === null) return fail(id, 'note_name_unavailable')
  let size = -1
  try {
    size = await fs.sizeOf(written)
  } catch {
    size = -1
  }
  if (size !== Buffer.byteLength(contents, 'utf8')) return unknownResult(id, 'The note file could not be read back.')
  // The note exists whether or not Notepad opens it.
  await ctx.deps.spawnGui(WINDOWS_NOTEPAD, [written])
  return verified(ctx, `A ${size} byte note file was written`, 'Saved the note as a text file')
}

async function executeMac(ctx: Context): Promise<DesktopActionResult> {
  const req = ctx.req
  switch (req.id) {
    case 'desktop.open_notes':
      return macOpenBundle(ctx, BUNDLE_NOTES, 'Notes')
    case 'desktop.create_note':
      return createNoteMac(ctx, req)
    case 'desktop.open_arc': {
      if (ctx.deps.macAppInstalled && !(await ctx.deps.macAppInstalled('Arc'))) {
        // No silent browser swap: a missing Arc is a visible failure.
        return fail(req.id, 'preferred_missing', { preferredMissing: true })
      }
      return macOpenBundle(ctx, BUNDLE_ARC, 'Arc')
    }
    case 'desktop.google_search': {
      const url = searchUrl(req)
      return url
        ? macOpenUrl(ctx, url, req.args.browser)
        : fail(req.id, 'invalid_arguments', { outcome: 'unsupported' })
    }
    case 'desktop.open_x':
      return macOpenUrl(ctx, X_URL, req.args.browser)
    case 'desktop.photo_booth_capture': {
      // Permission-gated by the OS, and local only: the photo goes nowhere. Check consent before opening anything.
      if (ctx.deps.accessibilityTrusted?.() !== true) return fail(req.id, 'accessibility_required')
      if ((await ctx.deps.automationStatus?.(BUNDLE_SYSTEM_EVENTS)) === 'denied')
        return fail(req.id, 'automation_denied')
      const open = await macOpenBundle(ctx, BUNDLE_PHOTO_BOOTH, 'Photo Booth')
      if (!open.ok) return open
      const args: string[] = []
      for (const line of PHOTO_BOOTH_SHUTTER_SCRIPT_LINES) args.push('-e', line)
      const shutter = await ctx.deps.exec(MAC_OSASCRIPT, args)
      // The shutter has no readback, so the honest outcome is unknown.
      return shutter.ok
        ? okResult(req.id, 'Photo Booth capture attempted (local only)')
        : unknownResult(req.id, 'AppleScript acknowledgment is uncertain.')
    }
  }
}

async function executeWin(ctx: Context): Promise<DesktopActionResult> {
  const req = ctx.req
  const disc = WINDOWS_DESKTOP_EQUIVALENTS[req.id]
  switch (req.id) {
    case 'desktop.open_notes':
      // A failed launch acknowledgment may follow an actual effect; never dispatch Notepad blindly.
      return winOpenTarget(ctx, WINDOWS_STICKY_NOTES)
    case 'desktop.create_note':
      return createNoteWindows(ctx, req)
    case 'desktop.open_arc':
      return fail(
        req.id,
        'Arc launch is unavailable without a trusted installed-app path. No silent Edge/Chrome swap.',
        {
          outcome: 'unsupported',
          preferredMissing: true
        }
      )
    case 'desktop.google_search': {
      if (req.args.browser === 'arc')
        return fail(req.id, 'preferred_missing', { outcome: 'unsupported', preferredMissing: true })
      const url = searchUrl(req)
      return url ? winOpenUrl(ctx, url) : fail(req.id, 'invalid_arguments', { outcome: 'unsupported' })
    }
    case 'desktop.open_x':
      if (req.args.browser === 'arc')
        return fail(req.id, 'preferred_missing', { outcome: 'unsupported', preferredMissing: true })
      return winOpenUrl(ctx, X_URL)
    case 'desktop.photo_booth_capture': {
      const r = await winOpenTarget(ctx, WINDOWS_CAMERA)
      return r.ok ? okResult(req.id, `Camera opened (${disc.note})`) : r
    }
  }
}

export async function executeDesktopAction(
  request: DesktopActionRequest,
  options: ExecuteDesktopOptions = {}
): Promise<DesktopActionResult> {
  // The catalog's validation is the argument boundary. Nothing unvalidated reaches a process.
  const req = validateDesktopRequest(request)
  if (!req) return fail((request as { id: DesktopAdapterId }).id, 'invalid_arguments', { outcome: 'unsupported' })
  const platform = options.platform ?? detectDesktopAdapterPlatform()
  if (platform !== 'darwin' && platform !== 'win32') {
    return fail(req.id, `Desktop adapters unsupported on ${platform}`, { outcome: 'unsupported' })
  }
  const ctx: Context = {
    req,
    envelope: options.envelope,
    deps: { exec: runDesktopExec, spawnGui: spawnDesktopGui, ...options.deps }
  }
  return platform === 'darwin' ? executeMac(ctx) : executeWin(ctx)
}
