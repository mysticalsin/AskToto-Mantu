import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IMPORT_CHUNK_SECONDS, type TranscriptLine } from '@shared/ipc'
import { vadWindowsFromPcm } from '@shared/vad'
import { ImportJobManager, decoderSlotIsStale, type ImportJob, type ImportJobStore } from './import-jobs'

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
  const transcribe = vi.fn(async (_pcm?: unknown, _opts?: unknown) => 'recognized speech')
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

// --- MQA-235 vad-v1 PCM fixtures ------------------------------------------------------------------------
// vadWindowsFromPcm (src/shared/vad.ts) needs REAL speech-shaped signal to emit a window at all — plain
// silence, and even a single loud sample, either never endpoint or get dropped by the steady-bed gate.
// Reusing the exact technique src/shared/vad.test.ts proves works: a sine burst (real signal, not silence)
// followed by enough trailing silence (> the 0.6s endpoint) to close the window, built with vad.test.ts's
// own sineBurst/silence/concat helpers. Window counts/offsets below are pinned by direct measurement
// against vadWindowsFromPcm itself (see the assertions that use it directly, e.g. the timestamp test) —
// nothing here is a guess.
const SR = 16_000

function sineBurst(sec: number, amp = 0.3, hz = 220): Float32Array {
  const n = Math.round(sec * SR)
  const buf = new Float32Array(n)
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
  return buf
}

function silencePcm(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SR))
}

function concatPcm(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** One VAD window: a single burst closed out by trailing silence. */
function oneWindowPcm(): Float32Array {
  return concatPcm(sineBurst(0.6), silencePcm(1.0))
}

/** Two non-overlapping VAD windows, back to back. */
function twoWindowPcm(): Float32Array {
  return concatPcm(sineBurst(0.6), silencePcm(1.0), sineBurst(0.6), silencePcm(1.0))
}

/** Two VAD windows preceded by 2s of leading silence, so the first window's real offset into the
 *  recording is unambiguously > 0 (proves import-jobs.ts threads the window's OWN start sample, not the
 *  slab/chunk index, into each line's timestamp). */
function leadingSilenceTwoWindowPcm(): Float32Array {
  return concatPcm(silencePcm(2.0), sineBurst(0.6), silencePcm(2.0), sineBurst(0.6), silencePcm(2.0))
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

  it('stamps the current decode chunk size and the vad-v1 pipeline marker into a freshly started job (MQA-235)', async () => {
    const { manager } = createManager()
    const job = await manager.start(source)
    expect(job.chunkSec).toBe(IMPORT_CHUNK_SECONDS)
    expect(job.pipeline).toBe('vad-v1')
  })

  // MQA-235: phase 1 (acceptDecodedChunk) only BUFFERS decoded slabs now — no ASR, no per-chunk state
  // change. Segmentation (vadWindowsFromPcm) and window-by-window transcription both happen inside
  // finishDecoding, once the whole recording is known.
  it('buffers decoded slabs without transcribing during phase 1, then transcribes one checkpointed line per VAD window at finishDecoding', async () => {
    const { manager, decode, transcribe } = createManager()

    const job = await manager.start(source)
    expect(job.state).toBe('decoding')
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', sourcePath: source.path }))

    await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())
    expect(transcribe).not.toHaveBeenCalled() // phase 1: buffered, not yet transcribed
    expect(manager.get('job-1')?.state).toBe('decoding')

    await manager.finishDecoding('job-1')

    expect(transcribe).toHaveBeenCalledTimes(2) // one call per VAD window
    // No probeLanguageName wired -> the language vote abstains -> every window decodes with `language: null`.
    for (const call of transcribe.mock.calls) expect(call[1]).toEqual({ language: null })

    // The checkpoint is gone from the store by now — finalize() removes it once the job reaches 'done'
    // (a terminal job is represented by its meeting file instead) — so assert against the in-memory job.
    const done = manager.get('job-1')!
    expect(done.cursor).toBe(2)
    expect(done.lines).toHaveLength(2)
    expect(done.lines.every((line) => line.speaker === 'unknown' && line.text === 'recognized speech')).toBe(true)
    expect(done.state).toBe('done') // finishVadPipeline runs the shared finalize() to completion
  })

  it("stamps each line's t from its window's real offset into the recording — monotonic, first offset > 0 given leading silence (MQA-235)", async () => {
    const { manager } = createManager()
    const pcm = leadingSilenceTwoWindowPcm()
    // Ground truth computed with the SAME shared segmenter import-jobs.ts calls — this is exact, not a
    // guess at magic sample offsets that would rot the moment vad.ts's padding/trim constants change.
    const expectedWindows = vadWindowsFromPcm(pcm, SR)
    expect(expectedWindows).toHaveLength(2)

    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, pcm)
    await manager.finishDecoding('job-1')

    const lines = manager.get('job-1')!.lines
    expect(lines).toHaveLength(2)
    expect(lines[0].t).toBe(source.mtimeMs + Math.round((expectedWindows[0].start / SR) * 1000))
    expect(lines[1].t).toBe(source.mtimeMs + Math.round((expectedWindows[1].start / SR) * 1000))
    expect(lines[0].t).toBeGreaterThan(source.mtimeMs) // leading silence -> real content starts after t=0
    expect(lines[1].t).toBeGreaterThan(lines[0].t) // monotonic
  })

  it('scales decoder progress into the vad-v1 decode-phase band (0-15%) while state is decoding, and never regresses', async () => {
    const { manager, store } = createManager()
    await manager.start(source)

    await manager.reportProgress('job-1', 100) // decoder over-reports; pre-scale clamps to 99 first
    expect(manager.get('job-1')?.progressPct).toBe(15) // round(99 * 0.15)
    expect(store.jobs.get('job-1')?.progressPct).toBe(15)

    await manager.reportProgress('job-1', 10) // a later, lower decoder tick must never regress the bar
    expect(manager.get('job-1')?.progressPct).toBe(15)
  })

  it('retries one failed transcription before checkpointing the window (vad-v1)', async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('temporary ASR error')).mockResolvedValueOnce('recovered')
    const { manager } = createManager({ transcribe })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())

    await manager.finishDecoding('job-1')

    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(manager.get('job-1')?.cursor).toBe(1)
    expect(manager.get('job-1')?.lines.map((line) => line.text)).toEqual(['recovered'])
  })

  // MQA-235: a freshly-started job is always vad-v1, so "the decoder learns totalChunks only at EOF" is no
  // longer reachable through start() — that's now legacy-only machinery, which survives ONLY for a
  // recovered pre-MQA-235 checkpoint (see import-jobs.ts's `pipeline` field doc-comment) or past the
  // >90min overflow degrade (covered separately below, structurally). This drives that surviving path.
  it('a recovered legacy (pre-vad-v1) checkpoint still supports a streaming decoder that learns total chunk count only at EOF', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'decoding', cursor: 0, totalChunks: 0,
      chunkSec: IMPORT_CHUNK_SECONDS, lines: [], createdAt: 1, updatedAt: 1
      // no `pipeline` field: an older-build (pre-MQA-235) in-flight checkpoint.
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()
    expect(second.manager.get('job-1')?.pipeline).toBeUndefined() // recover() never upgrades a legacy job onto vad-v1

    await second.manager.acceptDecodedChunk('job-1', 0, 0, new Float32Array([1]))
    await second.manager.acceptDecodedChunk('job-1', 1, 0, new Float32Array([2]))
    await second.manager.finishDecoding('job-1', 2)

    expect(second.saveMeeting).toHaveBeenCalledTimes(1)
    expect(second.manager.get('job-1')).toMatchObject({ state: 'done', cursor: 2, totalChunks: 2 })
  })

  it('keeps a failed job resumable without discarding already checkpointed transcript lines (vad-v1)', async () => {
    const transcribe = vi.fn().mockResolvedValueOnce('first').mockRejectedValue(new Error('ASR unavailable'))
    const { manager } = createManager({ transcribe })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

    // Unlike the legacy acceptDecodedChunk path, finishDecoding never throws on an internal failure — it
    // routes through fail() and returns normally so the decoder's own promise chain stays clean.
    await manager.finishDecoding('job-1')

    const failed = manager.get('job-1')!
    expect(failed.state).toBe('failed')
    expect(failed.cursor).toBe(1) // window 0 checkpointed; window 1 never advanced the cursor
    expect(failed.lines.map((line) => line.text)).toEqual(['first'])
  })

  it('resumes mid-transcription: a decoder re-feed replays every slab, but only the un-transcribed windows call transcribe again (vad-v1)', async () => {
    const transcribe = vi.fn().mockResolvedValueOnce('first').mockRejectedValue(new Error('ASR unavailable'))
    const { manager, decode } = createManager({ transcribe })
    const pcm = twoWindowPcm()
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, pcm)
    await manager.finishDecoding('job-1')

    expect(manager.get('job-1')).toMatchObject({ state: 'failed', cursor: 1 })
    expect(transcribe).toHaveBeenCalledTimes(3) // window 0 (1 call) + window 1 (2 retried attempts)

    transcribe.mockReset().mockResolvedValue('second')
    await manager.resume('job-1')
    expect(decode).toHaveBeenCalledTimes(2) // resume always triggers a full fresh decode, never a partial one

    // The decoder re-feeds every slab from scratch — buffered PCM was cleared on the earlier failure (see
    // import-jobs.ts's fail()/pump() takePcm() calls) — deterministic re-segmentation then reproduces the
    // SAME window boundaries, and the durable cursor (1) skips window 0.
    await manager.acceptDecodedChunk('job-1', 0, 0, pcm)
    await manager.finishDecoding('job-1')

    expect(transcribe).toHaveBeenCalledTimes(1) // only the un-transcribed remainder (window 1) hit ASR again
    const done = manager.get('job-1')!
    expect(done.state).toBe('done')
    expect(done.lines.map((line) => line.text)).toEqual(['first', 'second'])
  })

  // MQA-235: the whole-recording language vote. LANGUAGE_VOTE_PROBES=5 spreads its picks across the
  // recording, deduplicated to unique window indices — with 2 windows that's exactly windows {0, 1}, so
  // twoWindowPcm() drives both a clean majority and a tie with just two probe calls.
  describe('whole-recording language vote (MQA-235)', () => {
    it('a >=2-probe agreement hard-pins every transcribe call to the voted language', async () => {
      const probeLanguageName = vi.fn().mockResolvedValue('French')
      const { manager, transcribe } = createManager({ probeLanguageName })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

      await manager.finishDecoding('job-1')

      expect(probeLanguageName).toHaveBeenCalled()
      for (const call of transcribe.mock.calls) expect(call[1]).toEqual({ language: 'French' })
    })

    it('abstains (language stays null) when probes disagree — no majority, engines keep guessing per window', async () => {
      const probeLanguageName = vi.fn().mockResolvedValueOnce('French').mockResolvedValueOnce('German')
      const { manager, transcribe } = createManager({ probeLanguageName })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

      await manager.finishDecoding('job-1')

      for (const call of transcribe.mock.calls) expect(call[1]).toEqual({ language: null })
    })

    it('abstains when every probe returns null (a failed/unavailable prober)', async () => {
      const probeLanguageName = vi.fn().mockResolvedValue(null)
      const { manager, transcribe } = createManager({ probeLanguageName })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

      await manager.finishDecoding('job-1')

      for (const call of transcribe.mock.calls) expect(call[1]).toEqual({ language: null })
    })
  })

  describe('per-window diarization (deps.speakerFor, MQA-235)', () => {
    it("lands a diarization result on line.name while speaker stays 'unknown'", async () => {
      const speakerFor = vi.fn().mockResolvedValue('Alex')
      const { manager } = createManager({ speakerFor })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())

      await manager.finishDecoding('job-1')

      const lines = manager.get('job-1')?.lines ?? []
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ speaker: 'unknown', name: 'Alex' })
    })

    it('a throwing speakerFor is best-effort and never fails the import', async () => {
      const speakerFor = vi.fn().mockRejectedValue(new Error('extractor unavailable'))
      const { manager } = createManager({ speakerFor })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())

      await manager.finishDecoding('job-1')

      const job = manager.get('job-1')!
      expect(job.state).toBe('done')
      expect(job.lines).toHaveLength(1)
      expect(job.lines[0].speaker).toBe('unknown')
      expect(job.lines[0].name).toBeUndefined()
    })
  })

  describe('fail-open polish pass (deps.polish, MQA-235)', () => {
    it('applies a polish pass that replaces text of the same length', async () => {
      const polish = vi.fn(async (lines: TranscriptLine[]) => lines.map((line) => ({ ...line, text: line.text.toUpperCase() })))
      const { manager } = createManager({ polish })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

      await manager.finishDecoding('job-1')

      expect(manager.get('job-1')?.lines.map((line) => line.text)).toEqual(['RECOGNIZED SPEECH', 'RECOGNIZED SPEECH'])
    })

    it('keeps the raw lines when polish throws', async () => {
      const polish = vi.fn(async () => {
        throw new Error('polish crashed')
      })
      const { manager } = createManager({ polish })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

      await manager.finishDecoding('job-1')

      expect(manager.get('job-1')?.lines.map((line) => line.text)).toEqual(['recognized speech', 'recognized speech'])
    })

    it('keeps the raw lines when polish returns the wrong number of lines', async () => {
      const polish = vi.fn(async () => [{ speaker: 'unknown' as const, text: 'only one line back', t: 0 }])
      const { manager } = createManager({ polish })
      await manager.start(source)
      await manager.acceptDecodedChunk('job-1', 0, 0, twoWindowPcm())

      await manager.finishDecoding('job-1')

      expect(manager.get('job-1')?.lines.map((line) => line.text)).toEqual(['recognized speech', 'recognized speech'])
    })
  })

  it('fires onIdle once the FIFO queue drains', async () => {
    const onIdle = vi.fn()
    const { manager } = createManager({ onIdle })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    expect(onIdle).not.toHaveBeenCalled()

    await manager.finishDecoding('job-1')

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(manager.get('job-1')?.state).toBe('done')
  })

  // MQA-235: VAD_MAX_SAMPLES (90 minutes @ 16kHz) is a compile-time const, far too large to synthesize
  // real PCM for in a unit test. Pinned structurally instead: the exact degrade shape (pipeline dropped,
  // buffered backlog drained through the legacy per-slab transcriber) must remain present in the source.
  it('the >90min overflow degrade flips pipeline to legacy and drains the buffered backlog through legacyTranscribeSlab (structural pin)', () => {
    const src = readFileSync(join(__dirname, 'import-jobs.ts'), 'utf8')
    expect(src).toMatch(/job\.pipeline\s*=\s*undefined/)
    expect(src).toMatch(/const backlog = this\.takePcm\(job\.jobId\)/)
    expect(src).toMatch(/legacyTranscribeSlab\(job, backlogSeq\+\+, slab\)/)
  })

  it('persists decoder progress and reserves 100% for the completed summary handoff', async () => {
    const { manager } = createManager()
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1') // reaches 'done'; progressPct is set to 100 only after this,
    // and the durable checkpoint is removed at that point (a terminal job is represented by its meeting
    // file instead) — so the in-memory job is the only place left to read it from.

    expect(manager.get('job-1')?.progressPct).toBe(100)
  })

  it('saves, ingests, recaps, and completes only after the decoder has delivered every chunk', async () => {
    const updateRecap = vi.fn(async () => undefined)
    const generateRecap = vi.fn(async () => '## Overview\n\nImported summary')
    const { manager, saveMeeting, enqueueIngest } = createManager({ generateRecap, updateRecap })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())

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
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())

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
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1')

    expect(manager.get('job-1')).toMatchObject({ state: 'done', file: 'saved-import.md', recapError: 'provider unavailable' })
  })

  it('keeps a completed import visible when no summary provider is configured', async () => {
    const { manager } = createManager({ generateRecap: vi.fn(async () => undefined) })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1')

    expect(manager.get('job-1')).toMatchObject({
      state: 'done',
      file: 'saved-import.md',
      recapError: expect.stringMatching(/no ai provider/i)
    })
  })

  it('does not resurrect a cancelled job when transcription finishes late (vad-v1)', async () => {
    let resolveTranscribe!: (text: string) => void
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { resolveTranscribe = resolve }))
    const { manager } = createManager({ transcribe })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())

    const finishing = manager.finishDecoding('job-1')
    // Let finishVadPipeline segment the recording and reach the in-flight transcribe call for window 0.
    for (let i = 0; i < 10 && !resolveTranscribe; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    await manager.cancel('job-1')
    resolveTranscribe('late speech')
    await finishing

    expect(manager.get('job-1')).toMatchObject({ state: 'cancelled', cursor: 0, lines: [] })
  })

  it('does not mark a cancelled job done when recap finishes late', async () => {
    let resolveRecap!: (text: string) => void
    const generateRecap = vi.fn(() => new Promise<string>((resolve) => { resolveRecap = resolve }))
    const { manager, enqueueIngest } = createManager({ generateRecap })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
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
      await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
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
      await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
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
      await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
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
      pipeline: 'vad-v1',
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
      chunkSec: IMPORT_CHUNK_SECONDS, pipeline: 'vad-v1', error: 'EPERM: operation not permitted',
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

  // MQA-104 (docs/qa/BUG-LEDGER.md): enqueueIngest does real index.json I/O, a genuine yield point, so a
  // cancel racing it must not fall through to the 'done' finalization — that would resurrect the
  // cancelled job and strand its meeting file. There must be a cancel gate AFTER enqueueIngest, not only
  // before it.
  it('a cancel racing the ingest-queue write deletes the meeting and never marks the job done (MQA-104)', async () => {
    let resolveEnqueue!: () => void
    const enqueueIngest = vi.fn(() => new Promise<void>((resolve) => { resolveEnqueue = resolve }))
    const generateRecap = vi.fn(async () => '## Overview\n\nImported summary')
    const deleteMeeting = vi.fn(async () => {})
    const recordMeetingSummarized = vi.fn()
    const { manager } = createManager({ enqueueIngest, generateRecap, deleteMeeting, recordMeetingSummarized })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    const finishing = manager.finishDecoding('job-1')
    for (let i = 0; i < 10 && !resolveEnqueue; i++) await new Promise((resolve) => setTimeout(resolve, 0))

    await manager.cancel('job-1') // cancel WHILE the enqueue write is in flight
    resolveEnqueue()
    await finishing

    expect(deleteMeeting).toHaveBeenCalledWith('saved-import.md')
    expect(manager.get('job-1')?.state).not.toBe('done')
    expect(recordMeetingSummarized).not.toHaveBeenCalled() // a cancelled import never credits time saved
  })

  // MQA-105 (docs/qa/BUG-LEDGER.md): the save ordering now persists state 'saving' only together with a
  // durable file, so a crash in that window recovers as a completed transcript instead of replaying the
  // decoder into a duplicate meeting.
  it('recover treats a crash in the saving window (state saving, file present) as a completed transcript (MQA-105)', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'saving', cursor: 1, totalChunks: 1,
      chunkSec: IMPORT_CHUNK_SECONDS, pipeline: 'vad-v1',
      lines: [{ speaker: 'unknown', text: 'saved transcript', t: source.mtimeMs }], file: 'already-saved.md',
      createdAt: 1, updatedAt: 1
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()

    expect(second.decode).not.toHaveBeenCalled()
    expect(second.saveMeeting).not.toHaveBeenCalled()
    expect(second.manager.get('job-1')).toMatchObject({ state: 'done', file: 'already-saved.md' })
  })

  it('credits the durable time-saved counter exactly once when an import completes cleanly', async () => {
    const recordMeetingSummarized = vi.fn()
    const generateRecap = vi.fn(async () => '## Overview\n\nImported summary')
    const { manager } = createManager({ recordMeetingSummarized, generateRecap })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1')

    expect(recordMeetingSummarized).toHaveBeenCalledTimes(1)
    expect(manager.get('job-1')?.state).toBe('done')
  })

  it('still replays the decoder when a failed import never got as far as saving its meeting (MQA-025, vad-v1)', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('ASR unavailable'))
    const { manager, decode } = createManager({ transcribe })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1')
    expect(manager.get('job-1')?.state).toBe('failed')

    await manager.resume('job-1')

    expect(decode).toHaveBeenCalledTimes(2)
    expect(manager.get('job-1')?.state).toBe('decoding')
  })

  // Legacy branch: a checkpoint from before this field existed, or from a build predating MQA-235 — the
  // chunkSec mismatch/absence check only applies without a `pipeline` marker (see recover()).
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

  it('resumes a queued legacy job on recover() when its checkpoint already matches the current chunk size', async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'decoding', cursor: 3, totalChunks: 7,
      progressPct: 42, chunkSec: IMPORT_CHUNK_SECONDS,
      lines: [{ speaker: 'unknown', text: 'kept window', t: source.mtimeMs }],
      createdAt: 1, updatedAt: 1
      // no `pipeline` field — a recovered pre-MQA-235 checkpoint.
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

  // MQA-235: window boundaries are recomputed deterministically on every resume, so a vad-v1 checkpoint's
  // cursor/lines stay valid no matter what chunkSec says — unlike the legacy branch above, recover() must
  // never reset a vad-v1 job on chunkSec grounds.
  it("recover() never resets a vad-v1 checkpoint on chunkSec grounds — resume re-segments from scratch, it doesn't index by chunkSec", async () => {
    const first = createManager()
    await first.store.save({
      jobId: 'job-1', sourcePath: source.path, sourceName: source.name, sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs, title: 'Interview', state: 'transcribing', cursor: 1, totalChunks: 2,
      chunkSec: IMPORT_CHUNK_SECONDS + 1, // deliberately mismatched — must not matter for vad-v1
      pipeline: 'vad-v1',
      lines: [{ speaker: 'unknown', text: 'kept window', t: source.mtimeMs }],
      createdAt: 1, updatedAt: 1
    })
    const second = createManager()
    ;(second.store as MemoryStore).jobs.clear()
    ;(second.store as MemoryStore).jobs.set('job-1', (first.store as MemoryStore).jobs.get('job-1')!)

    await second.manager.recover()

    expect(second.decode).toHaveBeenCalledTimes(1)
    // cursor/lines/chunkSec all survive untouched — only `totalChunks` is reset. It was carrying phase
    // 2's WINDOW count (2) from before the crash; a resumed phase 1 re-decode always reports totalChunks
    // 0 per slab (see pump()'s comment), so a stale non-zero value here would trip acceptDecodedChunk's
    // "decoder changed the recording chunk count" guard on the very first re-fed slab.
    expect(second.manager.get('job-1')).toMatchObject({
      state: 'decoding', cursor: 1, totalChunks: 0, chunkSec: IMPORT_CHUNK_SECONDS + 1, pipeline: 'vad-v1',
      lines: [{ speaker: 'unknown', text: 'kept window', t: source.mtimeMs }]
    })
  })

  it('dismisses a failed job from both the manager and the persistent store', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('ASR unavailable'))
    const { manager, store } = createManager({ transcribe })
    await manager.start(source)
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1')
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
    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    await manager.finishDecoding('job-1')

    await manager.remove('job-1')

    expect(manager.list()).toEqual([])
  })

  it('N sources produce N durable jobs and only one occupies the decode slot', async () => {
    let n = 0
    const { manager, decode } = createManager({
      newId: () => `job-${++n}`,
      concurrency: 2
    })
    const jobs = await manager.startMany([
      { ...source, name: 'standup.m4a' },
      { ...source, name: 'review.wav' },
      { ...source, name: 'wrap.mp3' }
    ])
    expect(jobs.map((j) => j.title)).toEqual(['Standup', 'Review', 'Wrap'])
    expect(decode).toHaveBeenCalledTimes(1)
    expect(manager.get('job-1')?.state).toBe('decoding')
    expect(manager.get('job-2')?.state).toBe('queued')
    expect(manager.get('job-3')?.state).toBe('queued')
  })

  it('second decode starts only after the first decoder is released; recap of A does not block decode of B', async () => {
    let n = 0
    let releaseRecap!: (value: string) => void
    const generateRecap = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseRecap = resolve
        })
    )
    const { manager, decode } = createManager({
      newId: () => `job-${++n}`,
      generateRecap
    })
    await manager.startMany([
      { ...source, name: 'first.m4a' },
      { ...source, name: 'second.wav' }
    ])
    expect(decode).toHaveBeenCalledTimes(1)
    expect(manager.get('job-1')?.state).toBe('decoding')
    expect(manager.get('job-2')?.state).toBe('queued')

    await manager.acceptDecodedChunk('job-1', 0, 0, oneWindowPcm())
    const finishing = manager.finishDecoding('job-1')
    await vi.waitFor(() => expect(generateRecap).toHaveBeenCalled())
    expect(decode).toHaveBeenCalledTimes(2)
    expect(manager.get('job-2')?.state).toBe('decoding')
    expect(manager.get('job-1')?.state).toBe('recapping')

    releaseRecap('## Title: Standup\n## Decisions: None.')
    await finishing
    expect(manager.get('job-1')?.state).toBe('done')
    expect(manager.get('job-2')?.state).toBe('decoding')
  })

  it('resume still re-queues a failed job after a multi-file start', async () => {
    let n = 0
    let failedOnce = false
    const decode = vi.fn(async (job: ImportJob) => {
      if (job.jobId === 'job-1' && !failedOnce) {
        failedOnce = true
        throw new Error('decoder died')
      }
    })
    const { manager } = createManager({
      decode,
      newId: () => `job-${++n}`
    })
    await manager.startMany([
      { ...source, name: 'first.m4a' },
      { ...source, name: 'second.wav' }
    ])
    expect(manager.get('job-1')?.state).toBe('failed')
    expect(manager.get('job-2')?.state).toBe('decoding')
    expect(decode).toHaveBeenCalledTimes(2)

    const resumed = await manager.resume('job-1')
    expect(resumed.state).toBe('queued')
    expect(manager.get('job-2')?.state).toBe('decoding')
    expect(decode).toHaveBeenCalledTimes(2)
    await manager.releaseDecodeSlot('job-2')
    expect(manager.get('job-1')?.state).toBe('decoding')
    expect(decode).toHaveBeenCalledTimes(3)
  })

  it('decoderSlotIsStale is true for every non-decode state so recap cannot hold the next file', () => {
    expect(decoderSlotIsStale('decoding')).toBe(false)
    expect(decoderSlotIsStale('transcribing')).toBe(true)
    expect(decoderSlotIsStale('saving')).toBe(true)
    expect(decoderSlotIsStale('recapping')).toBe(true)
    expect(decoderSlotIsStale('done')).toBe(true)
    expect(decoderSlotIsStale('failed')).toBe(true)
    expect(decoderSlotIsStale('cancelled')).toBe(true)
    expect(decoderSlotIsStale('queued')).toBe(true)
    expect(decoderSlotIsStale(undefined)).toBe(true)
  })

  it('starts job 2 the instant job 1 decode fails', async () => {
    let n = 0
    const decode = vi.fn(async (job: ImportJob) => {
      if (job.jobId === 'job-1') throw new Error('decoder died')
    })
    const { manager } = createManager({
      decode,
      newId: () => `job-${++n}`
    })
    await manager.startMany([
      { ...source, name: 'first.m4a' },
      { ...source, name: 'second.wav' }
    ])
    expect(manager.get('job-1')?.state).toBe('failed')
    expect(manager.get('job-2')?.state).toBe('decoding')
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('starts job 2 after job 1 is cancelled mid-decode', async () => {
    let n = 0
    const { manager, decode } = createManager({
      newId: () => `job-${++n}`
    })
    await manager.startMany([
      { ...source, name: 'first.m4a' },
      { ...source, name: 'second.wav' }
    ])
    expect(decode).toHaveBeenCalledTimes(1)
    await manager.cancel('job-1')
    expect(manager.get('job-1')?.state).toBe('cancelled')
    expect(manager.get('job-2')?.state).toBe('decoding')
    expect(decode).toHaveBeenCalledTimes(2)
  })
})
