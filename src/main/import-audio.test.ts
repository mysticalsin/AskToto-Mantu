import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings, ImportAudioChunk } from '@shared/ipc'

vi.mock('electron')

const parakeetTranscribeMock = vi.fn(async (_samples: Float32Array) => 'hello world')
const ensureParakeetModelMock = vi.fn(async () => {})
vi.mock('./parakeet', () => ({
  ensureParakeetModel: (...args: unknown[]) => ensureParakeetModelMock(...args),
  parakeetTranscribe: (...args: unknown[]) => parakeetTranscribeMock(...args)
}))

const enqueueIngestMock = vi.fn()
vi.mock('./brain/ingest', () => ({ enqueueIngest: (...args: unknown[]) => enqueueIngestMock(...args) }))

import {
  humanizeFilename,
  chunkToLine,
  chunkProgressPct,
  handleImportChunk,
  abandonImportSession,
  readPickedAudioFile
} from './import-audio'
import { readSavedFile } from './transcripts'

function makeChunk(overrides: Partial<ImportAudioChunk> = {}): ImportAudioChunk {
  return {
    sessionId: 'sess-1',
    seq: 0,
    totalChunks: 1,
    done: true,
    name: 'q3-budget_review.wav',
    mtimeMs: 1_700_000_000_000,
    samples: new Float32Array(16000),
    ...overrides
  }
}

describe('humanizeFilename', () => {
  it('strips the extension and humanizes dashes/underscores', () => {
    expect(humanizeFilename('q3-budget_review.wav')).toBe('Q3 Budget Review')
  })

  it('collapses repeated separators and surrounding whitespace', () => {
    expect(humanizeFilename('  weekly__sync--notes.mp3 ')).toBe('Weekly Sync Notes')
  })

  it('preserves further capitalization (e.g. an acronym) while capitalizing the first letter', () => {
    expect(humanizeFilename('NASA-briefing.m4a')).toBe('NASA Briefing')
  })

  it('falls back to a generic title for an empty or separators-only name', () => {
    expect(humanizeFilename('____.wav')).toBe('Imported audio')
    expect(humanizeFilename('.wav')).toBe('Imported audio')
  })

  it('handles a filename with no extension', () => {
    expect(humanizeFilename('standup-notes')).toBe('Standup Notes')
  })
})

describe('chunkToLine / chunkProgressPct', () => {
  it('timestamps a line by its chunk offset (30s windows), not wall-clock time', () => {
    const line = chunkToLine('hello', 2, 1_700_000_000_000)
    expect(line).toEqual({ speaker: 'you', text: 'hello', t: 1_700_000_000_000 + 2 * 30_000 })
  })

  it('computes 0-100 progress from chunk index / total', () => {
    expect(chunkProgressPct(0, 3)).toBe(33)
    expect(chunkProgressPct(1, 3)).toBe(67)
    expect(chunkProgressPct(2, 3)).toBe(100)
  })

  it('never divides by zero', () => {
    expect(chunkProgressPct(0, 0)).toBe(0)
  })
})

describe('handleImportChunk', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-import-audio-test-'))
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    parakeetTranscribeMock.mockClear()
    parakeetTranscribeMock.mockResolvedValue('hello world')
    ensureParakeetModelMock.mockClear()
    enqueueIngestMock.mockClear()
    abandonImportSession()
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    abandonImportSession()
    vi.restoreAllMocks()
  })

  it('transcribes a single-chunk session and saves it with a humanized title + file mtime as startedAt', async () => {
    const progress: { pct: number; stage: string }[] = []
    const result = await handleImportChunk(settings, makeChunk(), (pct, stage) => progress.push({ pct, stage }))
    expect(result.ok).toBe(true)
    expect(result.title).toBe('Q3 Budget Review')
    expect(result.lines).toEqual([{ speaker: 'you', text: 'hello world', t: 1_700_000_000_000 }])
    expect(progress.some((p) => p.stage === 'transcribing')).toBe(true)
    expect(progress.some((p) => p.stage === 'saving')).toBe(true)
    expect(enqueueIngestMock).toHaveBeenCalledTimes(1)
    const saved = readSavedFile(result.file!)
    expect(saved).toContain('# Q3 Budget Review')
    expect(saved).toContain('hello world')
  })

  it('accumulates lines across multiple chunks in the same session, in chunk order', async () => {
    parakeetTranscribeMock.mockResolvedValueOnce('first chunk').mockResolvedValueOnce('second chunk')
    await handleImportChunk(settings, makeChunk({ seq: 0, done: false, totalChunks: 2 }), () => {})
    const r = await handleImportChunk(settings, makeChunk({ seq: 1, done: true, totalChunks: 2 }), () => {})
    expect(r.lines?.map((l) => l.text)).toEqual(['first chunk', 'second chunk'])
  })

  it('skips a genuinely silent chunk (empty transcribed text) rather than saving a blank line', async () => {
    parakeetTranscribeMock.mockResolvedValueOnce('')
    const r = await handleImportChunk(settings, makeChunk(), () => {})
    expect(r.lines).toEqual([])
  })

  it('never calls parakeetTranscribe for a zero-length (silent/empty) chunk', async () => {
    await handleImportChunk(settings, makeChunk({ samples: new Float32Array(0) }), () => {})
    expect(parakeetTranscribeMock).not.toHaveBeenCalled()
  })

  it('a new sessionId replaces whatever the previous (unfinished) session had accumulated', async () => {
    await handleImportChunk(settings, makeChunk({ sessionId: 'a', seq: 0, done: false, totalChunks: 2 }), () => {})
    const r = await handleImportChunk(
      settings,
      makeChunk({ sessionId: 'b', seq: 0, done: true, totalChunks: 1, name: 'other.wav' }),
      () => {}
    )
    // Session 'b' must not carry session 'a's already-transcribed line.
    expect(r.lines?.length).toBe(1)
    expect(r.title).toBe('Other')
  })

  it('returns ok:false and abandons the session when transcription fails, without leaking into the next one', async () => {
    parakeetTranscribeMock.mockRejectedValueOnce(new Error('engine unavailable'))
    const r = await handleImportChunk(settings, makeChunk(), () => {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/engine unavailable/)
    const r2 = await handleImportChunk(settings, makeChunk({ sessionId: 'fresh' }), () => {})
    expect(r2.ok).toBe(true)
    expect(r2.lines?.length).toBe(1)
  })
})

describe('readPickedAudioFile (path guard)', () => {
  it('refuses a path that was not just returned by pickAudioFile', () => {
    expect(() => readPickedAudioFile('/etc/passwd')).toThrow()
  })

  it('refuses an empty path', () => {
    expect(() => readPickedAudioFile('')).toThrow()
  })
})
