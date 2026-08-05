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
  transcribe: (samples: Float32Array) => Promise<string>
  saveMeeting: (meeting: SaveMeeting) => Promise<string>
  /** Best-effort cleanup for a meeting file that finished saving after its job was already cancelled. */
  deleteMeeting?: (file: string) => Promise<unknown>
  /** Persists the background-intelligence intent before extraction starts; may resolve after local I/O. */
  enqueueIngest: (file: string) => void | Promise<void>
  /** Returns a persisted-meeting recap or undefined when no provider is configured. */
  generateRecap: (job: ImportJob) => Promise<string | undefined>
  updateRecap: (file: string, recap: string) => Promise<void>
  onChange?: (job: ImportJob) => void
  /** Resolve only after the owned decoder has stopped, preventing overlapping FIFO jobs. */
  onCancel?: (jobId: string) => void | Promise<void>
  /** Current persona (settings.mode), snapshotted into the job at start() — see ImportJob.mode. */
  personaMode?: () => string
  now?: () => number
  newId?: () => string
}

const CHUNK_MS = IMPORT_CHUNK_SECONDS * 1_000

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
        if (job.file && job.state === 'recapping') {
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
        if (job.chunkSec !== IMPORT_CHUNK_SECONDS) {
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
    const normalized = Number.isFinite(pct) ? Math.max(0, Math.min(99, Math.round(pct))) : 0
    const next = Math.max(job.progressPct ?? 0, normalized)
    if (job.progressPct !== undefined && next === job.progressPct) return
    job.progressPct = next
    await this.persist(job)
  }

  async resume(jobId: string): Promise<ImportJob> {
    const job = this.requireJob(jobId)
    if (job.state !== 'failed') throw new Error('Only a failed import can be resumed.')
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
    if (seq < job.cursor) return // replay during resume: this checkpoint already exists
    if (seq !== job.cursor) {
      await this.fail(job, `Decoded audio arrived out of order (expected chunk ${job.cursor + 1}).`)
      throw new Error(job.error)
    }
    if (job.totalChunks && job.totalChunks !== totalChunks) {
      await this.fail(job, 'The decoder changed the recording chunk count while importing.')
      throw new Error(job.error)
    }

    if (totalChunks > 0) job.totalChunks = totalChunks
    job.state = 'transcribing'
    await this.persist(job)

    try {
      const text = await this.transcribeWithRetry(samples)
      if (this.isCancelled(job)) return
      if (text.trim()) {
        job.lines.push({ speaker: 'unknown', text: text.trim(), t: job.sourceMtimeMs + seq * CHUNK_MS })
      }
      job.cursor = seq + 1
      job.state = 'decoding'
      await this.persist(job)
    } catch (error) {
      if (this.isCancelled(job)) return
      await this.fail(job, message(error))
      throw error
    }
  }

  /** Called by the hidden decoder only after it has submitted every non-skipped chunk. */
  async finishDecoding(jobId: string, discoveredTotalChunks?: number): Promise<void> {
    const job = this.requireJob(jobId)
    if (job.state === 'cancelled' || terminal(job.state)) return
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

    try {
      // A completed transcript is intentionally 99% until the automatic summary has been attempted and
      // persisted. The renderer can therefore transition cleanly from transcription to "Creating summary"
      // instead of flashing 100% before the meeting is actually ready.
      job.progressPct = Math.max(job.progressPct ?? 0, 99)
      job.state = 'saving'
      await this.persist(job)
      const file = await this.deps.saveMeeting({
        title: job.title,
        mode: 'meeting',
        startedAt: job.sourceMtimeMs,
        lines: [...job.lines].sort((a, b) => a.t - b.t),
        recap: ''
      })
      if (this.isCancelled(job)) {
        // cancel() flipped the job to 'cancelled' while saveMeeting() was in flight. The meeting file
        // already landed on disk but job.file was never recorded — delete it here so a cancelled import
        // never leaves an orphaned meeting behind.
        await this.deleteOrphanedFile(file)
        return
      }
      job.file = file
      job.state = 'recapping'
      await this.persist(job)
      try {
        const recap = await this.deps.generateRecap(copy(job))
        if (this.isCancelled(job)) return
        if (recap?.trim()) {
          await this.deps.updateRecap(file, recap)
          if (this.isCancelled(job)) return
        } else {
          job.recapError = 'No AI provider is configured to create the automatic summary.'
        }
      } catch (error) {
        // A transcript is already safe. Keep the result visible and retryable rather than pretending it has a recap.
        job.recapError = message(error)
      }

      // Queue after the recap stage so Mantu Intelligence sees the durable transcript and summary together.
      if (this.isCancelled(job)) return
      await this.deps.enqueueIngest(file)

      job.progressPct = 100
      job.state = 'done'
      await this.persist(job)
      await this.removeCheckpoint(job.jobId)
    } catch (error) {
      if (!this.isCancelled(job)) await this.fail(job, message(error))
    } finally {
      if (this.activeJobId === jobId) {
        this.activeJobId = null
        await this.pump()
      }
    }
  }

  async failDecoder(jobId: string, error: unknown): Promise<void> {
    const job = this.requireJob(jobId)
    if (terminal(job.state)) return
    await this.fail(job, message(error))
  }

  private async transcribeWithRetry(samples: Float32Array): Promise<string> {
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.deps.transcribe(samples)
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
      this.activeJobId = null
      await this.pump()
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
