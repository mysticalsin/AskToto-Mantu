import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { IMPORT_CHUNK_SECONDS } from '@shared/ipc'
import { IMPORT_NOT_MEDIA, sniffMediaFile } from './import-magic'

export const FFMPEG_SAMPLE_RATE = 16_000
export const FFMPEG_CHUNK_SECONDS = IMPORT_CHUNK_SECONDS
export const FFMPEG_CHUNK_SAMPLES = FFMPEG_SAMPLE_RATE * FFMPEG_CHUNK_SECONDS
const FFMPEG_CHUNK_BYTES = FFMPEG_CHUNK_SAMPLES * Float32Array.BYTES_PER_ELEMENT
const MAX_STDERR_BYTES = 16_384
const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/i
const DURATION_PROBE_TIMEOUT_MS = 5_000

export interface FfmpegDecodeCallbacks {
  onChunk(seq: number, samples: Float32Array): Promise<void>
  /** Called after a decoded window has been handed to main-process transcription. Values are 0–99;
   *  100 is reserved for the saved transcript plus automatic summary. */
  onProgress?: (pct: number) => Promise<void> | void
  onComplete(totalChunks: number): Promise<void>
  onError(error: Error): Promise<void>
}

export interface FfmpegDecoder {
  cancel(): void
  completed: Promise<void>
}

/** Read container duration without decoding the recording. FFmpeg prints the stream metadata before the
 * zero-length null output exits, so this adds a short bounded probe and gives the main process a real
 * denominator for progress instead of an indeterminate "Listening for speech" animation. */
async function probeDurationSeconds(executable: string, sourcePath: string): Promise<number | null> {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(
      executable,
      ['-nostdin', '-hide_banner', '-loglevel', 'info', '-i', sourcePath, '-vn', '-t', '0', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
  } catch {
    return null
  }

  return new Promise<number | null>((resolve) => {
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (value: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM')
      finish(null)
    }, DURATION_PROBE_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length)
    })
    child.once('error', () => finish(null))
    child.once('close', () => {
      const match = stderr.match(DURATION_RE)
      if (!match) {
        finish(null)
        return
      }
      const hours = Number(match[1])
      const minutes = Number(match[2])
      const seconds = Number(match[3])
      const duration = hours * 3600 + minutes * 60 + seconds
      finish(Number.isFinite(duration) && duration > 0 ? duration : null)
    })
  })
}

function progressForSamples(decodedSamples: number, totalSamples: number): number {
  return Math.min(99, Math.max(0, Math.round((decodedSamples / totalSamples) * 100)))
}

/** Resolve only a package-owned, vetted LGPL FFmpeg binary — never a PATH lookup. */
export function bundledFfmpegPath(resourcesDir: string, platform = process.platform, arch = process.arch): string | null {
  const platformDir = `${platform}-${arch}`
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const path = join(resourcesDir, 'ffmpeg', platformDir, name)
  return existsSync(path) ? path : null
}

/**
 * Stream an arbitrary recording through FFmpeg as 16 kHz mono f32le PCM. At most one FFMPEG_CHUNK_SECONDS
 * chunk plus the decoder's internal buffers is held in JavaScript; the source recording stays on disk.
 */
export function startFfmpegDecode(
  executable: string,
  sourcePath: string,
  skipThrough: number,
  callbacks: FfmpegDecodeCallbacks
): FfmpegDecoder {
  // Missing sources still fail at spawn (ENOENT) so existing import-error
  // contracts stay intact. Magic-byte sniff only runs when the file exists.
  if (existsSync(sourcePath) && !sniffMediaFile(sourcePath)) {
    const completed = callbacks.onError(new Error(IMPORT_NOT_MEDIA))
    return { cancel: () => {}, completed }
  }
  let child: ChildProcessByStdio<null, Readable, Readable>
  let cancelled = false
  try {
    child = spawn(
      executable,
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-vn', '-ac', '1', '-ar', String(FFMPEG_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
  } catch (error) {
    const completed = callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    return { cancel: () => {}, completed }
  }

  // Node reports the common spawn failures (ENOENT/EACCES/EAGAIN) asynchronously on the next tick —
  // i.e. while the duration probe below is still awaiting its own child, so the try/catch above never
  // sees them. EventEmitter re-throws an 'error' event that has no listener yet, which escalated a
  // quarantined/undeletable-but-unspawnable sidecar from a failed import into a main-process
  // uncaughtException (fatal crash dialog) and left `completed` unsettled forever. Observe the child
  // synchronously with the spawn, before anything awaits.
  let spawnError: Error | null = null
  child.once('error', (error) => {
    spawnError = error
  })
  const close = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  // 'error' can fire before 'close', rejecting this promise while nothing awaits it yet (the stdout
  // for-await loop below runs first). Observe it immediately so that isn't an unhandled rejection;
  // `await close` further down still sees the real rejection.
  close.catch(() => {})

  const completed = (async (): Promise<void> => {
    const durationSeconds = await probeDurationSeconds(executable, sourcePath)
    if (cancelled) return
    const totalSamples = durationSeconds ? Math.max(1, Math.ceil(durationSeconds * FFMPEG_SAMPLE_RATE)) : null
    let decodedSamples = 0
    if (totalSamples) {
      await callbacks.onProgress?.(progressForSamples(skipThrough * FFMPEG_CHUNK_SAMPLES, totalSamples))
    }
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length)
    })
    let pending = Buffer.alloc(0)
    let seq = 0

    for await (const raw of child.stdout) {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      pending = pending.length ? Buffer.concat([pending, data]) : data
      while (pending.length >= FFMPEG_CHUNK_BYTES) {
        // Copy exactly one owned window before awaiting main-process ASR: `subarray` would retain a
        // potentially huge backing buffer and defeat the bounded-memory guarantee.
        const pcm = Buffer.from(pending.subarray(0, FFMPEG_CHUNK_BYTES))
        pending = pending.subarray(FFMPEG_CHUNK_BYTES)
        if (seq >= skipThrough) {
          const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
          await callbacks.onChunk(seq, samples)
        }
        decodedSamples += FFMPEG_CHUNK_SAMPLES
        seq++
        if (totalSamples) await callbacks.onProgress?.(progressForSamples(decodedSamples, totalSamples))
      }
    }

    const [code, signal] = await close
    if (cancelled) return
    if (spawnError) throw spawnError
    if (code !== 0) throw new Error(stderr.trim() || `Audio decoder stopped (${signal || `exit ${code}`}).`)
    if (pending.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('Audio decoder returned an incomplete PCM sample.')
    if (pending.length) {
      const pcm = Buffer.from(pending)
      if (seq >= skipThrough) {
        const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
        await callbacks.onChunk(seq, samples)
      }
      decodedSamples += pcm.byteLength / Float32Array.BYTES_PER_ELEMENT
      seq++
      if (totalSamples) await callbacks.onProgress?.(progressForSamples(decodedSamples, totalSamples))
    }
    await callbacks.onComplete(seq)
  })().catch(async (error) => {
    if (!cancelled) await callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  })

  return {
    cancel: () => {
      cancelled = true
      if (!child.killed) child.kill('SIGTERM')
    },
    completed
  }
}
