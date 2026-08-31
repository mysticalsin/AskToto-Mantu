/**
 * Import audio file → single-use file picker / drop capability.
 *
 * The renderer only needs a picked source's identity (name/size/mtime) plus an opaque token —
 * decoding (ffmpeg-decoder), transcription, checkpointing, saving, and recap generation are all owned
 * by the main-process import job queue (see ./import-jobs.ts) once consumePickedAudio hands it a
 * verified ImportJobSource. This module's only remaining job is the native file picker, dropped-path
 * offer, and the single-use capability tokens that bridge those → import-jobs, plus the pure filename
 * humanizer import-jobs' own title derivation is based on.
 */
import { dialog, type BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ImportAudioPickResult, ImportAudioPickedFile, ImportAudioSkippedFile } from '@shared/ipc'
import type { ImportJobSource } from './import-jobs'
import { IMPORT_NOT_MEDIA, sniffMediaFile } from './import-magic'

// Chromium's AudioContext does the actual capability check. Keep the picker broad enough for common
// interview exports (including AIFF, WebM/Opus, WMA, MP4, and 3GP) instead of silently excluding them.
// mov/m4v/mkv: QuickTime is macOS's built-in recorder and OBS defaults to mkv — both were invisible in
// the picker (ffmpeg decodes all three fine; the "All files" escape hatch proved it, but nobody finds
// that). Reported while importing real Downloads recordings, 2026-08-04.
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'aiff', 'aif', 'webm', 'opus', 'wma', 'amr', '3gp', 'mp4', 'mov', 'm4v', 'mkv']
export const MAX_SOURCE_BYTES = 500 * 1024 * 1024 // spec: cap source files at 500 MB, with a clear error
export const MAX_IMPORT_SELECTION = 50

// ── File picker ───────────────────────────────────────────────────────────────

const pendingPicks = new Map<string, ImportJobSource & { pickedAt: number }>()
const PICK_TOKEN_TTL_MS = 5 * 60_000

function clearExpiredPicks(now = Date.now()): void {
  for (const [token, pick] of pendingPicks) {
    if (now - pick.pickedAt > PICK_TOKEN_TTL_MS) pendingPicks.delete(token)
  }
}

export function audioPickerDialogOptions(): Electron.OpenDialogOptions {
  return {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Common audio recordings', extensions: AUDIO_EXTENSIONS },
      // FFmpeg performs the authoritative format check. Keep an all-files path for recorder exports
      // with uncommon extensions rather than forcing the user to rename a valid interview recording.
      { name: 'All files', extensions: ['*'] }
    ],
    message: 'Choose audio or video recordings to import'
  }
}

function stagePath(path: string): { file?: ImportAudioPickedFile; skipped?: ImportAudioSkippedFile } {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch {
    return { skipped: { name: basename(path), error: 'Could not read the selected file.' } }
  }
  if (!stat.isFile()) {
    return { skipped: { name: basename(path), error: 'Choose a recording file, not a folder.' } }
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    return { skipped: { name: basename(path), error: 'That file is larger than 500 MB. Choose a smaller recording.' } }
  }
  const token = randomBytes(24).toString('base64url')
  const source = { path, name: basename(path), sizeBytes: stat.size, mtimeMs: stat.mtimeMs, pickedAt: Date.now() }
  pendingPicks.set(token, source)
  return { file: { token, name: source.name, sizeBytes: source.sizeBytes, mtimeMs: source.mtimeMs } }
}

function assemblePickResult(
  files: ImportAudioPickedFile[],
  skipped: ImportAudioSkippedFile[]
): ImportAudioPickResult {
  if (!files.length) {
    return {
      error: skipped[0]?.error || 'Could not prepare the selected recordings.',
      skipped: skipped.length ? skipped : undefined
    }
  }
  return {
    token: files[0].token,
    name: files[0].name,
    sizeBytes: files[0].sizeBytes,
    mtimeMs: files[0].mtimeMs,
    files,
    skipped: skipped.length ? skipped : undefined
  }
}

/** Stage one or more already-chosen absolute paths (native picker or preload drop). Never returns paths. */
export function offerAudioPaths(paths: string[]): ImportAudioPickResult {
  clearExpiredPicks()
  const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))].slice(
    0,
    MAX_IMPORT_SELECTION
  )
  if (!unique.length) return { cancelled: true }
  const files: ImportAudioPickedFile[] = []
  const skipped: ImportAudioSkippedFile[] = []
  for (const path of unique) {
    const staged = stagePath(path)
    if (staged.file) files.push(staged.file)
    else if (staged.skipped) skipped.push(staged.skipped)
  }
  return assemblePickResult(files, skipped)
}

/** Open a native multi-file picker filtered to audio extensions. Stats each result so the 500 MB source
 *  cap and the mtime the saved meeting will use as startedAt are both known before any bytes are read. */
export async function pickAudioFile(win: BrowserWindow | null): Promise<ImportAudioPickResult> {
  const opts = audioPickerDialogOptions()
  // Anchor to `win` when it exists (same LSUIElement-accessory-app reasoning as pickFolder/recapPdf in
  // index.ts) so the dialog actually surfaces instead of silently hanging with nothing to attach to.
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths.length) return { cancelled: true }
  return offerAudioPaths(r.filePaths)
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
  if (!sniffMediaFile(pick.path)) {
    throw new Error(IMPORT_NOT_MEDIA)
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
