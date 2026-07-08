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
  AskStart,
  ImportAudioChunk,
  ImportAudioPickResult,
  ImportAudioChunkResult
} from '@shared/ipc'
import { redactSecrets } from '@shared/redact'
import { ensureParakeetModel, parakeetTranscribe } from './parakeet'
import { saveMeeting } from './transcripts'
import { enqueueIngest } from './brain/ingest'
import { buildSystem } from './personas'
import { hasUsableProvider, runCompletion } from './llm/complete'
import { auditLog, mainLog } from './logger'

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

// ── Post-transcription recap ─────────────────────────────────────────────────

/** Generate the AI recap/summary for an imported recording — the same recap the live meeting produces
 *  (mode:'recap' system prompt + the configured provider), run as a background completion in main.
 *  Redacts secrets from the copy sent to the model exactly like the live ask + brain-ingest paths. */
export async function generateImportRecap(settings: Settings, transcriptText: string): Promise<string> {
  const id = `import-recap-${Date.now()}`
  const req = { id, mode: 'recap', prompt: transcriptText, history: [] } as AskStart
  const system = buildSystem(
    req,
    'meeting',
    settings.profile,
    settings.modePrompts,
    undefined,
    settings.outputLanguage,
    settings.summaryLanguage,
    settings.systemPrompt
  )
  const safe = settings.redactSensitive ? redactSecrets(transcriptText) : transcriptText
  return runCompletion(settings, system, safe, id, 'recap')
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

/** Accumulate + transcribe one chunk; on the final (done) chunk, save the whole thing as a normal
 *  meeting and queue it for brain ingest. `onProgress` is called synchronously before the (possibly
 *  slow) transcription starts, and again just before the save, so the caller can push live progress. */
export async function handleImportChunk(
  settings: Settings,
  chunk: ImportAudioChunk,
  onProgress: (pct: number, stage: 'transcribing' | 'saving' | 'summarizing') => void
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
      await ensureParakeetModel()
      const text = await parakeetTranscribe(chunk.samples)
      if (text.trim()) session.lines.push(chunkToLine(text, chunk.seq, session.startedAt))
    }
  } catch (e) {
    abandonImportSession()
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  if (!chunk.done) return { ok: true }

  onProgress(100, 'saving')
  // Chunks normally arrive (and are transcribed) strictly in order, but sort defensively so a saved
  // transcript is always chronological even if that ever stops being true.
  const sortedLines = [...session.lines].sort((a, b) => a.t - b.t)

  // Generate the AI recap (like a live meeting) so the imported meeting lands WITH its summary — the
  // feature a user expects: import a recording, get a transcript AND a résumé. Gated on the
  // summarizeOnImport setting AND a usable provider (transcription itself is always free + on-device;
  // a recap needs a model). Any failure degrades cleanly to transcript-only and never fails the save.
  let recap = ''
  const transcriptText = sortedLines
    .map((l) => l.text)
    .join('\n')
    .trim()
  if (settings.summarizeOnImport && transcriptText && hasUsableProvider(settings)) {
    onProgress(100, 'summarizing')
    try {
      recap = (await generateImportRecap(settings, transcriptText)).trim()
    } catch (e) {
      mainLog.warn('[import] recap generation failed; saving transcript only', e)
      recap = ''
    }
  }

  try {
    const meeting: SaveMeeting = {
      title: session.title,
      mode: 'meeting',
      startedAt: session.startedAt,
      lines: sortedLines,
      recap
    }
    const file = await saveMeeting(settings, meeting)
    auditLog('transcript.imported', { lines: sortedLines.length, encrypted: !!settings.encryptTranscripts })
    enqueueIngest(file) // Mantu Intelligence brain — background extraction; never blocks the save
    return { ok: true, file, title: session.title, lines: sortedLines }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    abandonImportSession()
  }
}
