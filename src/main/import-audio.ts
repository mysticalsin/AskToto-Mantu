/**
 * Import audio file → single-use file picker capability.
 *
 * The renderer only needs a picked source's identity (path/name/size/mtime), never its raw bytes —
 * decoding (ffmpeg-decoder), transcription, checkpointing, saving, and recap generation are all owned
 * by the main-process import job queue (see ./import-jobs.ts) once consumePickedAudio hands it a
 * verified ImportJobSource. This module's only remaining job is the native file picker and the
 * single-use capability token that bridges pickAudioFile → import-jobs, plus the pure filename
 * humanizer import-jobs' own title derivation is based on.
 */
import { dialog, type BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ImportAudioPickResult } from '@shared/ipc'
import type { ImportJobSource } from './import-jobs'

// Chromium's AudioContext does the actual capability check. Keep the picker broad enough for common
// interview exports (including AIFF, WebM/Opus, WMA, MP4, and 3GP) instead of silently excluding them.
// mov/m4v/mkv: QuickTime is macOS's built-in recorder and OBS defaults to mkv — both were invisible in
// the picker (ffmpeg decodes all three fine; the "All files" escape hatch proved it, but nobody finds
// that). Reported while importing real Downloads recordings, 2026-08-04.
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'aiff', 'aif', 'webm', 'opus', 'wma', 'amr', '3gp', 'mp4', 'mov', 'm4v', 'mkv']
const MAX_SOURCE_BYTES = 500 * 1024 * 1024 // spec: cap source files at 500 MB, with a clear error

// ── File picker ───────────────────────────────────────────────────────────────

const pendingPicks = new Map<string, ImportJobSource & { pickedAt: number }>()
const PICK_TOKEN_TTL_MS = 5 * 60_000

function clearExpiredPicks(now = Date.now()): void {
  for (const [token, pick] of pendingPicks) {
    if (now - pick.pickedAt > PICK_TOKEN_TTL_MS) pendingPicks.delete(token)
  }
}

/** Open a native file picker filtered to audio extensions. Stats the result so the 500 MB source cap
 *  and the mtime the saved meeting will use as startedAt are both known before any bytes are read. */
export async function pickAudioFile(win: BrowserWindow | null): Promise<ImportAudioPickResult> {
  const opts: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [
      { name: 'Common audio recordings', extensions: AUDIO_EXTENSIONS },
      // FFmpeg performs the authoritative format check. Keep an all-files path for recorder exports
      // with uncommon extensions rather than forcing the user to rename a valid interview recording.
      { name: 'All files', extensions: ['*'] }
    ],
    message: 'Choose an audio or video recording to import'
  }
  // Anchor to `win` when it exists (same LSUIElement-accessory-app reasoning as pickFolder/recapPdf in
  // index.ts) so the dialog actually surfaces instead of silently hanging with nothing to attach to.
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths[0]) return { cancelled: true }
  const path = r.filePaths[0]
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch {
    return { error: 'Could not read the selected file.' }
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    return { error: 'That file is larger than 500 MB. Choose a smaller recording.' }
  }
  // The interactive renderer receives an opaque, single-use capability instead of a filesystem path.
  // This lets the main-owned job queue accept several pending imports safely without exposing arbitrary
  // file reads to the renderer.
  clearExpiredPicks()
  const token = randomBytes(24).toString('base64url')
  const source = { path, name: basename(path), sizeBytes: stat.size, mtimeMs: stat.mtimeMs, pickedAt: Date.now() }
  pendingPicks.set(token, source)
  return { token, name: source.name, sizeBytes: source.sizeBytes, mtimeMs: source.mtimeMs }
}

/** Consume a single-use pick capability and verify the source did not change after selection. */
export function consumePickedAudio(token: string): ImportJobSource {
  clearExpiredPicks()
  const pick = pendingPicks.get(token)
  pendingPicks.delete(token)
  if (!pick) throw new Error('That audio selection expired. Choose the recording again.')
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(pick.path)
  } catch {
    throw new Error('The selected recording is no longer available.')
  }
  if (stat.size !== pick.sizeBytes || stat.mtimeMs !== pick.mtimeMs) {
    throw new Error('The selected recording changed after it was chosen. Choose it again.')
  }
  return { path: pick.path, name: pick.name, sizeBytes: pick.sizeBytes, mtimeMs: pick.mtimeMs }
}

// ── Pure helpers (testable without Electron) ─────────────────────────────────

/** "q3-budget_review.wav" → "Q3 Budget Review". Strips the extension, turns dash/underscore word
 *  separators into spaces, and capitalizes each word's first letter — existing capitalization further
 *  into a word (an acronym like "NASA") is left alone. Falls back to a generic title when the name is
 *  empty or made up entirely of separators. */
export function humanizeFilename(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, '')
  const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return 'Imported audio'
  return words
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}
