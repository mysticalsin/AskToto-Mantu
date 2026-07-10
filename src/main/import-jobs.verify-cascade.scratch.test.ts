import { describe, expect, it } from 'vitest'
import { ImportJobManager, type ImportJob, type ImportJobStore } from './import-jobs'

/**
 * Scratch verification test (adversarial review): mirrors the index.ts hidden-window handler ordering.
 * The importDecoderComplete handler awaits finishDecoding() FIRST and closes the decoder window only
 * afterwards (finally), while startImportDecoder throws 'Another audio decoder is already active.'
 * whenever the previous decoder window is still alive.
 */

const store: ImportJobStore = {
  save: async () => {},
  list: async () => [],
  remove: async () => {}
}

function source(name: string) {
  return { path: `/tmp/${name}`, name, sizeBytes: 10, mtimeMs: 1 }
}

describe('scratch: queued import cascade', () => {
  it('hidden-window ordering: completing job A fails queued job B', async () => {
    let decoderAlive = false // mirrors decoderWin lifetime in index.ts
    const started: string[] = []
    const manager = new ImportJobManager({
      store,
      decode: (job: ImportJob) => {
        if (decoderAlive) throw new Error('Another audio decoder is already active.')
        decoderAlive = true
        started.push(job.jobId)
      },
      transcribe: async () => 'hello world',
      saveMeeting: async () => '/meetings/a.md',
      enqueueIngest: () => {},
      generateRecap: async () => 'recap',
      updateRecap: async () => {}
    })

    const jobA = await manager.start(source('a.m4a'))
    const jobB = await manager.start(source('b.m4a'))
    expect(started).toEqual([jobA.jobId]) // B queued behind A

    // Decoder for A submits its only chunk, then completes — exactly as the
    // importDecoderComplete IPC handler does: finishDecoding BEFORE closeImportDecoder.
    await manager.acceptDecodedChunk(jobA.jobId, 0, 1, new Float32Array(16000))
    await manager.finishDecoding(jobA.jobId, 1)
    decoderAlive = false // closeImportDecoder runs only now (finally block)

    expect(manager.get(jobA.jobId)?.state).toBe('done')
    const b = manager.get(jobB.jobId)
    expect(b?.state).toBe('failed')
    expect(b?.error).toBe('Another audio decoder is already active.')
    expect(started).toEqual([jobA.jobId]) // B never got a decoder
  })

  it('ffmpeg ordering: transcription failure on A cascade-fails queued B and C', async () => {
    const ffmpegDecoders = new Set<string>() // mirrors index.ts ffmpegDecoders map
    const started: string[] = []
    const manager = new ImportJobManager({
      store,
      decode: (job: ImportJob) => {
        if (ffmpegDecoders.size) throw new Error('Another audio decoder is already active.')
        ffmpegDecoders.add(job.jobId)
        started.push(job.jobId)
      },
      transcribe: async () => {
        throw new Error('ASR crashed')
      },
      saveMeeting: async () => '/meetings/a.md',
      enqueueIngest: () => {},
      generateRecap: async () => 'recap',
      updateRecap: async () => {}
    })

    const jobA = await manager.start(source('a.m4a'))
    const jobB = await manager.start(source('b.m4a'))
    const jobC = await manager.start(source('c.m4a'))

    // ffmpeg onChunk: acceptDecodedChunk rejects after retries; fail(A) pumps B while A's
    // decoder is still registered (index.ts deletes it only later, in onError).
    await expect(manager.acceptDecodedChunk(jobA.jobId, 0, 0, new Float32Array(16000))).rejects.toThrow('ASR crashed')
    ffmpegDecoders.delete(jobA.jobId) // onError cleanup happens only after the rejection propagated

    expect(manager.get(jobA.jobId)?.state).toBe('failed')
    expect(manager.get(jobB.jobId)?.state).toBe('failed')
    expect(manager.get(jobB.jobId)?.error).toBe('Another audio decoder is already active.')
    expect(manager.get(jobC.jobId)?.state).toBe('failed')
    expect(started).toEqual([jobA.jobId]) // B and C never decoded
  })
})
