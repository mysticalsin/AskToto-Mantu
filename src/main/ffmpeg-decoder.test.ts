import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bundledFfmpegPath, startFfmpegDecode, FFMPEG_CHUNK_SAMPLES } from './ffmpeg-decoder'

const root = join(process.cwd(), 'resources')
const ffmpeg = bundledFfmpegPath(root)
const wav = join(root, 'asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav')
const temp: string[] = []
const gateOk = !!ffmpeg && existsSync(wav)

// Both the ffmpeg sidecar (untracked local build output) and the ASR test fixture (gitignored) are
// absent from a bare checkout / most CI runners, so this whole suite silently no-ops there via
// describe.runIf below. A silent skip reads as "passing" in CI output — warn loudly so a missing
// sidecar/fixture is visibly a skip, not a green check.
if (!gateOk) {
  const missing: string[] = []
  if (!ffmpeg) missing.push(`ffmpeg sidecar (resources/ffmpeg/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'})`)
  if (!existsSync(wav)) missing.push(`fixture (${wav})`)
  console.warn(`[ffmpeg-decoder.test] SKIPPING "bundled FFmpeg import decoder" suite — missing: ${missing.join(', ')}`)
}

afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(gateOk)('bundled FFmpeg import decoder', () => {
  it('streams a WAV to owned 16 kHz mono PCM windows', async () => {
    const chunks: Float32Array[] = []
    const progress: number[] = []
    let failure: Error | null = null
    const decoder = startFfmpegDecode(ffmpeg!, wav, 0, {
      onChunk: async (_seq, samples) => { chunks.push(samples) },
      onProgress: async (pct) => { progress.push(pct) },
      onComplete: async () => {},
      onError: async (error) => { failure = error }
    })
    await decoder.completed

    expect(failure).toBeNull()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= FFMPEG_CHUNK_SAMPLES)).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(99)
    expect(progress.every((pct, index) => index === 0 || pct >= progress[index - 1])).toBe(true)
  })

  it('accepts a compressed M4A recording and resumes from a checkpoint boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asktoto-ffmpeg-test-'))
    temp.push(dir)
    const m4a = join(dir, 'sample.m4a')
    // The source fixture (en.wav) is only ~3.85s — far short of FFMPEG_CHUNK_SAMPLES, so a plain
    // transcode would decode as a single seq=0 tail chunk and skipThrough=1 would filter EVERYTHING,
    // making this test pass vacuously (seen=[] trivially equals the expected empty array) without ever
    // exercising the resume/skip-through logic. Loop the fixture past 60s so the decode genuinely spans
    // several chunks (multiple full windows + a short tail) and skipping the first one is real coverage.
    const encoded = spawnSync(ffmpeg!, ['-y', '-stream_loop', '-1', '-i', wav, '-t', '65', '-c:a', 'aac', m4a], {
      encoding: 'utf8'
    })
    expect(encoded.status).toBe(0)

    const seen: number[] = []
    let total = -1
    const decoder = startFfmpegDecode(ffmpeg!, m4a, 1, {
      onChunk: async (seq) => { seen.push(seq) },
      onComplete: async (count) => { total = count },
      onError: async (error) => { throw error }
    })
    await decoder.completed

    // Fails loudly (rather than passing vacuously) if the looped fixture above ever stops spanning
    // multiple chunks — the whole point of this test is exercising the skip-through boundary.
    expect(total).toBeGreaterThan(1)
    expect(seen).toEqual(Array.from({ length: Math.max(0, total - 1) }, (_, index) => index + 1))
  })
})

// Needs no sidecar/fixture (the point is that FFmpeg cannot be launched at all), so it runs everywhere
// the gated suite above skips.
describe('FFmpeg spawn failure', () => {
  it('MQA-063: reports an unspawnable executable through onError instead of an uncaught exception', async () => {
    const executable = join(tmpdir(), `asktoto-missing-ffmpeg-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`)
    expect(existsSync(executable)).toBe(false)

    const failures: Error[] = []
    const decoder = startFfmpegDecode(executable, join(tmpdir(), 'asktoto-missing-source.m4a'), 0, {
      onChunk: async () => {},
      onComplete: async () => {},
      onError: async (error) => { failures.push(error) }
    })

    // Node emits ENOENT on the next tick, inside the duration probe's await. Before the fix the
    // decode child had no 'error' listener yet, so EventEmitter re-threw it (main-process
    // uncaughtException) and `completed` never settled — hence the explicit race rather than a bare
    // await, which would only ever surface as a test-runner timeout.
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      decoder.completed.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), 4_000) })
    ])
    clearTimeout(timer)

    expect(outcome).toBe('settled')
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toMatch(/ENOENT/)
  })
})
