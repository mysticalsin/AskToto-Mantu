import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

export const FFMPEG_SAMPLE_RATE = 16_000
export const FFMPEG_CHUNK_SECONDS = 30
export const FFMPEG_CHUNK_SAMPLES = FFMPEG_SAMPLE_RATE * FFMPEG_CHUNK_SECONDS
const FFMPEG_CHUNK_BYTES = FFMPEG_CHUNK_SAMPLES * Float32Array.BYTES_PER_ELEMENT
const MAX_STDERR_BYTES = 16_384

export interface FfmpegDecodeCallbacks {
  onChunk(seq: number, samples: Float32Array): Promise<void>
  onComplete(totalChunks: number): Promise<void>
  onError(error: Error): Promise<void>
}

export interface FfmpegDecoder {
  cancel(): void
  completed: Promise<void>
}

/** Resolve only a package-owned, vetted LGPL FFmpeg binary — never a PATH lookup. */
export function bundledFfmpegPath(resourcesDir: string, platform = process.platform, arch = process.arch): string | null {
  const platformDir = `${platform}-${arch}`
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const path = join(resourcesDir, 'ffmpeg', platformDir, name)
  return existsSync(path) ? path : null
}

/**
 * Stream an arbitrary recording through FFmpeg as 16 kHz mono f32le PCM. At most one 30-second chunk
 * plus the decoder's internal buffers is held in JavaScript; the source recording stays on disk.
 */
export function startFfmpegDecode(
  executable: string,
  sourcePath: string,
  skipThrough: number,
  callbacks: FfmpegDecodeCallbacks
): FfmpegDecoder {
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

  const completed = (async (): Promise<void> => {
    let stderr = ''
    let spawnError: Error | null = null
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length)
    })
    child.once('error', (error) => {
      spawnError = error
    })
    const close = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
    // 'error' can fire before 'close', rejecting this promise while nothing awaits it yet (the stdout
    // for-await loop below runs first). Observe it immediately so that isn't an unhandled rejection;
    // `await close` further down still sees the real rejection.
    close.catch(() => {})
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
        seq++
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
      seq++
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
