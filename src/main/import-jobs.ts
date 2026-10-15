import { freemem, totalmem } from 'node:os'
import { hasVadV2MemoryHeadroom } from '@shared/asr-hardware-preference'
import { IMPORT_CHUNK_SECONDS, type TranscriptLine } from '@shared/ipc'
import { ImportRetentionBlockedError } from './import-retention-policy'
import {
  consumeVadPcm,
  finalizeImportJob,
  hasMemoryHeavyImportWork,
  prepareImportCheckpoint,
  reportImportProgress,
  type ImportJobPipelineHost
} from './import-job-pipelines'
export { assembleVadPcmAndRelease } from './import-job-pipelines'
import {
  ImportJobRetentionCoordinator,
  StaleImportJobWriteError,
  type ImportRetentionHost,
  type ImportResumeHost
} from './import-job-retention-coordinator'
import type {
  ImportJobState,
  ImportJobSource,
  ImportJob,
  ImportJobStore,
  ImportSpeakerAttempt,
  ImportDecodeMemoryAdmission,
  ImportJobsSnapshot,
  ImportJobManagerDeps,
  ImportHoldInventory
} from './import-job-types'
export type {
  ImportJobState,
  ImportJobSource,
  ImportJob,
  ImportJobStore,
  ImportSpeakerAttempt,
  ImportDecodeMemoryAdmission,
  ImportJobsSnapshot,
  ImportJobManagerDeps,
  ImportHoldInventory
} from './import-job-types'

/**
 * Main-process import queue. It deliberately persists text checkpoints, not decoded PCM: raw audio is
 * never left on disk. On boot, saved imports are inventoried without reading payloads and require an
 * explicit Resume action before source validation or decoder admission.
 */
/** One decoded recording at a time, from decoder admission through retained-PCM consumption. */
export const MAX_CONCURRENT_DECODES = 1
/** @deprecated Use MAX_CONCURRENT_DECODES. Kept so existing imports keep compiling. */
export const MAX_CONCURRENT_IMPORTS = MAX_CONCURRENT_DECODES

const CHUNK_MS = IMPORT_CHUNK_SECONDS * 1_000
const SAMPLE_RATE = 16_000
/** Whole-recording PCM is buffered in memory for VAD segmentation. 90 minutes at 16kHz f32 is ~345MB —
 *  acceptable for a desktop import; past it the job degrades to the legacy fixed-slab pipeline rather
 *  than risking an OOM (`vad-v2` is dropped and the buffered slabs are transcribed as-is). */
const VAD_MAX_SAMPLES = SAMPLE_RATE * 60 * 90
/** Majority-vote sample points across the recording's windows. Five spread probes beat the old single
 *  window-0 probe because window 0 is disproportionately a greeting in the OTHER language ("Hello" on a
 *  French call) — the documented 2026-08-05 failure that translated a whole meeting. */
const ATTEMPT_STOPPED = Symbol('import-attempt-stopped')

interface SpeakerAttemptState {
  identity: ImportSpeakerAttempt
  accepting: boolean
  tailAllowed: boolean
  speakerOwned: boolean
  finalized: boolean
  disposed: boolean
}

const terminal = (state: ImportJobState): boolean =>
  state === 'done' || state === 'failed' || state === 'policy-held' || state === 'cancelled'

/** The singleton decoder may be reaped once the job is no longer in the decode phase.
 *  Transcribing / saving / recapping must not keep the next file waiting. */
export function decoderSlotIsStale(state: ImportJobState | undefined): boolean {
  return state !== 'decoding'
}

/** VAD cursors count utterance windows, not decoder slabs. Both decoders must replay all PCM. */
export function decodeSkipThrough(job: Pick<ImportJob, 'pipeline' | 'cursor'>): number {
  return job.pipeline === 'vad-v1' || job.pipeline === 'vad-v2' ? 0 : job.cursor
}

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
 * Decoded-audio admission is 1. Each success checkpoint is durable before the decoder may submit the
 * next chunk, so closing the overlay can never discard already-recognized speech. ASR calls are mutexed
 * so Parakeet / the Whisper host stay single-threaded. Recap runs after PCM admission is released.
 */
export class ImportJobManager {
  private readonly jobs = new Map<string, ImportJob>()
  private readonly retention = new ImportJobRetentionCoordinator()
  private readonly queue: string[] = []
  /** In-memory only: decoded PCM slabs per in-flight vad-v2 job (never persisted; resume re-decodes). */
  private readonly pcmByJob = new Map<string, { slabs: Float32Array[]; samples: number }>()
  /** Jobs that occupy the decoded-audio admission slot. Recap never belongs here. */
  private readonly decodeSlotIds = new Set<string>()
  /** Jobs whose whole-recording PCM has moved from pcmByJob into the VAD/ASR consumer's local scope. */
  private readonly retainedPcmConsumerIds = new Set<string>()
  /** Jobs still doing decode, ASR, save, or recap. Used for cancel/onIdle, not admission ownership. */
  private readonly activeJobIds = new Set<string>()
  /** Exact transient ownership for the currently admitted attempt of each durable job. */
  private readonly speakerAttempts = new Map<string, SpeakerAttemptState>()
  private nextAttemptId = 0
  private transcribeLock: Promise<void> = Promise.resolve()
  private loaded = false
  private readonly maxConcurrent: number

  private get durableJobs(): Map<string, ImportJob> {
    return this.retention.durableJobs
  }

  private get heldJobIds(): string[] {
    return this.retention.heldJobIds
  }

  private set heldJobIds(value: string[]) {
    this.retention.heldJobIds = value
  }

  private get policyHeldJobIds(): string[] {
    return this.retention.policyHeldJobIds
  }

  private set policyHeldJobIds(value: string[]) {
    this.retention.policyHeldJobIds = value
  }

  private get inventoryOverflow(): boolean {
    return this.retention.inventoryOverflow
  }

  private set inventoryOverflow(value: boolean) {
    this.retention.inventoryOverflow = value
  }

  private get policyHoldOverflow(): boolean {
    return this.retention.policyHoldOverflow
  }

  private set policyHoldOverflow(value: boolean) {
    this.retention.policyHoldOverflow = value
  }

  constructor(private readonly deps: ImportJobManagerDeps) {
    const n = deps.concurrency ?? MAX_CONCURRENT_DECODES
    this.maxConcurrent = Number.isFinite(n) && n > 0 ? Math.min(1, Math.floor(n)) : 1
  }

  async start(source: ImportJobSource): Promise<ImportJob> {
    const [job] = await this.startMany([source])
    return job
  }

  /** Create N durable jobs, then pump so as many as `maxConcurrent` begin decoding. */
  async startMany(sources: ImportJobSource[]): Promise<ImportJob[]> {
    this.assertRetentionAllowed()
    const started: string[] = []
    for (const source of sources) {
      const now = this.now()
      const pipeline = this.selectFreshPipeline()
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
        ...(pipeline ? { pipeline } : {}),
        ...(this.deps.personaMode ? { mode: this.deps.personaMode() } : {}),
        createdAt: now,
        updatedAt: now
      }
      this.jobs.set(job.jobId, job)
      await this.persist(job)
      this.enqueue(job.jobId)
      started.push(job.jobId)
    }
    await this.pump()
    return started.map((id) => copy(this.requireJob(id)))
  }

  /** Boot records bounded held identities only; it never reads checkpoint payloads or starts decoding. */
  async recover(): Promise<ImportJob[]> {
    if (this.loaded) return this.list()
    await this.retention.initialize(this.deps.store, this.retentionAllowed())
    this.loaded = true
    return []
  }

  list(): ImportJob[] {
    if (!this.retentionAllowed()) return []
    return [...this.jobs.values()]
      .filter((job) => job.state !== 'policy-held')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(copy)
  }

  async snapshot(): Promise<ImportJobsSnapshot> {
    return this.retention.snapshot(
      this.deps.store,
      () => this.retentionAllowed(),
      () => this.list(),
      () => this.holdAllForPolicy()
    )
  }

  get(jobId: string): ImportJob | undefined {
    if (!this.retentionAllowed()) return undefined
    const job = this.jobs.get(jobId)
    return job ? copy(job) : undefined
  }

  /**
   * True while the decoder slot owns whole-recording VAD PCM or drains its overflow backlog. A bounded
   * slab being consumed also reports pressure conservatively, so optional local work never competes for
   * decoded audio that has not yet been released.
   */
  hasMemoryHeavyWork(): boolean {
    return hasMemoryHeavyImportWork(this.jobs, this.decodeSlotIds, this.retainedPcmConsumerIds)
  }

  /** Persist a decoder progress signal without pretending that 100% means the summary is ready. */
  async reportProgress(jobId: string, pct: number): Promise<void> {
    const job = this.requireJob(jobId)
    await reportImportProgress(
      {
        retentionAllowed: () => this.retentionAllowed(),
        attemptAccepts: () => this.attemptAccepts(this.speakerAttempts.get(jobId)),
        holdForPolicy: (heldJob) => this.holdForPolicy(heldJob),
        persist: (updatedJob) => this.persist(updatedJob),
        isTerminal: terminal
      },
      job,
      pct
    )
  }

  async resume(jobId: string): Promise<ImportJob> {
    return this.retention.resume(jobId, this.deps.store, this.resumeHost())
  }

  async cancel(jobId: string, opts: { pump?: boolean } = {}): Promise<void> {
    const job = this.requireJob(jobId)
    if (terminal(job.state)) return
    const attempt = this.speakerAttempts.get(jobId)
    this.stopSpeakerAttempt(jobId)
    job.state = 'cancelled'
    job.error = undefined
    await this.persist(job)
    await this.removeCheckpoint(job.jobId)
    await this.deps.onCancel?.(jobId)
    this.takePcm(jobId)
    await this.releaseDecodeSlot(jobId)
    if (!this.decodeSlotIds.has(jobId) && !this.retainedPcmConsumerIds.has(jobId)) {
      this.retireAttempt(jobId, attempt)
    }
    if (this.activeJobIds.has(jobId)) {
      this.activeJobIds.delete(jobId)
      this.maybeIdle()
    }
    // cancelAll() passes pump:false so draining one job can't promote the next queued job into
    // 'decoding' before the loop has cancelled it too; it pumps once itself after everything is terminal.
    if (opts.pump !== false) await this.pump()
  }

  /** Permanently dismisses a terminal (failed/cancelled/done) job: drops it from memory and from the
   *  persistent checkpoint store. Non-terminal jobs refuse — dismissing an in-flight import would orphan
   *  its decoder/transcription work with nothing left to report back to. Unlike removeCheckpoint() (used
   *  by cancel/finishDecoding, where a swallowed error just leaves a harmless stale checkpoint behind
   *  since the job's outcome is already durable elsewhere), a failed store deletion here must propagate:
   *  the in-memory job stays put so the card remains and the user can retry dismissing it, rather than
   *  silently reappearing after the next restart. */
  async remove(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job && this.heldJobIds.includes(jobId)) {
      await this.deps.store.remove(jobId)
      this.heldJobIds = this.heldJobIds.filter((id) => id !== jobId)
      this.policyHeldJobIds = this.policyHeldJobIds.filter((id) => id !== jobId)
      return
    }
    if (!job) throw new Error('Import job not found.')
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
    if (!this.retentionAllowed()) {
      await this.holdForPolicy(job)
      return
    }
    const attempt = this.speakerAttempts.get(jobId)
    if (job.state === 'cancelled') throw new Error('Import was cancelled.')
    if (terminal(job.state)) throw new Error('Import is no longer accepting audio.')
    if (!this.attemptAccepts(attempt)) throw new Error('Import is not accepting audio for this attempt.')
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(totalChunks) || totalChunks < 0) {
      throw new Error('Invalid decoded audio chunk.')
    }
    // A window should never exceed one decode chunk plus a few seconds of slack for FFmpeg/decoder jitter.
    if (samples.length > 16_000 * (IMPORT_CHUNK_SECONDS + 5)) throw new Error('Decoded audio chunk is too large.')
    // vad-v2: cursor counts WINDOWS (phase 2), not slabs — order is enforced against the count of
    // slabs already buffered instead. Legacy keeps the original cursor-based replay/order contract.
    const expectedSeq = job.pipeline === 'vad-v2' ? this.pcmOf(job.jobId).slabs.length : job.cursor
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

    // MQA-235 (vad-v2): phase 1 only BUFFERS — segmentation and ASR happen in finishDecoding, where the
    // whole recording is known. Past the memory cap the job degrades to the legacy slab pipeline: the
    // backlog is transcribed slab-by-slab right here, then this and every later slab take the legacy
    // branch below.
    let drainBufferedPcm = false
    let ownsRetainedPcm = false
    try {
      if (job.pipeline === 'vad-v2') {
        const buf = this.pcmOf(job.jobId)
        if (buf.samples + samples.length <= VAD_MAX_SAMPLES) {
          // Own copy: the decoder reuses its buffer across chunks.
          buf.slabs.push(samples.slice())
          buf.samples += samples.length
          return
        }
        // Claim the retention marker before changing the durable pipeline or awaiting persistence. The
        // backlog is still reachable through pcmByJob during that await, and optional local work must
        // remain deferred until drainLegacyBacklog() releases it.
        this.retainedPcmConsumerIds.add(job.jobId)
        ownsRetainedPcm = true
        job.pipeline = undefined
        job.chunkSec = IMPORT_CHUNK_SECONDS
        await this.persist(job)
        if (!this.attemptAccepts(attempt)) return
        drainBufferedPcm = true
      }

      // The legacy overflow path temporarily owns the entire buffered recording while draining it. Keep
      // admission closed until that helper's stack has unwound; recovered legacy jobs share the same guard
      // so cancellation cannot overlap even their bounded current slab with the next decoder.
      if (!ownsRetainedPcm) {
        this.retainedPcmConsumerIds.add(job.jobId)
        ownsRetainedPcm = true
      }
      if (drainBufferedPcm && !(await this.drainLegacyBacklog(job, attempt))) return
      if (terminal(job.state) || !this.attemptAccepts(attempt)) return
      job.state = 'transcribing'
      await this.persist(job)
      if (!this.attemptAccepts(attempt)) return
      if (!(await this.legacyTranscribeSlab(job, seq, samples, attempt))) return
      if (terminal(job.state) || !this.attemptAccepts(attempt)) return
      job.state = 'decoding'
      await this.persist(job)
    } catch (error) {
      if (terminal(job.state)) return
      await this.fail(job, message(error))
      throw error
    } finally {
      if (ownsRetainedPcm) this.retainedPcmConsumerIds.delete(job.jobId)
      if (terminal(job.state) || !this.attemptAccepts(attempt)) await this.releaseAdmissionSlot(job.jobId, attempt)
    }
  }

  /** Drain the whole-recording backlog in its own stack so it is unreachable before admission releases. */
  private async drainLegacyBacklog(job: ImportJob, attempt: SpeakerAttemptState | undefined): Promise<boolean> {
    const backlog = this.takePcm(job.jobId)
    let backlogSeq = 0
    for (const slab of backlog) {
      if (!(await this.legacyTranscribeSlab(job, backlogSeq++, slab, attempt))) return false
      if (terminal(job.state) || !this.attemptAccepts(attempt)) return false
    }
    return true
  }

  /** One legacy fixed-slab transcription step: ASR the slab, append the line, advance the slab cursor. */
  private async legacyTranscribeSlab(
    job: ImportJob,
    seq: number,
    samples: Float32Array,
    attempt: SpeakerAttemptState | undefined
  ): Promise<boolean> {
    if (seq < job.cursor) return true
    let text: string
    try {
      text = await this.transcribeWithRetry(
        samples,
        undefined,
        () => this.retentionAllowed() && this.attemptAccepts(attempt)
      )
    } catch (error) {
      if (error === ATTEMPT_STOPPED) return false
      throw error
    }
    if (terminal(job.state) || !this.retentionAllowed() || !this.attemptAccepts(attempt)) return false
    if (text.trim()) {
      job.lines.push({ speaker: 'unknown', text: text.trim(), t: job.sourceMtimeMs + seq * CHUNK_MS })
    }
    job.cursor = seq + 1
    // Slabs before seq are fixed-length; the last slab may be partial. Assignment (not accumulation)
    // makes retries idempotent and also covers the bounded-memory legacy overflow path.
    job.durationMs = seq * CHUNK_MS + Math.round((samples.length * 1000) / SAMPLE_RATE)
    await this.persist(job)
    if (await this.stopIfPolicyHeld(job)) return false
    return this.attemptAccepts(attempt)
  }

  private pcmOf(jobId: string): { slabs: Float32Array[]; samples: number } {
    let buf = this.pcmByJob.get(jobId)
    if (!buf) {
      buf = { slabs: [], samples: 0 }
      this.pcmByJob.set(jobId, buf)
    }
    return buf
  }

  /** Hand back and clear the buffered PCM for one vad-v2 job. */
  private takePcm(jobId: string): Float32Array[] {
    const buf = this.pcmByJob.get(jobId)
    this.pcmByJob.delete(jobId)
    if (!buf) return []
    const slabs = buf.slabs
    // A caller may still hold the small buffer metadata object. Detach the large slab array from it so
    // only the dedicated consumer stack owns the recording from this point onward.
    buf.slabs = []
    buf.samples = 0
    return slabs
  }

  /** The decoder process/window is gone. Admission stays held while this job still owns decoded PCM. */
  async releaseDecodeSlot(jobId: string, expectedAttempt?: SpeakerAttemptState, exactOwner = false): Promise<void> {
    const attempt = exactOwner ? expectedAttempt : this.speakerAttempts.get(jobId)
    if (exactOwner && this.speakerAttempts.get(jobId) !== attempt) return
    if (this.pcmByJob.has(jobId) || this.retainedPcmConsumerIds.has(jobId)) return
    await this.releaseAdmissionSlot(jobId, attempt, true)
  }

  /** Release only after no buffered or locally-consumed whole-recording PCM remains reachable. */
  private async releaseAdmissionSlot(
    jobId: string,
    attempt = this.speakerAttempts.get(jobId),
    retainForTail = false
  ): Promise<boolean> {
    if (!this.decodeSlotIds.has(jobId)) return this.attemptCanFinish(attempt)
    if (attempt && this.speakerAttempts.get(jobId) !== attempt) return false
    const retain = retainForTail && !!attempt?.tailAllowed
    this.disposeSpeakerAttempt(jobId, attempt, retain)
    this.decodeSlotIds.delete(jobId)
    await this.pump()
    this.maybeIdle()
    return retain && this.attemptCanFinish(attempt)
  }

  /** Called by the hidden decoder only after it has submitted every non-skipped chunk. */
  async finishDecoding(jobId: string, discoveredTotalChunks?: number): Promise<void> {
    const job = this.requireJob(jobId)
    if (!this.retentionAllowed()) {
      await this.holdForPolicy(job)
      return
    }
    const attempt = this.speakerAttempts.get(jobId)
    if (!this.attemptCanFinish(attempt)) return
    if (job.state === 'cancelled' || terminal(job.state)) {
      await this.releaseDecodeSlot(jobId)
      return
    }
    if (job.pipeline === 'vad-v2') {
      this.retainedPcmConsumerIds.add(job.jobId)
      let readyToFinalize = false
      try {
        readyToFinalize = await this.consumeVadPcm(job, attempt)
      } finally {
        // consumeVadPcm's stack (and its whole-recording PCM) has unwound before another decoder may
        // allocate. Cancellation/failure requests that arrived mid-ASR intentionally waited here.
        this.retainedPcmConsumerIds.delete(job.jobId)
        const retainForTail = readyToFinalize && this.attemptCanFinish(attempt)
        const mayFinalize = await this.releaseAdmissionSlot(job.jobId, attempt, retainForTail)
        readyToFinalize = readyToFinalize && mayFinalize
      }
      const mayFinalize = readyToFinalize && job.state === 'transcribing' && this.attemptCanFinish(attempt)
      if (mayFinalize) await this.finalize(job, attempt)
      this.retireAttempt(job.jobId, attempt)
      return
    }
    // Decoder already exited (FFmpeg onComplete / hidden-window close). Legacy jobs can admit the next
    // decoder now; recap never retains the decoded-audio slot.
    const mayFinish = await this.releaseAdmissionSlot(jobId, attempt, true)
    if (!mayFinish || job.state !== 'decoding') {
      this.retireAttempt(jobId, attempt)
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

    await this.finalize(job, attempt)
    this.retireAttempt(jobId, attempt)
  }

  /**
   * MQA-235: phase 2 of the vad-v2 pipeline. The whole recording is buffered; segment it with the SAME
   * VAD the live path runs (utterance windows instead of arbitrary 12s slabs), majority-vote the
   * recording's language across spread probe windows (window 0 is disproportionately a greeting in the
   * other language — the documented 2026-08-05 mis-pin translated a whole meeting), then transcribe
   * window-by-window with a durable cursor, diarizing each window off its own samples. Lines carry the
   * window's real offset into the recording. A final polish pass (fail-open) cleans stutters before save.
   */
  private consumeVadPcm(job: ImportJob, attempt: SpeakerAttemptState | undefined): Promise<boolean> {
    return consumeVadPcm(this.pipelineHost(), job, attempt)
  }

  private finalize(job: ImportJob, attempt?: SpeakerAttemptState): Promise<void> {
    return finalizeImportJob(this.pipelineHost(), job, attempt)
  }

  async failDecoder(jobId: string, error: unknown): Promise<void> {
    const job = this.requireJob(jobId)
    if (!this.retentionAllowed()) {
      await this.holdForPolicy(job)
      return
    }
    if (!this.attemptCanFinish(this.speakerAttempts.get(jobId))) return
    if (terminal(job.state)) return
    await this.fail(job, message(error))
  }

  private async transcribeWithRetry(
    samples: Float32Array,
    opts?: { language?: string | null },
    stillCurrent: () => boolean = () => true
  ): Promise<string> {
    let release!: () => void
    const prev = this.transcribeLock
    this.transcribeLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    if (!stillCurrent()) {
      release()
      throw ATTEMPT_STOPPED
    }
    try {
      let last: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await this.deps.transcribe(samples, opts)
          if (!stillCurrent()) throw ATTEMPT_STOPPED
          return text
        } catch (error) {
          if (error === ATTEMPT_STOPPED || !stillCurrent()) throw ATTEMPT_STOPPED
          last = error
        }
      }
      throw last instanceof Error ? last : new Error(message(last))
    } finally {
      release()
    }
  }

  private enqueue(jobId: string): void {
    if (!this.queue.includes(jobId) && !this.decodeSlotIds.has(jobId) && !this.activeJobIds.has(jobId)) {
      this.queue.push(jobId)
    }
  }

  private async pump(): Promise<void> {
    if (!this.retentionAllowed()) {
      await this.holdAllForPolicy()
      return
    }
    while (this.decodeSlotIds.size < this.maxConcurrent && this.queue.length) {
      const jobId = this.queue.shift()!
      const job = this.jobs.get(jobId)
      if (!job || terminal(job.state)) continue
      const memory = this.decodeMemoryAdmission()
      // A queued job may wait behind a long recording. Do not let a high-memory snapshot from enqueue
      // authorize whole-recording VAD after the OS has fallen below the bounded-path floor. A VAD
      // checkpoint with progress cannot safely be reinterpreted as legacy slabs because its cursor
      // counts VAD windows, so restart that unfinished import from its source on the bounded path.
      if (job.pipeline === 'vad-v2' && !hasVadV2MemoryHeadroom(memory.freeMemoryBytes)) {
        if (this.isFreshVadV2Admission(job)) this.downgradeToBoundedPipeline(job)
        else this.restartVadOnBoundedPipeline(job)
      }
      this.takePcm(jobId) // leftover buffers from a prior attempt at THIS job must not mix with a resume
      // A vad-v2 job that failed mid-transcription already had `totalChunks` overwritten to the WINDOW
      // count by consumeVadPcm (phase 2). A resume always re-decodes from scratch (phase 1), whose
      // real decoder (index.ts's ffmpeg onChunk) always reports totalChunks 0 per slab — left un-reset,
      // that stale window count would trip acceptDecodedChunk's "decoder changed the recording chunk
      // count" guard on the very first re-fed slab, permanently breaking resume for any job that failed
      // past segmentation. Legacy (non-vad-v2) jobs are untouched: their totalChunks IS the real slab
      // count and resuming from a non-zero cursor legitimately depends on it staying put.
      if (job.pipeline === 'vad-v2') job.totalChunks = 0
      this.decodeSlotIds.add(jobId)
      this.activeJobIds.add(jobId)
      const attempt = this.createAttempt(job)
      job.state = 'decoding'
      await this.persist(job)
      if (await this.stopIfPolicyHeld(job)) continue
      if (!this.attemptAccepts(attempt)) continue
      try {
        // A high-tier policy can release optional model memory before the decoder begins. Treat a
        // rejected policy step like any other pre-decode failure so the durable job gets an error and
        // its decoder slot is reclaimed instead of remaining indefinitely in "decoding".
        await this.deps.onDecodeAdmission?.(copy(job), memory)
      } catch (error) {
        if (this.isCurrentDecodeAttempt(job, attempt)) await this.fail(job, message(error))
        continue
      }
      if (await this.stopIfPolicyHeld(job)) continue
      if (!this.attemptAccepts(attempt)) continue
      this.admitSpeakers(job, attempt)
      try {
        await this.deps.decode(copy(job))
      } catch (error) {
        if (this.isCurrentDecodeAttempt(job, attempt)) await this.fail(job, message(error))
      }
      if (await this.stopIfPolicyHeld(job)) continue
      // A decoder runs asynchronously and calls finishDecoding/failDecoder later. Admission stays
      // occupied through retained-PCM consumption; recap does not keep the next file waiting.
    }
  }

  private async fail(job: ImportJob, error: string): Promise<void> {
    if (!this.retentionAllowed()) {
      await this.holdForPolicy(job)
      return
    }
    const attempt = this.speakerAttempts.get(job.jobId)
    this.stopSpeakerAttempt(job.jobId)
    job.state = 'failed'
    job.error = error || 'Import failed.'
    await this.persist(job)
    this.takePcm(job.jobId)
    await this.releaseDecodeSlot(job.jobId)
    if (!this.decodeSlotIds.has(job.jobId) && !this.retainedPcmConsumerIds.has(job.jobId)) {
      this.retireAttempt(job.jobId, attempt)
    }
    if (this.activeJobIds.has(job.jobId)) {
      this.activeJobIds.delete(job.jobId)
      await this.pump()
      this.maybeIdle()
    }
  }

  /** Whisper / Intelligence idle: no admitted recording and no leftover ASR/recap work. */
  private maybeIdle(): void {
    if (!this.decodeSlotIds.size && !this.activeJobIds.size) this.deps.onIdle?.()
  }

  private createAttempt(job: ImportJob): SpeakerAttemptState {
    const identity = Object.freeze({ jobId: job.jobId, attemptId: ++this.nextAttemptId })
    const attempt: SpeakerAttemptState = {
      identity,
      accepting: true,
      tailAllowed: true,
      speakerOwned: false,
      finalized: false,
      disposed: false
    }
    this.speakerAttempts.set(job.jobId, attempt)
    return attempt
  }

  private admitSpeakers(job: ImportJob, attempt: SpeakerAttemptState): void {
    if (job.pipeline === 'vad-v2' && job.cursor === 0 && this.deps.beginSpeakers) {
      try {
        attempt.speakerOwned = this.deps.beginSpeakers(attempt.identity) === true
      } catch {
        /* Speaker enrichment is additive; admission failure must not fail ASR. */
      }
    }
  }

  private attemptAccepts(attempt: SpeakerAttemptState | undefined): boolean {
    return !!attempt && attempt.accepting && this.speakerAttempts.get(attempt.identity.jobId) === attempt
  }

  private isCurrentDecodeAttempt(job: ImportJob, attempt: SpeakerAttemptState): boolean {
    return this.jobs.get(job.jobId) === job && job.state === 'decoding' && this.attemptAccepts(attempt)
  }

  private attemptCanFinish(attempt: SpeakerAttemptState | undefined): boolean {
    return !!attempt && attempt.tailAllowed && this.speakerAttempts.get(attempt.identity.jobId) === attempt
  }

  private stopSpeakerAttempt(jobId: string): void {
    const attempt = this.speakerAttempts.get(jobId)
    if (attempt) {
      attempt.accepting = false
      attempt.tailAllowed = false
    }
  }

  private disposeSpeakerAttempt(jobId: string, attempt: SpeakerAttemptState | undefined, retainForTail = false): void {
    if (!attempt || this.speakerAttempts.get(jobId) !== attempt) return
    if (!attempt.disposed) {
      attempt.accepting = false
      attempt.disposed = true
      if (attempt.speakerOwned) {
        try {
          this.deps.disposeSpeakers?.(attempt.identity)
        } catch {
          /* Cleanup is best-effort and must never wedge import admission. */
        }
      }
    }
    if (!retainForTail) this.retireAttempt(jobId, attempt)
  }

  private retireAttempt(jobId: string, attempt: SpeakerAttemptState | undefined): void {
    if (attempt && this.speakerAttempts.get(jobId) === attempt) this.speakerAttempts.delete(jobId)
  }

  private async persist(job: ImportJob, attempt?: SpeakerAttemptState): Promise<void> {
    await this.retention.persist(
      job,
      () => this.retentionAllowed(),
      () => this.holdForPolicy(job),
      copy,
      () =>
        this.jobs.get(job.jobId) === job && job.state !== 'policy-held' && (!attempt || this.attemptCanFinish(attempt)),
      () => this.assertJobWriteAllowed(job, attempt),
      this.deps.store,
      () => this.now(),
      this.deps.onChange
    )
  }

  private retentionAllowed(): boolean {
    return this.deps.canRetainTranscript?.() !== false
  }

  private assertRetentionAllowed(): void {
    if (!this.retentionAllowed()) throw new ImportRetentionBlockedError()
  }

  private assertJobWriteAllowed(job: ImportJob, attempt?: SpeakerAttemptState): void {
    this.assertRetentionAllowed()
    if (job.state === 'policy-held' || this.jobs.get(job.jobId) !== job) throw new StaleImportJobWriteError()
    if (attempt && !this.attemptCanFinish(attempt)) {
      throw new StaleImportJobWriteError()
    }
  }

  private async holdForPolicy(job: ImportJob): Promise<void> {
    await this.retention.hold(job, this.retentionHost(), this.deps.store)
  }

  /** An async continuation must not revive work after a policy hold, even if policy is later restored. */
  private async stopIfPolicyHeld(job: ImportJob, attempt?: SpeakerAttemptState): Promise<boolean> {
    if (job.state === 'policy-held' || (attempt && !this.attemptCanFinish(attempt))) return true
    if (this.retentionAllowed()) return false
    await this.holdForPolicy(job)
    return true
  }

  private async holdAllForPolicy(): Promise<void> {
    await this.retention.holdAll(this.jobs.values(), this.retentionHost(), this.deps.store)
  }

  private async releaseHold(job: ImportJob): Promise<void> {
    await this.retention.release(job, this.deps.store)
  }

  private retentionHost(): ImportRetentionHost {
    return {
      jobs: this.jobs,
      queue: this.queue,
      activeJobIds: this.activeJobIds,
      decodeSlotIds: this.decodeSlotIds,
      retainedPcmConsumerIds: this.retainedPcmConsumerIds,
      copy,
      captureAttempt: (jobId) => this.speakerAttempts.get(jobId),
      stopAttempt: (jobId, owner) => {
        if (this.speakerAttempts.get(jobId) === owner) this.stopSpeakerAttempt(jobId)
      },
      takePcm: (jobId) => {
        this.takePcm(jobId)
      },
      onCancel: (jobId) => this.deps.onCancel?.(jobId),
      releaseDecodeSlot: (jobId, owner) =>
        this.releaseDecodeSlot(jobId, owner as SpeakerAttemptState | undefined, true),
      retireAttempt: (jobId, owner) => this.retireAttempt(jobId, owner as SpeakerAttemptState | undefined),
      maybeIdle: () => this.maybeIdle()
    }
  }

  private resumeHost(): ImportResumeHost {
    return {
      jobs: this.jobs,
      queue: this.queue,
      decodeSlotIds: this.decodeSlotIds,
      activeJobIds: this.activeJobIds,
      copy,
      assertAllowed: () => this.assertRetentionAllowed(),
      validateSource: (job) => this.deps.validateSource?.(job),
      persist: (job) => this.persist(job),
      releaseHold: (job) => this.releaseHold(job),
      prepareCheckpoint: prepareImportCheckpoint,
      removeCheckpoint: (jobId) => this.removeCheckpoint(jobId),
      enqueue: (jobId) => this.enqueue(jobId),
      pump: () => this.pump(),
      requireJob: (jobId) => this.requireJob(jobId)
    }
  }

  private pipelineHost(): ImportJobPipelineHost {
    return {
      deps: this.deps,
      copy,
      takePcm: (jobId) => this.takePcm(jobId),
      fail: (job, error) => this.fail(job, error),
      persist: (job, attempt) => this.persist(job, attempt),
      attemptAccepts: (attempt) => this.attemptAccepts(attempt),
      isAttemptStopped: (error) => error === ATTEMPT_STOPPED,
      transcribeWithRetry: (samples, opts, stillCurrent) => this.transcribeWithRetry(samples, opts, stillCurrent),
      retentionAllowed: () => this.retentionAllowed(),
      assertRetentionAllowed: () => this.assertRetentionAllowed(),
      assertJobWriteAllowed: (job, attempt) => this.assertJobWriteAllowed(job, attempt),
      stopIfPolicyHeld: (job, attempt) => this.stopIfPolicyHeld(job, attempt),
      holdForPolicy: (job) => this.holdForPolicy(job),
      isCurrentJob: (job, attempt) => this.jobs.get(job.jobId) === job && (!attempt || this.attemptCanFinish(attempt)),
      abandonIfCancelled: (job, file) => this.abandonIfCancelled(job, file),
      removeCheckpoint: (jobId) => this.removeCheckpoint(jobId),
      releaseDecodeSlot: (jobId) => this.releaseDecodeSlot(jobId),
      activeJobIds: this.activeJobIds,
      pump: () => this.pump(),
      maybeIdle: () => this.maybeIdle()
    }
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

  /** Select once for a fresh job. Low/unknown memory uses the existing fixed-slab, bounded pipeline. */
  private selectFreshPipeline(): 'vad-v2' | undefined {
    try {
      const available = this.deps.freeMemoryBytes ? this.deps.freeMemoryBytes() : freemem()
      return hasVadV2MemoryHeadroom(available) ? 'vad-v2' : undefined
    } catch {
      return undefined
    }
  }

  /** Read the values once so VAD and Whisper-tier admission make one consistent decision for this attempt. */
  private decodeMemoryAdmission(): ImportDecodeMemoryAdmission {
    let freeMemoryBytes: unknown
    let totalMemoryBytes: unknown
    try {
      freeMemoryBytes = this.deps.freeMemoryBytes ? this.deps.freeMemoryBytes() : freemem()
    } catch {
      freeMemoryBytes = undefined
    }
    try {
      totalMemoryBytes = this.deps.totalMemoryBytes ? this.deps.totalMemoryBytes() : totalmem()
    } catch {
      totalMemoryBytes = undefined
    }
    return { totalMemoryBytes, freeMemoryBytes }
  }

  /** Only this empty pre-decode shape has no VAD-window checkpoint semantics to preserve. */
  private isFreshVadV2Admission(job: ImportJob): boolean {
    return (
      job.pipeline === 'vad-v2' &&
      job.cursor === 0 &&
      job.totalChunks === 0 &&
      job.lines.length === 0 &&
      job.progressPct === undefined &&
      job.durationMs === undefined &&
      job.file === undefined
    )
  }

  /** This runs only for a fresh job, before the decoder can retain its first PCM slab. */
  private downgradeToBoundedPipeline(job: ImportJob): void {
    job.pipeline = undefined
  }

  /** A VAD-window cursor cannot be applied to fixed decoder slabs. Restart safely on low memory. */
  private restartVadOnBoundedPipeline(job: ImportJob): void {
    job.pipeline = undefined
    job.cursor = 0
    job.totalChunks = 0
    job.lines = []
    job.progressPct = undefined
    job.durationMs = undefined
    job.chunkSec = IMPORT_CHUNK_SECONDS
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Import failed.')
}
