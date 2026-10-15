import { estimateNoteTakingMinutes, wordsFromTexts } from '@shared/time-saved-events'
import { meetingDurationMinutes } from '@shared/meeting-duration'
import { vadWindowsFromPcm } from '@shared/vad'
import { IMPORT_CHUNK_SECONDS } from '@shared/ipc'
import { ImportRetentionBlockedError } from './import-retention-policy'
import { StaleImportJobWriteError } from './import-job-retention-coordinator'
import type { ImportJob, ImportJobManagerDeps, ImportSpeakerAttempt } from './import-job-types'

const SAMPLE_RATE = 16_000
const LANGUAGE_VOTE_PROBES = 5

export interface ImportJobPipelineAttempt {
  identity: ImportSpeakerAttempt
  accepting: boolean
  tailAllowed: boolean
  speakerOwned: boolean
  finalized: boolean
  disposed: boolean
}

export interface ImportJobPipelineHost {
  deps: ImportJobManagerDeps
  copy<T>(value: T): T
  takePcm(jobId: string): Float32Array[]
  fail(job: ImportJob, error: string): Promise<void>
  persist(job: ImportJob, attempt?: ImportJobPipelineAttempt): Promise<void>
  attemptAccepts(attempt?: ImportJobPipelineAttempt): boolean
  isAttemptStopped(error: unknown): boolean
  transcribeWithRetry(
    samples: Float32Array,
    opts?: { language?: string | null },
    stillCurrent?: () => boolean
  ): Promise<string>
  retentionAllowed(): boolean
  assertRetentionAllowed(): void
  assertJobWriteAllowed(job: ImportJob, attempt?: ImportJobPipelineAttempt): void
  stopIfPolicyHeld(job: ImportJob, attempt?: ImportJobPipelineAttempt): Promise<boolean>
  holdForPolicy(job: ImportJob): Promise<void>
  isCurrentJob(job: ImportJob, attempt?: ImportJobPipelineAttempt): boolean
  abandonIfCancelled(job: ImportJob, file: string): Promise<boolean>
  removeCheckpoint(jobId: string): Promise<void>
  releaseDecodeSlot(jobId: string): Promise<void>
  activeJobIds: Set<string>
  pump(): Promise<void>
  maybeIdle(): void
}

export interface ImportProgressHost {
  retentionAllowed(): boolean
  attemptAccepts(): boolean
  holdForPolicy(job: ImportJob): Promise<void>
  persist(job: ImportJob): Promise<void>
  isTerminal(state: ImportJob['state']): boolean
}

export async function reportImportProgress(host: ImportProgressHost, job: ImportJob, pct: number): Promise<void> {
  if (!host.retentionAllowed()) {
    await host.holdForPolicy(job)
    return
  }
  if (!host.attemptAccepts() || host.isTerminal(job.state)) return
  let normalized = Number.isFinite(pct) ? Math.max(0, Math.min(99, Math.round(pct))) : 0
  // Decode progress covers phase 1 only; VAD transcription owns the remaining progress range.
  if (job.pipeline === 'vad-v2' && job.state === 'decoding') normalized = Math.round(normalized * 0.15)
  const next = Math.max(job.progressPct ?? 0, normalized)
  if (job.progressPct !== undefined && next === job.progressPct) return
  job.progressPct = next
  await host.persist(job)
}

export function prepareImportCheckpoint(job: ImportJob): void {
  const oldVad = job.pipeline === 'vad-v1'
  const oldSlabs = !job.pipeline && job.chunkSec !== IMPORT_CHUNK_SECONDS
  if (!oldVad && !oldSlabs) return
  // MQA-309: pause-aware segmentation changes window indices, so never apply a vad-v1 cursor to v2.
  // Already-saved meetings are handled before this boundary and must not be imported twice.
  if (oldVad) job.pipeline = 'vad-v2'
  job.cursor = 0
  job.lines = []
  job.totalChunks = 0
  job.progressPct = undefined
  job.durationMs = undefined
  job.chunkSec = IMPORT_CHUNK_SECONDS
}

export function hasMemoryHeavyImportWork(
  jobs: ReadonlyMap<string, ImportJob>,
  decodeSlotIds: ReadonlySet<string>,
  retainedPcmConsumerIds: ReadonlySet<string>
): boolean {
  for (const jobId of decodeSlotIds) {
    if (jobs.get(jobId)?.pipeline === 'vad-v2' || retainedPcmConsumerIds.has(jobId)) return true
  }
  return false
}

export function assembleVadPcmAndRelease(slabs: Float32Array[]): Float32Array {
  try {
    const total = slabs.reduce((n, slab) => n + slab.length, 0)
    const pcm = new Float32Array(total)
    let offset = 0
    for (const slab of slabs) {
      pcm.set(slab, offset)
      offset += slab.length
    }
    return pcm
  } finally {
    slabs.length = 0
  }
}

export async function consumeVadPcm(
  host: ImportJobPipelineHost,
  job: ImportJob,
  attempt?: ImportJobPipelineAttempt
): Promise<boolean> {
  const pcm = assembleVadPcmAndRelease(host.takePcm(job.jobId))
  const windows = vadWindowsFromPcm(pcm, SAMPLE_RATE)
  job.durationMs = Math.round((pcm.length * 1000) / SAMPLE_RATE)
  if (windows.length === 0) {
    await host.fail(job, 'No speech was recognized in this recording.')
    return false
  }
  job.totalChunks = windows.length
  job.state = 'transcribing'
  await host.persist(job, attempt)
  if (!host.attemptAccepts(attempt)) return false

  let votedLanguage: string | null = null
  if (host.deps.probeLanguageName && windows.length > 0) {
    const picks = new Set<number>()
    if (windows.length <= 2 * LANGUAGE_VOTE_PROBES) {
      for (let i = 0; i < windows.length; i++) picks.add(i)
    } else {
      for (let i = 0; i < LANGUAGE_VOTE_PROBES; i++) {
        picks.add(Math.min(windows.length - 1, Math.floor(((i + 0.5) / LANGUAGE_VOTE_PROBES) * windows.length)))
      }
    }
    const tally = new Map<string, number>()
    for (const idx of picks) {
      if (terminal(job.state) || !host.attemptAccepts(attempt)) return false
      try {
        const w = windows[idx]
        const lang = await host.deps.probeLanguageName(pcm.subarray(w.start, w.end))
        if (!host.retentionAllowed() || !host.attemptAccepts(attempt)) return false
        if (lang) tally.set(lang, (tally.get(lang) ?? 0) + 1)
      } catch {
        if (!host.retentionAllowed() || !host.attemptAccepts(attempt)) return false
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
    if (best && bestCount >= 2) votedLanguage = best
  }

  for (let i = job.cursor; i < windows.length; i++) {
    if (terminal(job.state)) return false
    const w = windows[i]
    const samples = pcm.subarray(w.start, w.end)
    let text = ''
    try {
      text = await host.transcribeWithRetry(
        samples,
        { language: votedLanguage },
        () => host.retentionAllowed() && host.attemptAccepts(attempt)
      )
    } catch (error) {
      if (host.isAttemptStopped(error)) return false
      if (terminal(job.state)) return false
      await host.fail(job, message(error))
      return false
    }
    if (terminal(job.state) || !host.retentionAllowed() || !host.attemptAccepts(attempt)) return false
    if (text.trim()) {
      let name: string | undefined
      if (attempt?.speakerOwned && host.deps.speakerFor) {
        try {
          name = (await host.deps.speakerFor(samples, attempt.identity)) || undefined
        } catch {
          /* Speaker enrichment remains best effort. */
        }
      }
      if (terminal(job.state) || !host.retentionAllowed() || !host.attemptAccepts(attempt)) return false
      job.lines.push({
        speaker: 'unknown',
        ...(name ? { name } : {}),
        text: text.trim(),
        t: job.sourceMtimeMs + Math.round((w.start / SAMPLE_RATE) * 1000)
      })
    }
    job.cursor = i + 1
    job.progressPct = Math.max(job.progressPct ?? 0, 15 + Math.round((84 * (i + 1)) / windows.length))
    await host.persist(job, attempt)
    if (await host.stopIfPolicyHeld(job, attempt)) return false
    if (!host.attemptAccepts(attempt)) return false
  }

  if (job.lines.length === 0) {
    await host.fail(job, 'No speech was recognized in this recording.')
    return false
  }
  if (attempt?.speakerOwned && !attempt.finalized && host.deps.finalizeSpeakers) {
    try {
      attempt.finalized = true
      const mapping = host.deps.finalizeSpeakers(attempt.identity)
      if (mapping) {
        for (const line of job.lines) {
          if (line.name && mapping.has(line.name)) line.name = mapping.get(line.name)
        }
      }
    } catch {
      /* A fragmented label is preferable to failing the import. */
    }
  }
  return true
}

export async function finalizeImportJob(
  host: ImportJobPipelineHost,
  job: ImportJob,
  attempt?: ImportJobPipelineAttempt
): Promise<void> {
  try {
    job.progressPct = Math.max(job.progressPct ?? 0, 99)
    host.assertRetentionAllowed()
    const file = await host.deps.saveMeeting(
      {
        title: job.title,
        mode: 'meeting',
        startedAt: job.sourceMtimeMs,
        durationMs: job.durationMs,
        lines: [...job.lines].sort((a, b) => a.t - b.t),
        recap: ''
      },
      () => host.assertJobWriteAllowed(job, attempt)
    )
    if (await host.stopIfPolicyHeld(job, attempt)) return
    job.file = file
    job.state = 'saving'
    await host.persist(job, attempt)
    if (await host.stopIfPolicyHeld(job, attempt)) return
    if (await host.abandonIfCancelled(job, file)) return
    if (await host.stopIfPolicyHeld(job, attempt)) return
    job.state = 'recapping'
    await host.persist(job, attempt)
    if (await host.stopIfPolicyHeld(job, attempt)) return
    let recapPersisted = false
    try {
      host.assertRetentionAllowed()
      const recap = await host.deps.generateRecap(host.copy(job))
      if (await host.abandonIfCancelled(job, file)) return
      if (await host.stopIfPolicyHeld(job, attempt)) return
      if (recap?.trim()) {
        host.assertRetentionAllowed()
        await host.deps.updateRecap(file, recap, 'complete', () => host.assertJobWriteAllowed(job, attempt))
        if (await host.abandonIfCancelled(job, file)) return
        if (await host.stopIfPolicyHeld(job, attempt)) return
        recapPersisted = true
      } else job.recapError = 'No AI provider is configured to create the automatic summary.'
    } catch (error) {
      if (error instanceof StaleImportJobWriteError) return
      if (error instanceof ImportRetentionBlockedError) throw error
      job.recapError = message(error)
    }

    if (host.deps.polish) {
      try {
        if (await host.stopIfPolicyHeld(job, attempt)) return
        const polished = await host.deps.polish(host.copy(job.lines))
        if (await host.stopIfPolicyHeld(job, attempt)) return
        if (Array.isArray(polished) && polished.length === job.lines.length) job.lines = polished
      } catch {
        /* Keep the durable raw transcript if optional polish fails. */
      }
    }
    if (await host.abandonIfCancelled(job, file)) return
    if (await host.stopIfPolicyHeld(job, attempt)) return
    await host.deps.enqueueIngest(file, undefined, () => host.assertJobWriteAllowed(job, attempt))
    if (await host.abandonIfCancelled(job, file)) return
    if (await host.stopIfPolicyHeld(job, attempt)) return

    const duration = meetingDurationMinutes(job)
    if (recapPersisted) host.deps.recordMeetingSummarized?.(duration)
    const words = wordsFromTexts(...job.lines.map((line) => line.text))
    if (estimateNoteTakingMinutes(words) > 0) host.deps.recordTimeSavedNote?.(words, file)

    job.progressPct = 100
    job.state = 'done'
    await host.persist(job, attempt)
    if (await host.stopIfPolicyHeld(job, attempt)) return
    await host.removeCheckpoint(job.jobId)
  } catch (error) {
    if (error instanceof StaleImportJobWriteError) return
    if (job.state === 'policy-held' || error instanceof ImportRetentionBlockedError) {
      if (job.state !== 'policy-held') await host.holdForPolicy(job)
    } else if (job.state !== 'cancelled') await host.fail(job, message(error))
  } finally {
    if (host.isCurrentJob(job, attempt)) {
      await host.releaseDecodeSlot(job.jobId)
      if (host.activeJobIds.has(job.jobId)) {
        host.activeJobIds.delete(job.jobId)
        await host.pump()
        host.maybeIdle()
      }
    }
  }
}

function terminal(state: ImportJob['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'policy-held' || state === 'cancelled'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Import failed.')
}
