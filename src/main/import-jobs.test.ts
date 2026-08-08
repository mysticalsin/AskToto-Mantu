import { describe, expect, it, vi } from 'vitest'
import { IMPORT_CHUNK_SECONDS, type TranscriptLine } from '@shared/ipc'
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

function createManager(overrides: Partial<ConstructorParameters<typeof ImportJobManager>[0]> = {}) {
  const store = new MemoryStore()
  const decode = vi.fn()
  const transcribe = vi.fn(async () => 'recognized speech')
  const saveMeeting = vi.fn(async () => 'saved-import.md')
  const enqueueIngest = vi.fn()
  const generateRecap = vi.fn(async () => undefined)
  const updateRecap = vi.fn(async () => {})
  const manager = new ImportJobManager({
    store,
    decode,
    transcribe,
    saveMeeting,
    enqueueIngest,
    generateRecap,
    updateRecap,
    now: () => 1_700_000_000_000,
    newId: () => 'job-1',
    ...overrides
  })
  return { manager, store, decode, transcribe, saveMeeting, enqueueIngest, generateRecap, updateRecap }
}

const source = {
  path: '/safe/interview.mp3',
  name: 'interview.mp3',
  sizeBytes: 42,
  mtimeMs: 1_700_000_000_000
}

describe('ImportJobManager', () => {
  it('pins the persona active at start() into the job so a mid-queue persona switch cannot reshape the recap', async () => {
    let liveMode = 'sales'
    const { manager, store } = createManager({ personaMode: () => liveMode })

    const job = await manager.start(source)
    expect(job.mode).toBe('sales')

    liveMode = 'general' // user switches persona while the import sits in the queue
    expect(manager.get('job-1')?.mode).toBe('sales')
    expect(store.jobs.get('job-1')?.mode).toBe('sales') // survives a restart via the checkpoint
  })

  it('leaves the persona pin absent when no personaMode dep is wired (older-build checkpoints fall back to live mode)', async () => {
    const { manager } = createManager()
    const job = await manager.start(source)
    expect(job.mode).toBeUndefined()
  })

  it('starts one main-owned decode job and checkpoints each recognized chunk as an unlabeled speaker', async () => {
    const { manager, store, decode, transcribe } = createManager()

    const job = await manager.start(source)
    expect(job.state).toBe('decoding')
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', sourcePath: source.path }))

    await manager.acceptDecodedChunk('job-1', 0, 2, new Float32Array([1]))
    await manager.acceptDecodedChunk('job-1', 1, 2, new Float32Array([2]))

    expect(transcribe).toHaveBeenCalledTimes(2)
    const checkpoint = store.jobs.get('job-1')!
    expect(checkpoint.cursor).toBe(2)
    expect(checkpoint.lines).toEqual<TranscriptLine[]>([
      { speaker: 'unknown', text: 'recognized speech', t: source.mtimeMs },
      { speaker: 'unknown', text: 'recognized speech', t: source.mtimeMs + IMPORT_CHUNK_SECONDS * 1_000 }
    ])
  })

  it('stamps the current decode chunk size into a freshly started job', async () => {
    const { manager } = createManager()
    const job = await manager.start(source)
    expect(job.chunkSec).toBe(IMPORT_CHUNK_SECONDS)
  })

  it('persists decoder progress and reserves 100% for the completed summary handoff', async () => {
    const { manager, store } = createManager()
    await manager.start(source)

    await manager.reportProgress('job-1', 97.6)
    expect(manager.get('job-1')?.progressPct).toBe(98)
    expect(store.jobs.get('job-1')?.progressPct).toBe(98)

    await manager.reportProgress('job-1', 100)
    expect(manager.get('job-1')?.progressPct).toBe(99)
    expect(store.jobs.get('job-1')?.progressPct).toBe(99)
  })

  it('retries one failed transcription before checkpointing the chunk', async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('temporary ASR error')).mockResolvedValueOnce('recovered')
    const { manager } = createManager({ transcribe })
    await manager.start(source)

    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))

    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(manager.get('job-1')?.cursor).toBe(1)
    expect(manager.get('job-1')?.state).toBe('decoding')
  })

  it('supports a streaming decoder that learns the total chunk count only at EOF', async () => {
    const { manager, saveMeeting } = createManager()
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, new Float32Array([1]))
    await manager.acceptDecodedChunk('job-1', 1, 0, new Float32Array([2]))
    await manager.finishDecoding('job-1', 2)

    expect(saveMeeting).toHaveBeenCalledTimes(1)
    expect(manager.get('job-1')).toMatchObject({ state: 'done', cursor: 2, totalChunks: 2 })
  })

  it('keeps a failed job resumable without discarding already checkpointed transcript lines', async () => {
    const transcribe = vi.fn().mockResolvedValueOnce('first').mockRejectedValue(new Error('ASR unavailable'))
    const { manager } = createManager({ transcribe })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 2, new Float32Array([1]))

    await expect(manager.acceptDecodedChunk('job-1', 1, 2, new Float32Array([2]))).rejects.toThrow('ASR unavailable')

    const failed = manager.get('job-1')!
    expect(failed.state).toBe('failed')
    expect(failed.cursor).toBe(1)
    expect(failed.lines.map((line) => line.text)).toEqual(['first'])
  })

  it('saves, ingests, recaps, and completes only after the decoder has delivered every chunk', async () => {
    const updateRecap = vi.fn(async () => undefined)
    const generateRecap = vi.fn(async () => '## Overview\n\nImported summary')
    const { manager, saveMeeting, enqueueIngest } = createManager({ generateRecap, updateRecap })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))

    await manager.finishDecoding('job-1')

    expect(saveMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Interview', recap: '', lines: [expect.objectContaining({ speaker: 'unknown' })] })
    )
    // Ingest only after the recap has been saved, so Mantu Intelligence sees the completed note rather
    // than racing an empty-recap version of the same import.
    expect(enqueueIngest).toHaveBeenCalledTimes(1)
    expect(enqueueIngest).toHaveBeenCalledWith('saved-import.md')
    expect(generateRecap).toHaveBeenCalledWith(expect.objectContaining({ file: 'saved-import.md' }))
    expect(updateRecap).toHaveBeenCalledWith('saved-import.md', '## Overview\n\nImported summary')
    expect(manager.get('job-1')?.state).toBe('done')
  })

  it('holds at 99% while the automatic summary is running and reaches 100% only after it is saved', async () => {
    let resolveRecap!: (text: string) => void
    const generateRecap = vi.fn(() => new Promise<string>((resolve) => { resolveRecap = resolve }))
    const { manager } = createManager({ generateRecap })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))

    const finishing = manager.finishDecoding('job-1')
    for (let i = 0; i < 10 && !resolveRecap; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.get('job-1')).toMatchObject({ state: 'recapping', progressPct: 99 })

    resolveRecap('## Overview\n\nImported summary')
    await finishing
    expect(manager.get('job-1')).toMatchObject({ state: 'done', progressPct: 100 })
  })

  it('marks a recap failure visibly while preserving the saved transcript as done', async () => {
    const { manager } = createManager({ generateRecap: vi.fn(async () => { throw new Error('provider unavailable') }) })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
    await manager.finishDecoding('job-1')

    expect(manager.get('job-1')).toMatchObject({ state: 'done', file: 'saved-import.md', recapError: 'provider unavailable' })
  })

  it('keeps a completed import visible when no summary provider is configured', async () => {
    const { manager } = createManager({ generateRecap: vi.fn(async () => undefined) })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
    await manager.finishDecoding('job-1')

    expect(manager.get('job-1')).toMatchObject({
      state: 'done',
      file: 'saved-import.md',
      recapError: expect.stringMatching(/no ai provider/i)
    })
  })

  it('does not resurrect a cancelled job when transcription finishes late', async () => {
    let resolveTranscribe!: (text: string) => void
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { resolveTranscribe = resolve }))
    const { manager } = createManager({ transcribe })
    await manager.start(source)
    const accepted = manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
    await Promise.resolve()
    await manager.cancel('job-1')
    resolveTranscribe('late speech')
    await accepted

    expect(manager.get('job-1')).toMatchObject({ state: 'cancelled', cursor: 0, lines: [] })
  })

  it('does not mark a cancelled job done when recap finishes late', async () => {
    let resolveRecap!: (text: string) => void
    const generateRecap = vi.fn(() => new Promise<string>((resolve) => { resolveRecap = resolve }))
    const { manager, enqueueIngest } = createManager({ generateRecap })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
    const finishing = manager.finishDecoding('job-1')
    for (let i = 0; i < 5 && !resolveRecap; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    await manager.cancel('job-1')
    resolveRecap('late recap')
    await finishing

    expect(manager.get('job-1')?.state).toBe('cancelled')
    expect(enqueueIngest).not.toHaveBeenCalled()
  })

  // MQA-024 (docs/qa/BUG-LEDGER.md): cancel() deletes the checkpoint and the renderer hides cancelled
  // cards, so every bail-out after saveMeeting() has landed must also delete the meeting file — otherwise
  // the recording the user explicitly discarded stays in History (and syncs) with nothing left to
  // reconcile it. The recap phase is a multi-minute, cancel-inviting window, not a narrow race.
  describe('a cancelled import never leaves an orphaned meeting behind (MQA-024)', () => {
    it('deletes the saved meeting when cancelled while the summary is being generated', async () => {
      let resolveRecap!: (text: string) => void
      const generateRecap = vi.fn(() => new Promise<string>((resolve) => { resolveRecap = resolve }))
      const deleteMeeting = vi.fn(async () => {})
      const { manager, enqueueIngest } = createManager({ generateRecap, deleteMeeting })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
      const finishing = manager.finishDecoding('job-1')
      for (let i = 0; i < 5 && !resolveRecap; i++) await new Promise((resolve) => setTimeout(resolve, 0))

      await manager.cancel('job-1')
      resolveRecap('late recap')
      await finishing

      expect(deleteMeeting).toHaveBeenCalledWith('saved-import.md')
      expect(manager.get('job-1')?.state).toBe('cancelled')
      expect(manager.get('job-1')?.file).toBeUndefined()
      expect(enqueueIngest).not.toHaveBeenCalled()
    })

    it('deletes the saved meeting when cancelled while the summary is being written back', async () => {
      let resolveUpdate!: () => void
      const generateRecap = vi.fn(async () => '## Overview\n\nImported summary')
      const updateRecap = vi.fn(() => new Promise<void>((resolve) => { resolveUpdate = resolve }))
      const deleteMeeting = vi.fn(async () => {})
      const { manager, enqueueIngest } = createManager({ generateRecap, updateRecap, deleteMeeting })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
      const finishing = manager.finishDecoding('job-1')
      for (let i = 0; i < 5 && !resolveUpdate; i++) await new Promise((resolve) => setTimeout(resolve, 0))

      await manager.cancel('job-1')
      resolveUpdate()
      await finishing

      expect(deleteMeeting).toHaveBeenCalledWith('saved-import.md')
      expect(enqueueIngest).not.toHaveBeenCalled()
    })

    it('deletes the saved meeting when cancelled while a failing summary is in flight', async () => {
      let rejectRecap!: (error: Error) => void
      const generateRecap = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectRecap = reject }))
      const deleteMeeting = vi.fn(async () => {})
      const { manager, enqueueIngest } = createManager({ generateRecap, deleteMeeting })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))
      const finishing = manager.finishDecoding('job-1')
      for (let i = 0; i < 5 && !rejectRecap; i++) await new Promise((resolve) => setTimeout(resolve, 0))

      await manager.cancel('job-1')
      // A recap failure routes past the generateRecap checkpoint into the pre-ingest one, which was the
      // last bail-out still returning without cleaning up.
      rejectRecap(new Error('provider unavailable'))
      await finishing

      expect(deleteMeeting).toHaveBeenCalledWith('saved-import.md')
      expect(enqueueIngest).not.toHaveBeenCalled()
    })
  })

  it('does not decode or duplicate a meeting after a crash during recap', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'recapping', cursor: 1, totalChunks: 1,
      lines: [{ speaker: 'unknown', text: 'saved transcript', t: source.mtimeMs }], file: 'already-saved.md',
      createdAt: 1, updatedAt: 1
    })
    const second = createManager()
    // Share the persisted checkpoint with the recovering manager.
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()

    expect(second.decode).not.toHaveBeenCalled()
    expect(second.manager.get('job-1')).toMatchObject({ state: 'done', file: 'already-saved.md' })
  })

  // MQA-025 (docs/qa/BUG-LEDGER.md): the same invariant recover() enforces has to hold for the Resume
  // button. saveMeeting() never overwrites — it picks a fresh non-colliding name — so replaying the
  // decoder for a failure that already wrote its file yields a second meeting file, a second index.md row
  // and a second brain ingest of one conversation.
  it('resumes a failure that already saved its meeting without decoding or saving it twice (MQA-025)', async () => {
    const first = createManager()
    // A tail failure inside finishDecoding — the checkpoint write losing to an AV/OneDrive file lock —
    // after the meeting file had already landed. This is exactly the card that offers Resume.
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'failed', cursor: 1, totalChunks: 1,
      chunkSec: IMPORT_CHUNK_SECONDS, error: 'EPERM: operation not permitted',
      lines: [{ speaker: 'unknown', text: 'saved transcript', t: source.mtimeMs }], file: 'already-saved.md',
      createdAt: 1, updatedAt: 1
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)
    await second.manager.recover()

    const resumed = await second.manager.resume('job-1')

    expect(second.decode).not.toHaveBeenCalled()
    expect(second.saveMeeting).not.toHaveBeenCalled()
    expect(second.enqueueIngest).not.toHaveBeenCalled()
    expect(resumed).toMatchObject({
      state: 'done', file: 'already-saved.md', recapError: expect.stringMatching(/interrupted/i)
    })
    expect(resumed.error).toBeUndefined()
    expect((second.store as MemoryStore).jobs.has('job-1')).toBe(false)
  })

  it('still replays the decoder when a failed import never got as far as saving its meeting (MQA-025)', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('ASR unavailable'))
    const { manager, decode } = createManager({ transcribe })
    await manager.start(source)
    await expect(manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))).rejects.toThrow(
      'ASR unavailable'
    )

    await manager.resume('job-1')

    expect(decode).toHaveBeenCalledTimes(2)
    expect(manager.get('job-1')?.state).toBe('decoding')
  })

  it('restarts a queued job from scratch on recover() when its checkpoint predates the current chunk size', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'decoding', cursor: 3, totalChunks: 7,
      progressPct: 42, chunkSec: IMPORT_CHUNK_SECONDS + 1,
      lines: [{ speaker: 'unknown', text: 'stale window', t: source.mtimeMs }],
      createdAt: 1, updatedAt: 1
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()

    // A mismatched chunkSec means `cursor` no longer lines up with the current decoder's chunk
    // boundaries — resuming from it would splice differently-sized windows into one transcript, so
    // recover() restarts the job from scratch (re-transcribing is correct; resuming is not) rather than
    // replaying stale progress.
    expect(second.decode).toHaveBeenCalledTimes(1)
    expect(second.manager.get('job-1')).toMatchObject({
      state: 'decoding', cursor: 0, totalChunks: 0, lines: [], chunkSec: IMPORT_CHUNK_SECONDS
    })
    expect(second.manager.get('job-1')?.progressPct).toBeUndefined()
  })

  it('restarts a queued job on recover() when its checkpoint predates the chunkSec field entirely', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'decoding', cursor: 3, totalChunks: 7,
      lines: [{ speaker: 'unknown', text: 'stale window', t: source.mtimeMs }],
      createdAt: 1, updatedAt: 1
      // chunkSec omitted entirely — an older build's checkpoint, from before this field existed.
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()

    expect(second.manager.get('job-1')).toMatchObject({ cursor: 0, totalChunks: 0, lines: [], chunkSec: IMPORT_CHUNK_SECONDS })
  })

  it('resumes a queued job on recover() when its checkpoint already matches the current chunk size', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'decoding', cursor: 3, totalChunks: 7,
      progressPct: 42, chunkSec: IMPORT_CHUNK_SECONDS,
      lines: [{ speaker: 'unknown', text: 'kept window', t: source.mtimeMs }],
      createdAt: 1, updatedAt: 1
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()

    expect(second.decode).toHaveBeenCalledTimes(1)
    expect(second.manager.get('job-1')).toMatchObject({
      state: 'decoding', cursor: 3, totalChunks: 7, progressPct: 42, chunkSec: IMPORT_CHUNK_SECONDS,
      lines: [{ speaker: 'unknown', text: 'kept window', t: source.mtimeMs }]
    })
  })

  it('dismisses a failed job from both the manager and the persistent store', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('ASR unavailable'))
    const { manager, store } = createManager({ transcribe })
    await manager.start(source)
    await expect(manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))).rejects.toThrow(
      'ASR unavailable'
    )
    expect(manager.get('job-1')?.state).toBe('failed')

    await manager.remove('job-1')

    expect(manager.get('job-1')).toBeUndefined()
    expect(store.jobs.has('job-1')).toBe(false)
  })

  it('refuses to remove a job that is still decoding or queued', async () => {
    const { manager } = createManager()
    await manager.start(source)
    expect(manager.get('job-1')?.state).toBe('decoding')

    await expect(manager.remove('job-1')).rejects.toThrow(
      'Only a finished, failed, or cancelled import can be dismissed.'
    )
    expect(manager.get('job-1')).toBeDefined()
  })

  it('omits a removed job from list()', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('ASR unavailable'))
    const { manager } = createManager({ transcribe })
    await manager.start(source)
    await expect(manager.acceptDecodedChunk('job-1', 0, 1, new Float32Array([1]))).rejects.toThrow(
      'ASR unavailable'
    )

    await manager.remove('job-1')

    expect(manager.list()).toEqual([])
  })
})
