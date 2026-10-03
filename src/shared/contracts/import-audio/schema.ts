import { z } from 'zod'
import type { TranscriptLine } from '../transcript/schema'

export const SaveNoteSchema = z.object({
  title: z.string().default(''),
  mode: z.string().default('general'),
  question: z.string().default(''),
  answer: z.string().min(1)
})
export type SaveNote = z.infer<typeof SaveNoteSchema>

/**
 * Import audio file → on-device transcription (see main/import-audio.ts). The renderer decodes any
 * target format + resamples/mixes down to 16kHz mono locally (Chromium can; main has no ffmpeg), then
 * streams it to main as a sequence of ~30s windows over repeated invoke calls rather than one giant
 * transfer. `samples` is capped well above a real ~30s window at 16kHz mono — same defensive reasoning
 * as parakeetFeed's own cap — so a malicious/malfunctioning renderer can't force a huge synchronous
 * decode. `name`/`mtimeMs` mirror what importAudioPick already handed the renderer (the source file's
 * name + modified time); main only reads them when a chunk starts a NEW session (an unseen sessionId),
 * to derive the saved meeting's title (humanized filename) and startedAt (file mtime) — later chunks in
 * the same session ignore them.
 */
const IMPORT_AUDIO_MAX_CHUNK_SAMPLES = 16_000 * 35
export const ImportAudioChunkSchema = z.object({
  sessionId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive().max(20_000),
  done: z.boolean(),
  name: z.string().max(300),
  mtimeMs: z.number().finite(),
  samples: z
    .instanceof(Float32Array)
    .refine((s) => s.length <= IMPORT_AUDIO_MAX_CHUNK_SAMPLES, 'Audio chunk too large.')
})
export type ImportAudioChunk = z.infer<typeof ImportAudioChunkSchema>

/** One accepted recording from import-audio:pick / offer. `token` is never a file path. */
export interface ImportAudioPickedFile {
  token: string
  name: string
  sizeBytes: number
  mtimeMs: number
}

export interface ImportAudioSkippedFile {
  name: string
  error: string
}

/** Result of import-audio:pick or import-audio:offer. Tokens are opaque, single-use, never file paths. */
export interface ImportAudioPickResult {
  cancelled?: boolean
  error?: string
  token?: string
  name?: string
  sizeBytes?: number
  mtimeMs?: number
  files?: ImportAudioPickedFile[]
  skipped?: ImportAudioSkippedFile[]
}

export const ImportAudioStartSchema = z.object({ token: z.string().min(20).max(200) })
export type ImportAudioStart = z.infer<typeof ImportAudioStartSchema>

export const ImportAudioStartBatchSchema = z.object({
  tokens: z.array(z.string().min(20).max(200)).min(1).max(50)
})
export type ImportAudioStartBatch = z.infer<typeof ImportAudioStartBatchSchema>

export const ImportAudioOfferSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).max(50)
})
export type ImportAudioOffer = z.infer<typeof ImportAudioOfferSchema>

export interface ImportAssetsProgress {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  progress: number
  label: string
  error?: string
}

/** Onboarding / Settings snapshot of Parakeet + Whisper-floor readiness. */
export interface AsrAssetsStatus extends ImportAssetsProgress {
  ready: boolean
}

export type ImportJobState =
  | 'queued'
  | 'decoding'
  | 'transcribing'
  | 'saving'
  | 'recapping'
  | 'done'
  | 'failed'
  | 'cancelled'

/** Sanitised job state exposed to the overlay. Source paths remain main-process-only. */
export interface ImportJobView {
  jobId: string
  title: string
  state: ImportJobState
  cursor: number
  totalChunks: number
  /** Null means the decoder has not supplied a trustworthy denominator yet. */
  pct: number | null
  error?: string
  recapError?: string
  file?: string
  createdAt: number
  updatedAt: number
  queuePosition?: number
}

export const ImportJobIdSchema = z.object({ jobId: z.string().min(1).max(200) })

/** Result of one import-audio:transcribe call. Only `file`/`title`/`lines` are populated on the final
 *  (done) chunk, once the accumulated transcript has actually been saved. */
export interface ImportAudioChunkResult {
  ok: boolean
  error?: string
  file?: string
  title?: string
  lines?: TranscriptLine[]
}

/** Pushed via webContents.send while a session is transcribing/saving — drives the "Import audio"
 *  button's progress label in RecallView. */
export interface ImportAudioProgress {
  job: ImportJobView
}

/** Main validates every one of these payloads again and accepts them only from the dedicated decoder. */
export const ImportDecoderChunkSchema = z.object({
  jobId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive().max(20_000),
  samples: z.instanceof(Float32Array).refine((s) => s.length <= IMPORT_AUDIO_MAX_CHUNK_SAMPLES, 'Audio chunk too large.')
})
export const ImportDecoderCompleteSchema = z.object({ jobId: z.string().min(1).max(200) })
export const ImportDecoderFailedSchema = z.object({
  jobId: z.string().min(1).max(200),
  error: z.string().min(1).max(800)
})
