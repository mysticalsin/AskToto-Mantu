import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bundledFfmpegPath,
  describeDecoderFailure,
  startFfmpegDecode,
  FFMPEG_CHUNK_SAMPLES,
  UNREADABLE_AUDIO_MESSAGE,
  UNSUPPORTED_AUDIO_MESSAGE
} from './ffmpeg-decoder'
import { mainLog } from './logger'
import { IMPORT_NOT_MEDIA } from './import-magic'

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
  if (!ffmpeg)
    missing.push(
      `ffmpeg sidecar (resources/ffmpeg/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'})`
    )
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
      onChunk: async (_seq, samples) => {
        chunks.push(samples)
      },
      onProgress: async (pct) => {
        progress.push(pct)
      },
      onComplete: async () => {},
      onError: async (error) => {
        failure = error
      }
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
      onChunk: async (seq) => {
        seen.push(seq)
      },
      onComplete: async (count) => {
        total = count
      },
      onError: async (error) => {
        throw error
      }
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
    const executable = join(
      tmpdir(),
      `asktoto-missing-ffmpeg-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`
    )
    expect(existsSync(executable)).toBe(false)

    const failures: Error[] = []
    const decoder = startFfmpegDecode(executable, join(tmpdir(), 'asktoto-missing-source.m4a'), 0, {
      onChunk: async () => {},
      onComplete: async () => {},
      onError: async (error) => {
        failures.push(error)
      }
    })

    // Node emits ENOENT on the next tick, inside the duration probe's await. Before the fix the
    // decode child had no 'error' listener yet, so EventEmitter re-threw it (main-process
    // uncaughtException) and `completed` never settled — hence the explicit race rather than a bare
    // await, which would only ever surface as a test-runner timeout.
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      decoder.completed.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), 4_000)
      })
    ])
    clearTimeout(timer)

    expect(outcome).toBe('settled')
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toMatch(/ENOENT/)
  })

  it('refuses an existing non-media file before spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asktoto-ff-magic-'))
    temp.push(dir)
    const html = join(dir, 'payload.mp3')
    writeFileSync(html, '<!DOCTYPE html><script>alert(1)</script>')

    const failures: Error[] = []
    const decoder = startFfmpegDecode('/bin/false', html, 0, {
      onChunk: async () => {},
      onComplete: async () => {},
      onError: async (error) => {
        failures.push(error)
      }
    })
    await decoder.completed
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toBe(IMPORT_NOT_MEDIA)
  })
})

// The stand-in "ffmpeg" below traps SIGTERM (a shell builtin), which no Windows child can do — `kill` there
// is TerminateProcess, which cannot be ignored. Runs on linux and darwin only.
describe.skipIf(process.platform === 'win32')('cancel (POSIX)', () => {
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  // Registered as soon as each pid is read from disk, before anything that could throw — a failed
  // assertion or a waitUntil timeout must never leak a SIGTERM-immune `sleep 600` stand-in past this test.
  let spawnedPids: number[] = []

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('D1: cancel kills the decode and its duration probe at once, even an ffmpeg that ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asktoto-ffmpeg-cancel-'))
    temp.push(dir)
    const pidsFile = join(dir, 'pids')
    writeFileSync(pidsFile, '')
    const fakeFfmpeg = join(dir, 'fake-ffmpeg')
    // trap '' TERM makes the disposition SIGTERM-immune, and it survives exec (a shell builtin, set before
    // the exec replaces the process image). Only SIGKILL — which cannot be trapped — can end this child.
    writeFileSync(fakeFfmpeg, `#!/bin/sh\ntrap '' TERM\necho $$ >> '${pidsFile}'\nexec sleep 600\n`)
    chmodSync(fakeFfmpeg, 0o755)
    const source = join(dir, 'source.wav')
    // A RIFF/WAVE header (plus padding) is enough for sniffMediaFile to accept the file; the fake ffmpeg
    // never actually reads it.
    writeFileSync(source, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]))

    let errorCalled = false
    const decoder = startFfmpegDecode(fakeFfmpeg, source, 0, {
      onChunk: async () => {},
      onComplete: async () => {},
      onError: async () => {
        errorCalled = true
      }
    })

    // Two lines: the decode's ffmpeg and the duration probe's ffmpeg, both spawned from the same fake
    // executable.
    await waitUntil(() => readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).length >= 2, 2_000)
    const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    spawnedPids.push(...pids)

    decoder.cancel()

    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      decoder.completed.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), 3_000)
      })
    ])
    clearTimeout(timer)
    expect(outcome).toBe('settled')

    for (const pid of pids) {
      await waitUntil(() => !isAlive(pid), 2_000)
    }

    expect(errorCalled).toBe(false)
  })
})

describe('decoder failure copy (D9-9)', () => {
  const header = "Input #0, asf, from '/Users/someone/Recordings/call.wma':\n  Duration: N/A, bitrate: N/A\n"

  it('maps known ffmpeg failures to the unsupported-format message', () => {
    for (const tail of [
      'Invalid data found when processing input',
      'Output file #0 does not contain any stream',
      'Stream #0:0: Unsupported codec with id 86052 for input stream 0',
      'moov atom not found',
      'Decoder (codec wmav2) not found for input stream #0:0'
    ]) {
      expect(describeDecoderFailure(`${header}${tail}\n`)).toBe(UNSUPPORTED_AUDIO_MESSAGE)
    }
    expect(UNSUPPORTED_AUDIO_MESSAGE).toBe("This recording's audio format isn't supported.")
  })

  it('maps anything else, including no output at all, to the generic message without raw text', () => {
    for (const raw of ['', 'Segmentation fault', `${header}Some new ffmpeg failure`]) {
      const message = describeDecoderFailure(raw)
      expect(message).toBe(UNREADABLE_AUDIO_MESSAGE)
      expect(message).not.toContain('/Users/')
    }
    expect(UNREADABLE_AUDIO_MESSAGE).toBe("Métis couldn't read the audio in this file.")
  })
})

// A shell stand-in that prints canned ffmpeg stderr; there is no equivalent shebang on Windows.
describe.skipIf(process.platform === 'win32')('decoder failure reaches onError as plain copy (D9-9)', () => {
  it('keeps the raw ffmpeg text, with the source path, in the log and out of the job error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asktoto-ffmpeg-stderr-'))
    temp.push(dir)
    const fakeFfmpeg = join(dir, 'fake-ffmpeg')
    writeFileSync(
      fakeFfmpeg,
      "#!/bin/sh\necho \"Input #0, asf, from '/Users/someone/Recordings/call.wma':\" >&2\necho 'Invalid data found when processing input' >&2\nexit 1\n"
    )
    chmodSync(fakeFfmpeg, 0o755)
    const source = join(dir, 'source.wav')
    writeFileSync(source, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]))

    const warn = vi.spyOn(mainLog, 'warn').mockImplementation(() => {})
    const failures: Error[] = []
    const decoder = startFfmpegDecode(fakeFfmpeg, source, 0, {
      onChunk: async () => {},
      onComplete: async () => {},
      onError: async (error) => {
        failures.push(error)
      }
    })
    await decoder.completed
    expect(failures).toHaveLength(1)
    expect(failures[0].message).toBe(UNSUPPORTED_AUDIO_MESSAGE)
    expect(warn.mock.calls.flat().join('\n')).toContain('Invalid data found when processing input')
    warn.mockRestore()
  })
})
