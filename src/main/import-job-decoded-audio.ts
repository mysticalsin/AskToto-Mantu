import { IMPORT_CHUNK_SECONDS } from '@shared/ipc'
import * as ImportRetention from './import-retention-policy'
import type { ImportJob } from './import-job-types'

const SAMPLE_RATE = 16_000
const CHUNK_MS = IMPORT_CHUNK_SECONDS * 1_000
const VAD_MAX_SAMPLES = SAMPLE_RATE * 60 * 90

export interface ImportPcmBuffer {
  slabs: Float32Array[]
  samples: number
}

export interface ImportDecodedAudioHost {
  jobs: Map<string, ImportJob>
  pcmByJob: Map<string, ImportPcmBuffer>
  retainedPcmConsumerIds: Set<string>
  getAttempt(jobId: string): object | undefined
  attemptAccepts(attempt?: object): boolean
  isTerminal(state: ImportJob['state']): boolean
  retentionAllowed(): boolean
  transcribeWithRetry(samples: Float32Array, opts: undefined, stillCurrent: () => boolean): Promise<string>
  isAttemptStopped(error: unknown): boolean
  fail(job: ImportJob, error: string): Promise<void>
  persist(job: ImportJob, attempt?: object): Promise<void>
  holdForPolicy(job: ImportJob, reason: 'policy'): Promise<void>
  stopIfPolicyHeld(job: ImportJob, attempt?: object): Promise<boolean>
  releaseAdmissionSlot(jobId: string, attempt?: object): Promise<unknown>
}

export function importPcmOf(pcmByJob: Map<string, ImportPcmBuffer>, jobId: string): ImportPcmBuffer {
  let buffer = pcmByJob.get(jobId)
  if (!buffer) {
    buffer = { slabs: [], samples: 0 }
    pcmByJob.set(jobId, buffer)
  }
  return buffer
}

/** Detach the owned audio array before releasing the per-job admission slot. */
export function takeImportPcm(pcmByJob: Map<string, ImportPcmBuffer>, jobId: string): Float32Array[] {
  const buffer = pcmByJob.get(jobId)
  pcmByJob.delete(jobId)
  if (!buffer) return []
  const slabs = buffer.slabs
  buffer.slabs = []
  buffer.samples = 0
  return slabs
}

export async function acceptImportDecodedChunk(
  host: ImportDecodedAudioHost,
  jobId: string,
  seq: number,
  totalChunks: number,
  samples: Float32Array
): Promise<void> {
  const job = host.jobs.get(jobId)
  if (!job) throw new Error(`Unknown import job: ${jobId}`)
  if (!host.retentionAllowed()) {
    await host.holdForPolicy(job, 'policy')
    return
  }
  const attempt = host.getAttempt(jobId)
  if (job.state === 'cancelled') throw new Error('Import was cancelled.')
  if (host.isTerminal(job.state)) throw new Error('Import is no longer accepting audio.')
  if (!host.attemptAccepts(attempt)) throw new Error('Import is not accepting audio for this attempt.')
  if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(totalChunks) || totalChunks < 0) {
    throw new Error('Invalid decoded audio chunk.')
  }
  if (samples.length > SAMPLE_RATE * (IMPORT_CHUNK_SECONDS + 5)) throw new Error('Decoded audio chunk is too large.')
  const expectedSeq = job.pipeline === 'vad-v2' ? importPcmOf(host.pcmByJob, job.jobId).slabs.length : job.cursor
  if (seq < expectedSeq) return
  if (seq !== expectedSeq) {
    await host.fail(job, `Decoded audio arrived out of order (expected chunk ${expectedSeq + 1}).`)
    throw new Error(job.error)
  }
  if (job.totalChunks && job.totalChunks !== totalChunks) {
    await host.fail(job, 'The decoder changed the recording chunk count while importing.')
    throw new Error(job.error)
  }
  if (totalChunks > 0) job.totalChunks = totalChunks

  let drainBufferedPcm = false
  let ownsRetainedPcm = false
  try {
    if (job.pipeline === 'vad-v2') {
      const buffer = importPcmOf(host.pcmByJob, job.jobId)
      if (buffer.samples + samples.length <= VAD_MAX_SAMPLES) {
        buffer.slabs.push(samples.slice())
        buffer.samples += samples.length
        return
      }
      host.retainedPcmConsumerIds.add(job.jobId)
      ownsRetainedPcm = true
      job.pipeline = undefined
      job.chunkSec = IMPORT_CHUNK_SECONDS
      await host.persist(job, attempt)
      if (!host.attemptAccepts(attempt)) return
      drainBufferedPcm = true
    }

    if (!ownsRetainedPcm) {
      host.retainedPcmConsumerIds.add(job.jobId)
      ownsRetainedPcm = true
    }
    if (drainBufferedPcm && !(await drainLegacyPcm(host, job, attempt))) return
    if (host.isTerminal(job.state) || !host.attemptAccepts(attempt)) return
    job.state = 'transcribing'
    await host.persist(job, attempt)
    if (!host.attemptAccepts(attempt)) return
    if (!(await transcribeLegacySlab(host, job, seq, samples, attempt))) return
    if (host.isTerminal(job.state) || !host.attemptAccepts(attempt)) return
    job.state = 'decoding'
    await host.persist(job, attempt)
  } catch (error) {
    if (host.isTerminal(job.state)) return
    if (ImportRetention.isImportRetentionRefusal(error)) {
      await host.holdForPolicy(job, 'policy')
    } else await host.fail(job, error instanceof Error ? error.message : String(error || 'Import failed.'))
    throw error
  } finally {
    if (ownsRetainedPcm) host.retainedPcmConsumerIds.delete(job.jobId)
    if (host.isTerminal(job.state) || !host.attemptAccepts(attempt)) {
      await host.releaseAdmissionSlot(job.jobId, attempt)
    }
  }
}

async function drainLegacyPcm(
  host: ImportDecodedAudioHost,
  job: ImportJob,
  attempt: object | undefined
): Promise<boolean> {
  const backlog = takeImportPcm(host.pcmByJob, job.jobId)
  let sequence = 0
  for (const slab of backlog) {
    if (!(await transcribeLegacySlab(host, job, sequence++, slab, attempt))) return false
    if (host.isTerminal(job.state) || !host.attemptAccepts(attempt)) return false
  }
  return true
}

async function transcribeLegacySlab(
  host: ImportDecodedAudioHost,
  job: ImportJob,
  seq: number,
  samples: Float32Array,
  attempt: object | undefined
): Promise<boolean> {
  if (seq < job.cursor) return true
  let text: string
  try {
    text = await host.transcribeWithRetry(
      samples,
      undefined,
      () => host.retentionAllowed() && host.attemptAccepts(attempt)
    )
  } catch (error) {
    if (host.isAttemptStopped(error)) return false
    throw error
  }
  if (host.isTerminal(job.state) || !host.retentionAllowed() || !host.attemptAccepts(attempt)) return false
  if (text.trim()) {
    job.lines.push({ speaker: 'unknown', text: text.trim(), t: job.sourceMtimeMs + seq * CHUNK_MS })
  }
  job.cursor = seq + 1
  job.durationMs = seq * CHUNK_MS + Math.round((samples.length * 1000) / SAMPLE_RATE)
  await host.persist(job, attempt)
  if (await host.stopIfPolicyHeld(job, attempt)) return false
  return host.attemptAccepts(attempt)
}
