import { vadWindowsFromPcm } from '@shared/vad'
import { IMPORT_CHUNK_SECONDS, type SaveMeeting, type TranscriptLine } from '@shared/ipc'

/**
 * Main-process import queue. It deliberately persists text checkpoints, not decoded PCM: raw audio is
 * never left on disk and a restart simply asks the isolated decoder to replay the source from `cursor`.
 */
export type ImportJobState =
  | 'queued'
  | 'decoding'
  | 'transcribing'
  | 'saving'
  | 'recapping'
  | 'done'
  | 'failed'
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
   *  'vad-v1' = the utterance pipeline (cursor counts VAD windows; resume re-decodes+re-segments —
   *  deterministic — and skips windows < cursor). Absent = the legacy fixed-slab pipeline. */
  pipeline?: 'vad-v1'
  createdAt: number
  updatedAt: number
}

export interface ImportJobStore {
  save(job: ImportJob): Promise<void>
  list(): Promise<ImportJob[]>
  remove(jobId: string): Promise<void>
}

export interface ImportJobManagerDeps {
  store: ImportJobStore
  /** Starts an isolated decoder for the selected source. It must return immediately; completion arrives through finishDecoding. */
  decode: (job: ImportJob) => void | Promise<void>
  /** `language`, when set, is the whole-recording majority vote (see finishDecoding) — the engine may
   *  hard-pin it instead of guessing per window. Null/absent = engine decides (legacy behavior). */
  transcribe: (samples: Float32Array, opts?: { language?: string | null }) => Promise<string>
  /** MQA-235: language-ID one utterance window (Parakeet text + lang-id in the live wiring). Used for
   *  the whole-recording majority vote; absent = no vote, engines guess as before. */
  probeLanguageName?: (samples: Float32Array) => Promise<string | null>
  /** MQA-235: diarize one utterance window — an enrolled profile name or a session cluster label
   *  ("Speaker N"), null when the extractor is unavailable/degenerate. Absent = lines stay 'unknown'. */
  speakerFor?: (samples: Float32Array) => Promise<string | null>
  /** MQA-238: whole-recording speaker-cluster merge, called once after the window loop. Returns the
   *  old->final label mapping applied to every line's `name`; null/absent = no relabel. */
  finalizeSpeakers?: () => Map<string, string> | null
  /** Plaud-style cleanup pass over the finished lines (stutters/punctuation, never a paraphrase).
   *  Fail-open: a throw keeps the raw lines. */
  polish?: (lines: TranscriptLine[]) => Promise<TranscriptLine[]>
  /** Fired when the FIFO goes idle (no active job) — the wiring uses it to stop the whisper helper
   *  process and release its model memory between imports. */
  onIdle?: () => void
  saveMeeting: (meeting: SaveMeeting) => Promise<string>
  /** Best-effort cleanup for a meeting file that finished saving after its job was already cancelled. */
  deleteMeeting?: (file: string) => Promise<unknown>
  /** Persists the background-intelligence intent before extraction starts; may resolve after local I/O. */
  enqueueIngest: (file: string) => void | Promise<void>
  /** Returns a persisted-meeting recap or undefined when no provider is configured. */
  generateRecap: (job: ImportJob) => Promise<string | undefined>
  updateRecap: (file: string, recap: string) => Promise<void>
  /** Credit the durable time-saved counters for one summarized meeting (main/store.ts). Optional so the
   *  import-jobs unit tests need not wire it; the live app always provides it. */
  recordMeetingSummarized?: (durationMin: number) => void
  onChange?: (job: ImportJob) => void
  /** Resolve only after the owned decoder has stopped, preventing overlapping FIFO jobs. */
  onCancel?: (jobId: string) => void | Promise<void>
  /** Current persona (settings.mode), snapshotted into the job at start() — see ImportJob.mode. */
  personaMode?: () => string
  now?: () => number
  newId?: () => string
}

const CHUNK_MS = IMPORT_CHUNK_SECONDS * 1_000
const SAMPLE_RATE = 16_000
/** Whole-recording PCM is buffered in memory for VAD segmentation. 90 minutes at 16kHz f32 is ~345MB —
 *  acceptable for a desktop import; past it the job degrades to the legacy fixed-slab pipeline rather
 *  than risking an OOM (`vad-v1` is dropped and the buffered slabs are transcribed as-is). */
const VAD_MAX_SAMPLES = SAMPLE_RATE * 60 * 90
/** Majority-vote sample points across the recording's windows. Five spread probes beat the old single
 *  window-0 probe because window 0 is disproportionately a greeting in the OTHER language ("Hello" on a
 *  French call) — the documented 2026-08-05 failure that translated a whole meeting. */
const LANGUAGE_VOTE_PROBES = 5

const terminal = (state: ImportJobState): boolean => state === 'done' || state === 'failed' || state === 'cancelled'

function titleFromSource(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '')
  const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return 'Imported audio'
  return words
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Serialises one CPU-bound import at a time. Each success checkpoint is durable before the decoder may
 * submit the next chunk, so closing the overlay can never discard already-recognized speech.
 */
export class ImportJobManager {
  private readonly jobs = new Map<string, ImportJob>()
  private readonly queue: string[] = []
  /** In-memory only: decoded PCM slabs for the ACTIVE vad-v1 job (never persisted; resume re-decodes). */
  private pcm: Float32Array[] = []
  private pcmSamples = 0
  private activeJobId: string | null = null
  private loaded = false

  constructor(private readonly deps: ImportJobManagerDeps) {}

  async start(source: ImportJobSource): Promise<ImportJob> {
    const now = this.now()
    const job: ImportJob = {
      jobId: this.newId(),
      sourcePath: source.path,
      sourceName: source.name,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
      title: titleFromSource(source.name),
      state: 'queued',
      cursor: 0,
      totalChunks: 0,
      lines: [],
      chunkSec: IMPORT_CHUNK_SECONDS,
      pipeline: 'vad-v1',
      ...(this.deps.personaMode ? { mode: this.deps.personaMode() } : {}),
      createdAt: now,
      updatedAt: now
    }
    this.jobs.set(job.jobId, job)
    await this.persist(job)
    this.enqueue(job.jobId)
    await this.pump()
    return copy(this.requireJob(job.jobId))
  }

  /** Reloads unfinished jobs after an app restart. The caller verifies source identity before decoding. */
  async recover(): Promise<ImportJob[]> {
    if (this.loaded) return this.list()
    this.loaded = true
    for (const saved of await this.deps.store.list()) {
      if (!saved?.jobId || !saved.sourcePath || !saved.sourceName) continue
      const job = copy(saved)
      this.jobs.set(job.jobId, job)
      if (!terminal(job.state)) {
        // The meeting file is already durable once `file` is present. A crash during recap must not
        // replay the decoder and create a duplicate meeting; surface it as a completed transcript so
        // the user can open the note and retry its summary manually.
        // MQA-105: 'saving' joins 'recapping' here. Both states now only ever persist WITH a durable
        // file (see the pump save ordering), so a crash in either window must surface the saved
        // transcript rather than replay the decoder into a duplicate meeting.
        if (job.file && (job.state === 'recapping' || job.state === 'saving')) {
          job.state = 'done'
          job.recapError = 'Automatic summary was interrupted. Open the meeting to retry it.'
          await this.persist(job)
          await this.removeCheckpoint(job.jobId)
          continue
        }
        // A checkpoint written under a different decode chunk size (older build, or IMPORT_CHUNK_SECONDS
        // changed since) has a cursor/totalChunks that no longer line up with the current decoder's chunk
        // boundaries. Resuming would splice windows recorded at two different sizes into one transcript —
        // wrong line timestamps at best, a rejected "decoder changed the recording chunk count" failure at
        // worst (the browser-fallback decoder recomputes totalChunks from the new chunk size on its very
        // first submitted chunk). Re-transcribing the whole file from scratch is slower but correct.
        if (job.pipeline === 'vad-v1') {
          // Window boundaries are recomputed from the SAME deterministic VAD on resume, so cursor/lines
          // stay valid regardless of slab size. A resume always re-decodes from 0 (decode is seconds of
          // ffmpeg; the expensive part is ASR, which the window cursor skips).
        } else if (job.chunkSec !== IMPORT_CHUNK_SECONDS) {
          job.cursor = 0
          job.lines = []
          job.totalChunks = 0
          job.progressPct = undefined
          job.chunkSec = IMPORT_CHUNK_SECONDS
        }
        job.state = 'queued'
        job.error = undefined
        await this.persist(job)
        this.enqueue(job.jobId)
      }
    }
    await this.pump()
    return this.list()
  }

  list(): ImportJob[] {
    return [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(copy)
  }

  get(jobId: string): ImportJob | undefined {
    const job = this.jobs.get(jobId)
    return job ? copy(job) : undefined
  }

  /** Persist a decoder progress signal without pretending that 100% means the summary is ready. */
  async reportProgress(jobId: string, pct: number): Promise<void> {
    const job = this.requireJob(jobId)
    if (terminal(job.state)) return
    let normalized = Number.isFinite(pct) ? Math.max(0, Math.min(99, Math.round(pct))) : 0
    // vad-v1: the decoder's 0-99 covers only phase 1 (decode+segment, seconds); phase 2 (ASR, minutes)
    // owns 15..99 via the window loop. Unscaled, the bar would jump to 99 and sit there for the whole
    // transcription.
    if (job.pipeline === 'vad-v1' && job.state === 'decoding') normalized = Math.round(normalized * 0.15)
    const next = Math.max(job.progressPct ?? 0, normalized)
    if (job.progressPct !== undefined && next === job.progressPct) return
    job.progressPct = next
    await this.persist(job)
  }

  async resume(jobId: string): Promise<ImportJob> {
    const job = this.requireJob(jobId)
    if (job.state !== 'failed') throw new Error('Only a failed import can be resumed.')
    // Same invariant recover() enforces at the crash path: once `file` is present the meeting is already
    // durable. Replaying the decoder would run saveMeeting() a second time, and saveMeeting never
    // overwrites — it picks a fresh non-colliding name, so the user would get a duplicate meeting file, a
    // duplicate index.md row and a duplicate brain ingest of one conversation. Only the summary is missing.
    if (job.file) {
      job.state = 'done'
      job.error = undefined
      // Keep whatever the recap stage already reported; explain the interruption only when it never got
      // that far, so the card says the transcript is safe and only its summary needs a manual retry.
      job.recapError = job.recapError ?? 'Automatic summary was interrupted. Open the meeting to retry it.'
      await this.persist(job)
      await this.removeCheckpoint(job.jobId)
      return copy(this.requireJob(jobId))
    }
    job.state = 'queued'
    job.error = undefined
    job.recapError = undefined
    await this.persist(job)
    this.enqueue(jobId)
    await this.pump()
    return copy(this.requireJob(jobId))
  }

  async cancel(jobId: string, opts: { pump?: boolean } = {}): Promise<void> {
    const job = this.requireJob(jobId)
    if (terminal(job.state)) return
    job.state = 'cancelled'
    job.error = undefined
    await this.persist(job)
    await this.removeCheckpoint(job.jobId)
    await this.deps.onCancel?.(jobId)
    if (this.activeJobId === jobId) {
      this.takePcm()
      this.activeJobId = null
      // cancelAll() passes pump:false so draining one job can't promote the next queued job into
      // 'decoding' before the loop has cancelled it too; it pumps once itself after everything is terminal.
      if (opts.pump !== false) await this.pump()
    }
  }

  /** Permanently dismisses a terminal (failed/cancelled/done) job: drops it from memory and from the
   *  persistent checkpoint store. Non-terminal jobs refuse — dismissing an in-flight import would orphan
   *  its decoder/transcription work with nothing left to report back to. Unlike removeCheckpoint() (used
   *  by cancel/finishDecoding, where a swallowed error just leaves a harmless stale checkpoint behind
   *  since the job's outcome is already durable elsewhere), a failed store deletion here must propagate:
   *  the in-memory job stays put so the card remains and the user can retry dismissing it, rather than
   *  silently reappearing after the next restart. */
  async remove(jobId: string): Promise<void> {
    const job = this.requireJob(jobId)
    if (!terminal(job.state)) throw new Error('Only a finished, failed, or cancelled import can be dismissed.')
    await this.deps.store.remove(jobId)
    this.jobs.delete(jobId)
  }

  /** Sign-out boundary: stop any decoder/transcription work before the auth session is cleared. Cancels
   *  every job with pumping suppressed, then pumps once at the end — by then every job is terminal, so
   *  that final pump is a no-op rather than a chance for a queued job to start decoding mid-drain. */
  async cancelAll(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (!terminal(job.state)) await this.cancel(job.jobId, { pump: false })
    }
    await this.pump()
  }

  /** Called only by the authenticated hidden decoder, one chunk at a time. */
  async acceptDecodedChunk(jobId: string, seq: number, totalChunks: number, samples: Float32Array): Promise<void> {
    const job = this.requireJob(jobId)
    if (job.state === 'cancelled') throw new Error('Import was cancelled.')
    if (terminal(job.state)) throw new Error('Import is no longer accepting audio.')
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(totalChunks) || totalChunks < 0) {
      throw new Error('Invalid decoded audio chunk.')
    }
    // A window should never exceed one decode chunk plus a few seconds of slack for FFmpeg/decoder jitter.
    if (samples.length > 16_000 * (IMPORT_CHUNK_SECONDS + 5)) throw new Error('Decoded audio chunk is too large.')
    // vad-v1: cursor counts WINDOWS (phase 2), not slabs — order is enforced against the count of
    // slabs already buffered instead. Legacy keeps the original cursor-based replay/order contract.
    const expectedSeq = job.pipeline === 'vad-v1' ? this.pcm.length : job.cursor
    if (seq < expectedSeq) return // replay during resume: this checkpoint already exists
    if (seq !== expectedSeq) {
      await this.fail(job, `Decoded audio arrived out of order (expected chunk ${expectedSeq + 1}).`)
      throw new Error(job.error)
    }
    if (job.totalChunks && job.totalChunks !== totalChunks) {
      await this.fail(job, 'The decoder changed the recording chunk count while importing.')
      throw new Error(job.error)
    }

    if (totalChunks > 0) job.totalChunks = totalChunks

    // MQA-235 (vad-v1): phase 1 only BUFFERS — segmentation and ASR happen in finishDecoding, where the
    // whole recording is known. Past the memory cap the job degrades to the legacy slab pipeline: the
    // backlog is transcribed slab-by-slab right here, then this and every later slab take the legacy
    // branch below.
    if (job.pipeline === 'vad-v1') {
      if (this.pcmSamples + samples.length <= VAD_MAX_SAMPLES) {
        // Own copy: the decoder reuses its buffer across chunks.
        this.pcm.push(samples.slice())
        this.pcmSamples += samples.length
        return
      }
      job.pipeline = undefined
      job.chunkSec = IMPORT_CHUNK_SECONDS
      await this.persist(job)
      const backlog = this.takePcm()
      let backlogSeq = 0
      for (const slab of backlog) {
        await this.legacyTranscribeSlab(job, backlogSeq++, slab)
        if (terminal(job.state)) return
      }
      // fall through: the CURRENT slab is transcribed by the legacy branch below
    }

    job.state = 'transcribing'
    await this.persist(job)

    try {
      await this.legacyTranscribeSlab(job, seq, samples)
      job.state = 'decoding'
      await this.persist(job)
    } catch (error) {
      if (this.isCancelled(job)) return
      await this.fail(job, message(error))
      throw error
    }
  }

  /** One legacy fixed-slab transcription step: ASR the slab, append the line, advance the slab cursor. */
  private async legacyTranscribeSlab(job: ImportJob, seq: number, samples: Float32Array): Promise<void> {
    if (seq < job.cursor) return
    const text = await this.transcribeWithRetry(samples)
    if (this.isCancelled(job)) return
    if (text.trim()) {
      job.lines.push({ speaker: 'unknown', text: text.trim(), t: job.sourceMtimeMs + seq * CHUNK_MS })
    }
    job.cursor = seq + 1
    await this.persist(job)
  }

  /** Hand back and clear the buffered PCM for the active vad-v1 job. */
  private takePcm(): Float32Array[] {
    const slabs = this.pcm
    this.pcm = []
    this.pcmSamples = 0
    return slabs
  }

  /** Called by the hidden decoder only after it has submitted every non-skipped chunk. */
  async finishDecoding(jobId: string, discoveredTotalChunks?: number): Promise<void> {
    const job = this.requireJob(jobId)
    if (job.state === 'cancelled' || terminal(job.state)) return
    if (job.pipeline === 'vad-v1') {
      await this.finishVadPipeline(job)
      return
    }
    if (discoveredTotalChunks !== undefined) {
      if (!Number.isInteger(discoveredTotalChunks) || discoveredTotalChunks < 0) {
        await this.fail(job, 'Invalid final audio chunk count.')
        return
      }
      if (job.totalChunks && job.totalChunks !== discoveredTotalChunks) {
        await this.fail(job, 'The decoder changed the recording chunk count while importing.')
        return
      }
      job.totalChunks = discoveredTotalChunks
    }
    // A streaming decoder does not know the duration until EOF. Once it reaches EOF, the number of
    // durable checkpoints is the authoritative total and is persisted before the meeting is saved.
    if (!job.totalChunks) job.totalChunks = job.cursor
    if (!job.totalChunks || job.cursor !== job.totalChunks) {
      await this.fail(job, 'Audio decoding ended before all chunks were transcribed.')
      return
    }
    if (job.lines.length === 0) {
      await this.fail(job, 'No speech was recognized in this recording.')
      return
    }

    await this.finalize(job)
  }

  /**
   * MQA-235: phase 2 of the vad-v1 pipeline. The whole recording is buffered; segment it with the SAME
   * VAD the live path runs (utterance windows instead of arbitrary 12s slabs), majority-vote the
   * recording's language across spread probe windows (window 0 is disproportionately a greeting in the
   * other language — the documented 2026-08-05 mis-pin translated a whole meeting), then transcribe
   * window-by-window with a durable cursor, diarizing each window off its own samples. Lines carry the
   * window's real offset into the recording. A final polish pass (fail-open) cleans stutters before save.
   */
  private async finishVadPipeline(job: ImportJob): Promise<void> {
    const slabs = this.takePcm()
    const total = slabs.reduce((n, s2) => n + s2.length, 0)
    const pcm = new Float32Array(total)
    let off = 0
    for (const slab of slabs) {
      pcm.set(slab, off)
      off += slab.length
    }
    const windows = vadWindowsFromPcm(pcm, SAMPLE_RATE)
    if (windows.length === 0) {
      await this.fail(job, 'No speech was recognized in this recording.')
      return
    }
    job.totalChunks = windows.length
    job.state = 'transcribing'
    await this.persist(job)

    // Whole-recording language vote (only meaningful when a prober is wired).
    let votedLanguage: string | null = null
    if (this.deps.probeLanguageName && windows.length > 0) {
      const picks = new Set<number>()
      // Short recordings (proven on a 60s clip that mis-voted): 5 spread picks over few windows collapse
      // into 2-3 distinct probes and the vote abstains or lands wrong — probe EVERY window instead; the
      // >=2 agreement floor below still guards a single garbled probe.
      if (windows.length <= 2 * LANGUAGE_VOTE_PROBES) {
        for (let i = 0; i < windows.length; i++) picks.add(i)
      } else {
        for (let i = 0; i < LANGUAGE_VOTE_PROBES; i++) {
          picks.add(Math.min(windows.length - 1, Math.floor(((i + 0.5) / LANGUAGE_VOTE_PROBES) * windows.length)))
        }
      }
      const tally = new Map<string, number>()
      for (const idx of picks) {
        if (this.isCancelled(job)) return
        try {
          const w = windows[idx]
          const lang = await this.deps.probeLanguageName(pcm.subarray(w.start, w.end))
          if (lang) tally.set(lang, (tally.get(lang) ?? 0) + 1)
        } catch {
          /* a failed probe is an abstention */
        }
      }
      let best: string | null = null
      let bestCount = 0
      for (const [lang, count] of tally) {
        if (count > bestCount) {
          best = lang
          bestCount = count
        }
      }
      // A majority, not a plurality of one: with fewer than 2 agreeing probes the vote abstains and the
      // engine keeps its own per-window judgement.
      if (best && bestCount >= 2) votedLanguage = best
    }

    for (let i = job.cursor; i < windows.length; i++) {
      if (this.isCancelled(job)) return
      const w = windows[i]
      const samples = pcm.subarray(w.start, w.end)
      let text = ''
      try {
        text = await this.transcribeWithRetry(samples, { language: votedLanguage })
      } catch (error) {
        if (this.isCancelled(job)) return
        await this.fail(job, message(error))
        return
      }
      if (this.isCancelled(job)) return
      if (text.trim()) {
        // Diarization rides the additive `name` field (same slot the Teams-name backfill uses); the
        // SIDE stays 'unknown' — an imported recording has no mic/loopback split to infer you/them from.
        let name: string | undefined
        try {
          name = (await this.deps.speakerFor?.(samples)) || undefined
        } catch {
          /* diarization is best-effort — an extractor fault must never fail the import */
        }
        job.lines.push({
          speaker: 'unknown',
          ...(name ? { name } : {}),
          text: text.trim(),
          t: job.sourceMtimeMs + Math.round((w.start / SAMPLE_RATE) * 1000)
        })
      }
      job.cursor = i + 1
      job.progressPct = Math.max(job.progressPct ?? 0, 15 + Math.round((84 * (i + 1)) / windows.length))
      await this.persist(job)
    }

    if (job.lines.length === 0) {
      await this.fail(job, 'No speech was recognized in this recording.')
      return
    }

    // MQA-238: the online clusterer only looks backward, so one drifting voice fragments into several
    // labels. Now that every window has been seen, merge the session's clusters and relabel the lines.
    if (this.deps.finalizeSpeakers) {
      try {
        const mapping = this.deps.finalizeSpeakers()
        if (mapping) {
          for (const line of job.lines) {
            if (line.name && mapping.has(line.name)) line.name = mapping.get(line.name)
          }
        }
      } catch {
        /* best-effort — fragmented labels beat a failed import */
      }
    }

    // Plaud-style polish: stutter/punctuation cleanup, never a paraphrase. Fail-open by contract — the
    // raw lines are already durable in the checkpoint, so a polish fault costs readability, not speech.
    if (this.deps.polish) {
      try {
        const polished = await this.deps.polish(copy(job.lines))
        if (Array.isArray(polished) && polished.length === job.lines.length) job.lines = polished
      } catch {
        /* keep raw */
      }
      if (this.isCancelled(job)) return
    }

    await this.finalize(job)
  }

  /** The shared save→recap→ingest→done tail, used by both pipelines. */
  private async finalize(job: ImportJob): Promise<void> {
    try {
      // A completed transcript is intentionally 99% until the automatic summary has been attempted and
      // persisted. The renderer can therefore transition cleanly from transcription to "Creating summary"
      // instead of flashing 100% before the meeting is actually ready.
      // MQA-105: do NOT persist state 'saving' BEFORE the file exists. The old order left a checkpoint
      // reading 'saving' with no `file` for the whole span of saveMeeting AND the persist after it, so a
      // crash once the file had landed replayed the decoder and produced a DUPLICATE meeting. Now 'saving'
      // is only ever written together with the file, so a recovered 'saving' checkpoint always carries a
      // durable file and recover() treats it as a completed transcript instead of re-decoding.
      job.progressPct = Math.max(job.progressPct ?? 0, 99)
      const file = await this.deps.saveMeeting({
        title: job.title,
        mode: 'meeting',
        startedAt: job.sourceMtimeMs,
        lines: [...job.lines].sort((a, b) => a.t - b.t),
        recap: ''
      })
      job.file = file
      job.state = 'saving'
      await this.persist(job) // the file is now durable AND recorded in the checkpoint, atomically enough
      // cancel() flipped the job to 'cancelled' while saveMeeting() was in flight. The meeting file
      // already landed on disk — delete it and drop the checkpoint we just wrote so a cancelled import
      // never leaves an orphaned meeting OR a resurrectable checkpoint behind.
      if (await this.abandonIfCancelled(job, file)) return
      job.state = 'recapping'
      await this.persist(job)
      try {
        const recap = await this.deps.generateRecap(copy(job))
        if (await this.abandonIfCancelled(job, file)) return
        if (recap?.trim()) {
          await this.deps.updateRecap(file, recap)
          if (await this.abandonIfCancelled(job, file)) return
        } else {
          job.recapError = 'No AI provider is configured to create the automatic summary.'
        }
      } catch (error) {
        // A transcript is already safe. Keep the result visible and retryable rather than pretending it has a recap.
        job.recapError = message(error)
      }

      // Queue after the recap stage so Mantu Intelligence sees the durable transcript and summary together.
      if (await this.abandonIfCancelled(job, file)) return
      await this.deps.enqueueIngest(file)
      // MQA-104: enqueueIngest does real file I/O (index.json tmp-write+rename), a genuine yield point, so
      // a cancel racing it would otherwise fall straight through to the 'done' finalization below —
      // resurrecting the cancelled job as done and never deleting its meeting file. Re-check here.
      if (await this.abandonIfCancelled(job, file)) return

      // The user summarized a meeting via import — credit the durable time-saved counters ONCE, now that
      // the file is committed and past every cancel gate (the live-meeting path credits itself in the
      // saveTranscript IPC handler). MQA-111: use the transcript's own span (last line minus first),
      // which is correct for the import path's 0-based offset timestamps AND matches what
      // transcripts.meetingDurationMin now stamps into the frontmatter, so the counter and the meeting agree.
      const ts = job.lines.map((l) => l.t).filter((t) => Number.isFinite(t))
      const durMin = ts.length ? Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / 60000)) : 0
      this.deps.recordMeetingSummarized?.(durMin)

      job.progressPct = 100
      job.state = 'done'
      await this.persist(job)
      await this.removeCheckpoint(job.jobId)
    } catch (error) {
      if (!this.isCancelled(job)) await this.fail(job, message(error))
    } finally {
      if (this.activeJobId === job.jobId) {
        this.activeJobId = null
        await this.pump()
        if (!this.activeJobId) this.deps.onIdle?.()
      }
    }
  }

  async failDecoder(jobId: string, error: unknown): Promise<void> {
    const job = this.requireJob(jobId)
    if (terminal(job.state)) return
    await this.fail(job, message(error))
  }

  private async transcribeWithRetry(samples: Float32Array, opts?: { language?: string | null }): Promise<string> {
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.deps.transcribe(samples, opts)
      } catch (error) {
        last = error
      }
    }
    throw last instanceof Error ? last : new Error(message(last))
  }

  private enqueue(jobId: string): void {
    if (!this.queue.includes(jobId) && this.activeJobId !== jobId) this.queue.push(jobId)
  }

  private async pump(): Promise<void> {
    if (this.activeJobId) return
    while (this.queue.length) {
      const jobId = this.queue.shift()!
      const job = this.jobs.get(jobId)
      if (!job || terminal(job.state)) continue
      this.takePcm() // a cancelled/failed predecessor must never leak its buffered audio into this job
      // A vad-v1 job that failed mid-transcription already had `totalChunks` overwritten to the WINDOW
      // count by finishVadPipeline (phase 2). A resume always re-decodes from scratch (phase 1), whose
      // real decoder (index.ts's ffmpeg onChunk) always reports totalChunks 0 per slab — left un-reset,
      // that stale window count would trip acceptDecodedChunk's "decoder changed the recording chunk
      // count" guard on the very first re-fed slab, permanently breaking resume for any job that failed
      // past segmentation. Legacy (non-vad-v1) jobs are untouched: their totalChunks IS the real slab
      // count and resuming from a non-zero cursor legitimately depends on it staying put.
      if (job.pipeline === 'vad-v1') job.totalChunks = 0
      this.activeJobId = jobId
      job.state = 'decoding'
      await this.persist(job)
      try {
        await this.deps.decode(copy(job))
      } catch (error) {
        if (!this.isCancelled(job)) await this.fail(job, message(error))
      }
      // A decoder runs asynchronously and calls finishDecoding/failDecoder later. Keep its FIFO slot.
      return
    }
  }

  private async fail(job: ImportJob, error: string): Promise<void> {
    job.state = 'failed'
    job.error = error || 'Import failed.'
    await this.persist(job)
    if (this.activeJobId === job.jobId) {
      this.takePcm()
      this.activeJobId = null
      await this.pump()
      if (!this.activeJobId) this.deps.onIdle?.()
    }
  }

  private async persist(job: ImportJob): Promise<void> {
    job.updatedAt = this.now()
    await this.deps.store.save(copy(job))
    this.deps.onChange?.(copy(job))
  }

  private async removeCheckpoint(jobId: string): Promise<void> {
    try {
      await this.deps.store.remove(jobId)
    } catch {
      // A terminal job is already safely represented by the meeting file; a stale encrypted manifest
      // is preferable to turning a successful import into a failure.
    }
  }

  /** Every bail-out after saveMeeting() has landed must go through here. cancel() has already erased the
   *  checkpoint and the renderer hides cancelled cards, so a bare `return` would strand the meeting file
   *  and its index.md row on disk — a transcript of exactly the recording the user asked to discard, with
   *  nothing left to reconcile it. Reports whether the caller should stop. */
  private async abandonIfCancelled(job: ImportJob, file: string): Promise<boolean> {
    if (!this.isCancelled(job)) return false
    await this.deleteOrphanedFile(file)
    // MQA-105: the pump now persists a checkpoint (state 'saving', with the file) BEFORE this check, so
    // cancel()'s own checkpoint removal is no longer sufficient on its own — drop it again here so a
    // just-written checkpoint can never resurrect a job the user cancelled. Idempotent (best-effort).
    await this.removeCheckpoint(job.jobId)
    // The in-memory job just stops pointing at a file that is now gone.
    job.file = undefined
    return true
  }

  private async deleteOrphanedFile(file: string): Promise<void> {
    try {
      await this.deps.deleteMeeting?.(file)
    } catch {
      // Best-effort: a lingering meeting file for a cancelled import is preferable to crashing the pump.
    }
  }

  private requireJob(jobId: string): ImportJob {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Import job not found.')
    return job
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private isCancelled(job: ImportJob): boolean {
    return job.state === 'cancelled'
  }

  private newId(): string {
    return this.deps.newId?.() ?? crypto.randomUUID()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Import failed.')
}
