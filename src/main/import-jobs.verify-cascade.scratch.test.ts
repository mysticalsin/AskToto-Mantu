import { describe, expect, it } from 'vitest'
import { ImportJobManager, type ImportJob, type ImportJobStore } from './import-jobs'

/**
 * Scratch verification test (adversarial review), ported to the vad-v1 pipeline (MQA-235): mirrors the
 * index.ts decoder lifecycle ordering. The ffmpeg onComplete handler releases the decoder slot BEFORE
 * finishDecoding (which now owns the whole ASR phase), while startImportDecoder throws
 * 'Another audio decoder is already active.' whenever a previous decoder is still alive.
 */

const store: ImportJobStore = {
  save: async () => {},
  list: async () => [],
  remove: async () => {}
}

function source(name: string) {
  return { path: `/tmp/${name}`, name, sizeBytes: 10, mtimeMs: 1 }
}

/** One 12s slab carrying a VAD-visible utterance (same fixture technique as import-jobs.test.ts). */
function speechSlab(): Float32Array {
  const rate = 16_000
  const slab = new Float32Array(rate * 12)
  // 2s of 220Hz "speech" with a syllabic amplitude wobble so isSpeechLikeWindow accepts it.
  for (let i = 0; i < rate * 2; i++) {
    const t = i / rate
    slab[rate + i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t))
  }
  return slab
}

describe('scratch: queued import cascade (vad-v1)', () => {
  it('hidden-window ordering: close the decoder then release the slot so B decodes', async () => {
    let decoderAlive = false // mirrors decoderWin lifetime in index.ts (browser-fallback decoder)
    const started: string[] = []
    const manager = new ImportJobManager({
      store,
      concurrency: 1,
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

    // Production importDecoderComplete closes the hidden window, then releaseDecodeSlot, then
    // finishDecoding (ASR + recap). Recap of A must not keep B at queued.
    await manager.acceptDecodedChunk(jobA.jobId, 0, 0, speechSlab())
    decoderAlive = false
    await manager.releaseDecodeSlot(jobA.jobId)
    const finishing = manager.finishDecoding(jobA.jobId)
    await finishing

    expect(manager.get(jobA.jobId)?.state).toBe('done')
    expect(manager.get(jobB.jobId)?.state).toBe('decoding')
    expect(started).toEqual([jobA.jobId, jobB.jobId])
  })

  it('ffmpeg ordering: a phase-2 ASR failure on A does NOT cascade — the slot is already free, B decodes', async () => {
    // Under the legacy pipeline ASR ran inside acceptDecodedChunk, so an ASR crash failed A while its
    // ffmpeg slot was still registered and queued B/C cascade-failed on 'already active'. Under vad-v1
    // the ffmpeg onComplete handler releases the slot BEFORE finishDecoding runs the ASR phase
    // (index.ts: "Release the process slot before finishDecoding pumps the next FIFO job") — so an ASR
    // failure on A now pumps B into a WORKING decoder. That is the improved contract this pins.
    const ffmpegDecoders = new Set<string>() // mirrors index.ts ffmpegDecoders map
    const started: string[] = []
    const manager = new ImportJobManager({
      store,
      concurrency: 1,
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

    await manager.acceptDecodedChunk(jobA.jobId, 0, 0, speechSlab())
    // ffmpeg onComplete: slot released FIRST, then finishDecoding runs phase 2 and the ASR crash lands.
    ffmpegDecoders.delete(jobA.jobId)
    await manager.finishDecoding(jobA.jobId)

    expect(manager.get(jobA.jobId)?.state).toBe('failed')
    expect(manager.get(jobA.jobId)?.error).toBe('ASR crashed')
    // B was pumped into a free slot and is decoding — no cascade.
    expect(manager.get(jobB.jobId)?.state).toBe('decoding')
    expect(started).toEqual([jobA.jobId, jobB.jobId])
  })
})
