/**
 * Import audio file → full on-device transcription → saved meeting.
 *
 * The renderer does the work main can't: Chromium's AudioContext decodes every target format
 * (wav/mp3/m4a/aac/ogg/flac) and resamples/mixes down to 16kHz mono — main has no ffmpeg and never
 * will (see src/renderer/src/lib/import-audio.ts). Main's job is narrow: hand back the picked file's
 * bytes exactly once (guarded so only the renderer's own just-picked path can be read back — see
 * pickAudioFile/readPickedAudioFile), then accumulate + transcribe the renderer's ~30s Float32 windows
 * as they arrive and save the result through the same path a live meeting uses.
 *
 * Only the recognized TEXT is retained between chunks (see ImportSession) — the raw PCM for a chunk is
 * used once inside parakeetTranscribe and is then eligible for GC — so a multi-hour import never holds
 * more than one ~30s window of audio in memory at a time, however long the source recording is.
 */
import { dialog, app, type BrowserWindow } from 'electron'
import { statSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  Settings,
  SaveMeeting,
  TranscriptLine,
  ImportAudioChunk,
  ImportAudioPickResult,
  ImportAudioChunkResult
} from '@shared/ipc'
import { transcriptLinesToText } from '@shared/ipc'
import { ensureParakeetModel, parakeetTranscribe } from './parakeet'
import { saveMeeting } from './transcripts'
import { updateMeetingRecap } from './recall'
import { enqueueIngest } from './brain/ingest'
import { auditLog } from './logger'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac']
const MAX_SOURCE_BYTES = 500 * 1024 * 1024 // spec: cap source files at 500 MB, with a clear error
const CHUNK_SEC = 30 // must match the renderer's own chunk duration (src/renderer/src/lib/import-audio.ts)

// ── File picker (renderer steps 1-2) ─────────────────────────────────────────

// Security guard: importAudioRead may only ever read back the EXACT path this module just handed out
// via pickAudioFile — never a renderer-supplied path (path traversal). Cleared the instant it's
// consumed, so replaying the same read call a second time is refused too.
let pendingReadPath: string | null = null

/** Open a native file picker filtered to audio extensions. Stats the result so the 500 MB source cap
 *  and the mtime the saved meeting will use as startedAt are both known before any bytes are read. */
export async function pickAudioFile(win: BrowserWindow | null): Promise<ImportAudioPickResult> {
  const opts: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    message: 'Choose an audio recording to import'
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
  pendingReadPath = path
  return { path, name: basename(path), sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
}

/** Read back the exact file pickAudioFile just picked. Throws on any other path (defense against a
 *  compromised or buggy renderer supplying its own path). One-time: the guard clears on use. */
export function readPickedAudioFile(path: string): ArrayBuffer {
  if (!path || path !== pendingReadPath) {
    throw new Error('That file was not the one just picked. Choose it again.')
  }
  pendingReadPath = null
  const buf = readFileSync(path)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
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

/** One transcribed chunk's text → a TranscriptLine, timestamped by its OFFSET within the audio (chunk
 *  index * chunk duration), not wall-clock time — an imported file has no live clock to anchor to. */
export function chunkToLine(text: string, seq: number, startedAt: number): TranscriptLine {
  return { speaker: 'you', text, t: startedAt + seq * CHUNK_SEC * 1000 }
}

/** 0-100 progress from "chunk N of M just started". Clamped defensively even though seq/totalChunks
 *  are already bounded by ImportAudioChunkSchema by the time this runs. */
export function chunkProgressPct(seq: number, totalChunks: number): number {
  if (totalChunks <= 0) return 0
  return Math.min(100, Math.max(0, Math.round(((seq + 1) / totalChunks) * 100)))
}

// ── Session accumulation + save (renderer steps 3-4) ─────────────────────────

interface ImportSession {
  sessionId: string
  startedAt: number
  title: string
  lines: TranscriptLine[]
}

// Cap: exactly one import runs at a time. A chunk for a sessionId other than the one currently
// accumulating REPLACES it outright, discarding whatever the old one had transcribed so far — this is
// what "abandoning a session frees its buffers" means in practice (see abandonImportSession below).
let activeSession: ImportSession | null = null

/** Free whatever is accumulating — a new session starting, an unrecoverable error, or the app quitting.
 *  Safe to call when nothing is active. */
export function abandonImportSession(): void {
  activeSession = null
}

let quitHooked = false
function ensureQuitHook(): void {
  if (quitHooked) return
  quitHooked = true
  app.on('will-quit', abandonImportSession)
}

// Injected once by main/index.ts at startup (mirrors logger.ts's setAuditActor/actorResolver pattern) —
// avoids a circular import: index.ts already imports handleImportChunk etc. from this module, so this
// module reaching back into index.ts for the recap generator would create a cycle. Stays null until
// index.ts wires it, so this module's own tests (which never call the setter) exercise the exact
// pre-recap behavior unchanged.
type RecapGenerator = (
  settings: Settings,
  transcript: string
) => Promise<{ ok: true; recap: string } | { ok: false; reason: string; message?: string }>
let recapGenerator: RecapGenerator | null = null

/** Register the one-shot recap generator (main/index.ts's generateRecapForTranscript). Call once at startup. */
export function setRecapGenerator(fn: RecapGenerator): void {
  recapGenerator = fn
}

/** Persist the session's accumulated lines as a normal meeting — shared by the done-chunk save below and
 *  by a mid-import failure that still has some transcribed lines worth keeping (see handleImportChunk's
 *  catch block). Chunks normally arrive (and transcribe) strictly in order, but sorts defensively so a
 *  saved transcript is always chronological even if that ever stops being true. */
async function saveImportSession(
  settings: Settings,
  session: ImportSession,
  partial: boolean,
  onProgress: (pct: number, stage: 'transcribing' | 'saving' | 'downloading' | 'recap') => void
): Promise<{ file: string; lines: TranscriptLine[] }> {
  const sortedLines = [...session.lines].sort((a, b) => a.t - b.t)
  const meeting: SaveMeeting = {
    title: session.title,
    mode: 'meeting',
    startedAt: session.startedAt,
    lines: sortedLines,
    recap: ''
  }
  const file = await saveMeeting(settings, meeting)
  auditLog('transcript.imported', { lines: sortedLines.length, encrypted: !!settings.encryptTranscripts, partial })
  enqueueIngest(file) // Mantu Intelligence brain — background extraction; never blocks the save

  // Best-effort AI recap — a live meeting gets one via App.tsx's endReview() → ask.run({mode:'recap'});
  // import had none until now (recap always saved empty). Never blocks or fails the import: the transcript
  // save above already landed, so no configured provider, a stuck stream, or any thrown error here just
  // leaves recap empty (today's behavior) — RecallView's "Generate recap" action can retry later.
  if (sortedLines.length > 0 && recapGenerator) {
    onProgress(100, 'recap')
    try {
      const recap = await recapGenerator(settings, transcriptLinesToText(sortedLines))
      if (recap.ok) {
        await updateMeetingRecap(settings, file, recap.recap)
        auditLog('transcript.recap_edited', { file: basename(file), generated: true })
      }
    } catch {
      // best-effort — the saved transcript above is the guarantee, not the recap
    }
  }
  return { file, lines: sortedLines }
}

/** Accumulate + transcribe one chunk; on the final (done) chunk, save the whole thing as a normal
 *  meeting and queue it for brain ingest. `onProgress` is called synchronously before the (possibly
 *  slow) transcription starts, and again just before the save, so the caller can push live progress.
 *
 *  Always transcribes with Parakeet — the renderer's Whisper worker lives in the live-Listen path and
 *  isn't reachable from this main-process session, so import can't route through it. Parakeet is
 *  optimized for major European languages; RecallView's Import button copy carries that caveat rather
 *  than this module silently mistranscribing a non-European recording with no explanation.
 *
 *  A chunk transcription failure no longer discards everything gathered so far via abandonImportSession()
 *  — whatever transcribed before the failure is saved as a partial meeting first, so a long import never
 *  loses all its work over one bad ~30s window. */
export async function handleImportChunk(
  settings: Settings,
  chunk: ImportAudioChunk,
  onProgress: (pct: number, stage: 'transcribing' | 'saving' | 'downloading' | 'recap') => void
): Promise<ImportAudioChunkResult> {
  ensureQuitHook()

  if (!activeSession || activeSession.sessionId !== chunk.sessionId) {
    activeSession = {
      sessionId: chunk.sessionId,
      startedAt: Number.isFinite(chunk.mtimeMs) ? chunk.mtimeMs : Date.now(),
      title: humanizeFilename(chunk.name || 'Imported audio'),
      lines: []
    }
  }
  const session = activeSession

  onProgress(chunkProgressPct(chunk.seq, chunk.totalChunks), 'transcribing')

  try {
    if (chunk.samples.length > 0) {
      // First-time model download (~487 MB) can take minutes; without forwarding progress here, a
      // first-run import looked frozen at whatever pct the last 'transcribing' onProgress call reported.
      // Mirrors the live-Listen path's ensureParakeetModel(progress) wiring (index.ts). A no-op (never
      // invokes onProgress) once the model is already on disk, so every later import is unaffected.
      await ensureParakeetModel((pct) => onProgress(pct, 'downloading'))
      const text = await parakeetTranscribe(chunk.samples)
      if (text.trim()) session.lines.push(chunkToLine(text, chunk.seq, session.startedAt))
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    if (session.lines.length > 0) {
      try {
        const { file, lines } = await saveImportSession(settings, session, true, onProgress)
        abandonImportSession()
        return {
          ok: false,
          error: `Import stopped partway (${errMsg}). Saved the ${lines.length} line(s) transcribed so far to your meetings folder.`,
          file,
          title: session.title,
          lines
        }
      } catch {
        // Partial save also failed — nothing recoverable to point to; fall through to the plain failure
        // below and surface the ORIGINAL transcription error, not the save error.
      }
    }
    abandonImportSession()
    return { ok: false, error: errMsg }
  }

  if (!chunk.done) return { ok: true }

  onProgress(100, 'saving')
  try {
    const { file, lines } = await saveImportSession(settings, session, false, onProgress)
    return { ok: true, file, title: session.title, lines }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    abandonImportSession()
  }
}
