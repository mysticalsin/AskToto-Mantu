import type { SaveMeeting, TranscriptLine } from '@shared/ipc'
import type { ImportRetentionState } from './import-retention-policy'
import type { ImportAsrDecodeAdmission, ImportAsrLanguageProbe, ImportAsrTranscriber } from './import-asr-admission'

export interface ImportHoldInventory {
  jobIds: string[]
  policyHeldJobIds: string[]
  inventoryOverflow: boolean
  policyHoldOverflow: boolean
}

export type ImportJobState =
  | 'queued'
  | 'decoding'
  | 'transcribing'
  | 'saving'
  | 'recapping'
  | 'done'
  | 'failed'
  | 'policy-held'
  | 'cancelled'

export interface ImportJobSource {
  path: string
  name: string
  sizeBytes: number
  mtimeMs: number
}

export interface ImportJob {
  jobId: string
  sourcePath: string
  sourceName: string
  sourceSizeBytes: number
  sourceMtimeMs: number
  title: string
  state: ImportJobState
  /** Number of fully transcribed chunks. The decoder skips these after a restart. */
  cursor: number
  /** 0 while a streaming decoder is still discovering the recording length. */
  totalChunks: number
  /** Decoder-reported transcription progress. Kept separate from totalChunks because FFmpeg may learn the
   * exact duration only after it has started streaming PCM. This value is monotonic and capped at 99 until
   * the import reaches its terminal done state. */
  progressPct?: number
  lines: TranscriptLine[]
  file?: string
  error?: string
  recapError?: string
  /** Persona (settings.mode) captured at import start. The recap step runs later, queue-ordered — without
   * this pin a persona switch mid-queue would shape an unrelated import's summary. Absent on jobs
   * checkpointed by older builds; consumers fall back to the live mode. */
  mode?: string
  /** Decode chunk-window size (seconds, IMPORT_CHUNK_SECONDS) this job's cursor/lines/totalChunks were
   *  checkpointed against. Stamped once at start() and never changed while a job is in flight. recover()
   *  compares it against the CURRENT constant: a mismatch (older build, or the constant changed since)
   *  means `cursor` no longer lines up with the decoder's actual chunk boundaries — resuming would splice
   *  windows recorded at two different sizes into one transcript. Absent on jobs checkpointed before this
   *  field existed, which recover() also treats as a mismatch. */
  chunkSec?: number
  /** MQA-235: which transcription pipeline this job's cursor/lines were checkpointed against.
   *  'vad-v2' = the utterance pipeline (cursor counts VAD windows; resume re-decodes+re-segments —
   *  deterministic — and skips windows < cursor). Absent = the legacy fixed-slab pipeline. */
  pipeline?: 'vad-v1' | 'vad-v2'
  /** Recording length measured from decoded PCM, not the start time of its last utterance. */
  durationMs?: number
  createdAt: number
  updatedAt: number
}

export interface ImportJobStore {
  save(job: ImportJob, beforeReplace?: () => void): Promise<void>
  list(): Promise<ImportJob[]>
  remove(jobId: string): Promise<void>
  markExistingJobsHeld?(reason?: 'policy' | 'restart'): Promise<ImportHoldInventory>
  listHeldJobIds?(): Promise<ImportHoldInventory>
  loadHeld?(jobId: string, explicitResume?: boolean): Promise<ImportJob | undefined>
  clearHold?(jobId: string): Promise<void>
  markHeld?(jobId: string, reason?: 'policy' | 'restart'): Promise<boolean>
}

/** In-memory identity for one admitted decode attempt. A retry of the same durable job gets a new ID. */
export interface ImportSpeakerAttempt {
  readonly jobId: string
  readonly attemptId: number
}

/** OS memory snapshot taken exactly when a queued job claims the sole decoder admission slot. */
export interface ImportDecodeMemoryAdmission {
  totalMemoryBytes: unknown
  freeMemoryBytes: unknown
}

export interface ImportJobsSnapshot {
  jobs: ImportJob[]
  policyBlocked: boolean
  policyState: ImportRetentionState
  heldJobIds: string[]
  policyHeldJobIds: string[]
  inventoryOverflow: boolean
  policyHoldOverflow: boolean
}

export interface ImportJobManagerDeps {
  store: ImportJobStore
  /** Starts an isolated decoder for the selected source. It must return immediately; completion arrives through finishDecoding. */
  decode: (job: ImportJob) => void | Promise<void>
  /** `language`, when set, is the whole-recording majority vote (see finishDecoding) — the engine may
   *  hard-pin it instead of guessing per window. Null/absent = engine decides (legacy behavior). */
  transcribe: ImportAsrTranscriber
  /** MQA-235: language-ID one utterance window (Parakeet text + lang-id in the live wiring). Used for
   *  the whole-recording majority vote; absent = no vote, engines guess as before. */
  probeLanguageName?: ImportAsrLanguageProbe
  /** Synchronously admit exact transient speaker ownership for one fresh import attempt. */
  beginSpeakers?: (attempt: ImportSpeakerAttempt) => boolean
  /** MQA-235: diarize one utterance window — an enrolled profile name or a session cluster label
   *  ("Speaker N"), null when the extractor is unavailable/degenerate. Requires beginSpeakers=true. */
  speakerFor?: (samples: Float32Array, attempt: ImportSpeakerAttempt) => Promise<string | null>
  /** MQA-238: whole-recording speaker-cluster merge, called once after the window loop. Returns the
   *  old->final label mapping applied to every line's `name`; null/absent = no relabel. */
  finalizeSpeakers?: (attempt: ImportSpeakerAttempt) => Map<string, string> | null
  /** Release the exact transient session. Must be synchronous; native/model release is owned elsewhere. */
  disposeSpeakers?: (attempt: ImportSpeakerAttempt) => void
  /** Plaud-style cleanup pass over the finished lines (stutters/punctuation, never a paraphrase).
   *  Fail-open: a throw keeps the raw lines. */
  polish?: (lines: TranscriptLine[]) => Promise<TranscriptLine[]>
  /** Fired when the FIFO goes idle (no active job) — the wiring uses it to stop the whisper helper
   *  process and release its model memory between imports. */
  onIdle?: () => void
  saveMeeting: (meeting: SaveMeeting, beforeReplace?: () => void) => Promise<string>
  /** Best-effort cleanup for a meeting file that finished saving after its job was already cancelled. */
  deleteMeeting?: (file: string) => Promise<unknown>
  /** Persists the background-intelligence intent before extraction starts; may resolve after local I/O. */
  enqueueIngest: (
    file: string,
    options?: { force?: boolean; deferred?: boolean },
    beforeReplace?: () => void
  ) => void | Promise<void>
  /** Returns a persisted-meeting recap or undefined when no provider is configured. */
  generateRecap: (job: ImportJob) => Promise<string | undefined>
  updateRecap: (file: string, recap: string, recapStatus: 'complete', beforeReplace?: () => void) => Promise<void>
  /** Credit the durable time-saved counters for one summarized meeting (main/store.ts). Optional so the
   *  import-jobs unit tests need not wire it; the live app always provides it. */
  recordMeetingSummarized?: (durationMin: number) => void
  /** Honest note-taking estimate for an imported transcript (words / 180 wpm). */
  recordTimeSavedNote?: (words: number, file: string) => void
  onChange?: (job: ImportJob) => void
  /** Resolve only after the owned decoder has stopped, preventing overlapping FIFO jobs. */
  onCancel?: (jobId: string) => void | Promise<void>
  /** Current persona (settings.mode), snapshotted into the job at start() — see ImportJob.mode. */
  personaMode?: () => string
  /** Current trusted organization policy; checked before admission and every durable write. */
  canRetainTranscript?: () => boolean
  /** Explicit closed retention state for production; legacy callback remains for isolated old fixtures. */
  retentionStatus?: () => ImportRetentionState
  /** Freshly re-reads trusted policy after async boundaries before work or transcript persistence. */
  refreshRetentionStatus?: () => Promise<ImportRetentionState>
  /** Current authenticated-session check for explicit held-job resume boundaries. */
  isImportAuthorized?: () => boolean
  /** Revalidates the exact source fingerprint before explicit resume. */
  validateSource?: (job: ImportJob) => void | Promise<void>
  /** Current OS free memory in bytes. Injected by tests; production reads node:os freemem(). */
  freeMemoryBytes?: () => unknown
  /** Physical OS memory in bytes. Injected by tests; production reads node:os totalmem(). */
  totalMemoryBytes?: () => unknown
  /** Called at actual decoder admission, after any low-free-memory VAD downgrade. */
  onDecodeAdmission?: ImportAsrDecodeAdmission
  now?: () => number
  newId?: () => string
  /** How many recordings may occupy the decoded-audio admission slot at once. ASR stays mutexed. The
   *  slot remains occupied through PCM consumption; recap never counts. */
  concurrency?: number
}
