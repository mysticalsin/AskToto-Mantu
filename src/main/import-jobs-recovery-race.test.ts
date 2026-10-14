import { describe, expect, it, vi } from 'vitest'
import { VAD_V2_MIN_FREE_MEMORY_BYTES } from '@shared/asr-hardware-preference'
import { ImportJobManager, type ImportJob, type ImportJobStore } from './import-jobs'

class MemoryStore implements ImportJobStore {
  readonly jobs = new Map<string, ImportJob>()

  async save(job: ImportJob): Promise<void> {
    this.jobs.set(job.jobId, structuredClone(job))
  }

  async list(): Promise<ImportJob[]> {
    return [...this.jobs.values()].map((job) => structuredClone(job))
  }

  async remove(jobId: string): Promise<void> {
    this.jobs.delete(jobId)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const SAMPLE_RATE = 16_000

function oneWindowPcm(): Float32Array {
  const burst = new Float32Array(Math.round(0.6 * SAMPLE_RATE))
  for (let i = 0; i < burst.length; i++) burst[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)
  return new Float32Array([...burst, ...new Float32Array(SAMPLE_RATE)])
}

describe('ImportJobManager recovery race', () => {
  it('keeps the completed job visible when recovery returns a stale snapshot during ASR', async () => {
    const store = new MemoryStore()
    const asrStarted = deferred<void>()
    const releaseAsr = deferred<string>()
    const recoveryListStarted = deferred<void>()
    const releaseRecoveryList = deferred<void>()
    const transcribe = vi.fn(async () => {
      asrStarted.resolve()
      return releaseAsr.promise
    })
    const saveMeeting = vi.fn(async () => 'saved-import.md')
    const manager = new ImportJobManager({
      store,
      decode: vi.fn(),
      transcribe,
      saveMeeting,
      enqueueIngest: vi.fn(),
      generateRecap: vi.fn(async () => undefined),
      updateRecap: vi.fn(async () => {}),
      freeMemoryBytes: () => 2 * VAD_V2_MIN_FREE_MEMORY_BYTES,
      now: () => 1_700_000_000_000,
      newId: () => 'job-1'
    })
    const source = {
      path: '/synthetic/recovery-race.wav',
      name: 'recovery-race.wav',
      sizeBytes: 42,
      mtimeMs: 1_700_000_000_000
    }

    await manager.start(source)
    const pcm = oneWindowPcm()
    await manager.acceptDecodedChunk('job-1', 0, 0, pcm)
    const finishing = manager.finishDecoding('job-1')
    await asrStarted.promise

    // Recovery sees a cloned checkpoint before ASR has completed, then pauses before returning it.
    const recoveringCheckpoint = [...store.jobs.values()].map((job) => structuredClone(job))
    expect(recoveringCheckpoint).toMatchObject([{ jobId: 'job-1', state: 'transcribing', file: undefined }])
    store.list = async () => {
      recoveryListStarted.resolve()
      await releaseRecoveryList.promise
      return recoveringCheckpoint
    }
    const recovering = manager.recover()
    await recoveryListStarted.promise
    releaseRecoveryList.resolve()
    await recovering

    releaseAsr.resolve('recognized speech')
    await finishing

    expect(saveMeeting).toHaveBeenCalledTimes(1)
    expect(saveMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: expect.arrayContaining([expect.objectContaining({ text: 'recognized speech' })])
      })
    )
    expect(manager.get('job-1')).toMatchObject({ state: 'done', file: 'saved-import.md' })
    expect(manager.list()).toEqual([expect.objectContaining({ state: 'done', file: 'saved-import.md' })])
    expect(store.jobs.has('job-1')).toBe(false)
    expect(transcribe).toHaveBeenCalledTimes(1)
  })
})
