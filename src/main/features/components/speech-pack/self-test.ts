import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { PARAKEET_TDT_V3_INT8, SELF_TEST_FIXTURE, WHISPER_BASE_Q8, type SpeechPackComponentId } from './manifest'

const START_TIMEOUT_MS = 30_000
const RECOGNITION_TIMEOUT_MS = 120_000
const TEARDOWN_TIMEOUT_MS = 5_000
const MAX_FIXTURE_SAMPLES = 16_000 * 30

let activeSelfTestHost: HostPort | null = null
let stoppingSelfTestHost: HostPort | null = null
let stopBarrier: Promise<void> | null = null
let resolveStopBarrier: (() => void) | null = null

interface HostPort {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  postMessage(message: Record<string, unknown>): void
  kill(): void
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
}

export type SpeechPackHostFork = (
  path: string,
  args: string[],
  options: { serviceName: string; stdio: 'pipe' }
) => HostPort

function parseFixturePcm(bytes: Buffer): ArrayBuffer {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The pinned self-test fixture is not a WAV file.')
  }
  let format = -1
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataBytes = 0
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (size > bytes.length - body) throw new Error('The pinned self-test fixture has an invalid WAV chunk.')
    if (id === 'fmt ' && size >= 16) {
      format = bytes.readUInt16LE(body)
      channels = bytes.readUInt16LE(body + 2)
      sampleRate = bytes.readUInt32LE(body + 4)
      bitsPerSample = bytes.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = size
    }
    offset = body + size + (size % 2)
  }
  const supportedSamples = (format === 1 && [16, 32].includes(bitsPerSample)) || (format === 3 && bitsPerSample === 32)
  if (
    dataOffset < 0 ||
    ![1, 3].includes(format) ||
    channels < 1 ||
    channels > 2 ||
    sampleRate !== 16_000 ||
    !supportedSamples
  ) {
    throw new Error('The pinned self-test fixture uses an unsupported WAV format.')
  }
  const bytesPerSample = bitsPerSample / 8
  const frameBytes = bytesPerSample * channels
  if (dataBytes === 0 || dataBytes % frameBytes !== 0)
    throw new Error('The pinned self-test fixture has invalid audio data.')
  const frames = dataBytes / frameBytes
  if (frames > MAX_FIXTURE_SAMPLES) throw new Error('The pinned self-test fixture exceeds the recognition bound.')
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      const at = dataOffset + frame * frameBytes + channel * bytesPerSample
      const sample =
        format === 3
          ? bytes.readFloatLE(at)
          : bitsPerSample === 16
            ? bytes.readInt16LE(at) / 32_768
            : bytes.readInt32LE(at) / 2_147_483_648
      if (!Number.isFinite(sample)) throw new Error('The pinned self-test fixture contains invalid samples.')
      sum += sample
    }
    samples[frame] = sum / channels
  }
  return samples.buffer
}

function defaultFork(path: string, args: string[], options: { serviceName: string; stdio: 'pipe' }): UtilityProcess {
  return utilityProcess.fork(path, args, options)
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    const abort = (): void => finish(() => reject(new Error('Speech-pack self-test was cancelled.')))
    timer = setTimeout(() => finish(() => reject(new Error('Speech-pack self-test timed out.'))), ms)
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
  })
}

export function speechPackHostEntryPath(mainOutputDirectory: string, componentId: SpeechPackComponentId): string {
  return join(mainOutputDirectory, componentId === WHISPER_BASE_Q8.id ? 'whisper-asr-host.js' : 'parakeet-asr-host.js')
}

async function acquireHostSlot(): Promise<void> {
  if (activeSelfTestHost && !stoppingSelfTestHost) throw new Error('A speech-pack self-test is already running.')
  if (!stopBarrier) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const released = await Promise.race([
    stopBarrier.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), TEARDOWN_TIMEOUT_MS)
    })
  ])
  clearTimeout(timer)
  if (!released) throw new Error('Previous speech-pack utility host is still stopping.')
}

async function waitForHostSlot(): Promise<void> {
  await acquireHostSlot()
}

function hostExited(host: HostPort): void {
  if (activeSelfTestHost === host) activeSelfTestHost = null
  if (stoppingSelfTestHost !== host) return
  const resolve = resolveStopBarrier
  stoppingSelfTestHost = null
  stopBarrier = null
  resolveStopBarrier = null
  resolve?.()
}

async function stopHost(host: HostPort, didExit: () => boolean): Promise<void> {
  if (didExit()) {
    hostExited(host)
    return
  }
  if (!(stoppingSelfTestHost === host && stopBarrier)) {
    stoppingSelfTestHost = host
    stopBarrier = new Promise<void>((resolve) => {
      resolveStopBarrier = resolve
    })
  }
  const barrier = stopBarrier as Promise<void>
  try {
    host.kill()
  } catch {
    if (didExit()) {
      hostExited(host)
      return
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = await Promise.race([
    barrier.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), TEARDOWN_TIMEOUT_MS)
    })
  ])
  clearTimeout(timer)
  if (!stopped || !didExit()) throw new Error('Speech-pack utility host did not stop within the teardown bound.')
}

/** Run the existing isolated recognizer against the pinned fixture. No transcript is returned to the caller. */
export async function runSpeechPackSelfTest(input: {
  componentId: SpeechPackComponentId
  packDir: string
  wavPath: string
  signal: AbortSignal
  fork?: SpeechPackHostFork
}): Promise<string> {
  const wav = await readFile(input.wavPath)
  if (
    wav.length !== SELF_TEST_FIXTURE.bytes ||
    createHash('sha256').update(wav).digest('hex') !== SELF_TEST_FIXTURE.sha256
  )
    throw new Error('Speech-pack self-test fixture does not match its pin.')
  const pcm = parseFixturePcm(wav)
  const whisper = input.componentId === WHISPER_BASE_Q8.id
  await waitForHostSlot()
  const entry = speechPackHostEntryPath(__dirname, input.componentId)
  const host = (input.fork ?? defaultFork)(entry, [], {
    serviceName: `metis-speech-pack-check-${input.componentId.replace(/[^a-z0-9-]/gi, '-')}`,
    stdio: 'pipe'
  })
  activeSelfTestHost = host
  host.stderr?.on('data', () => undefined)
  host.stdout?.on('data', () => undefined)
  let exitError: Error | null = null
  let didExit = false
  let rejectResult: ((reason?: unknown) => void) | null = null
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  host.on('exit', (code) => {
    didExit = true
    hostExited(host)
    if (code !== 0) exitError = new Error('Speech-pack utility host exited before the self-test completed.')
    rejectResult?.(exitError ?? new Error('Speech-pack utility host exited before the self-test completed.'))
  })

  const result = new Promise<string>((resolve, reject) => {
    rejectResult = reject
    let sent = false
    host.on('message', (raw) => {
      const msg = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data?: unknown }).data : raw
      if (!msg || typeof msg !== 'object') return
      const response = msg as { type?: string; id?: string | number; text?: unknown; message?: unknown }
      if (whisper && response.type === 'ready' && !sent) {
        clearTimeout(startupTimer)
        startupTimer = undefined
        sent = true
        host.postMessage({ type: 'transcribe', id: 1, pcm })
        return
      }
      if (!whisper && response.id === 'speech-pack-startup') {
        clearTimeout(startupTimer)
        startupTimer = undefined
        if (response.type === 'result' && !sent) {
          sent = true
          const files = Object.fromEntries(
            PARAKEET_TDT_V3_INT8.files.map((file) => [file.path, join(input.packDir, file.path)])
          )
          host.postMessage({
            type: 'transcribe',
            id: 'speech-pack-self-test',
            files: {
              encoder: files['encoder.int8.onnx'],
              decoder: files['decoder.int8.onnx'],
              joiner: files['joiner.int8.onnx'],
              tokens: files['tokens.txt']
            },
            pcm
          })
        } else if (response.type === 'error') reject(new Error('Speech-pack utility host failed to start.'))
        return
      }
      if (response.type === 'error') {
        clearTimeout(startupTimer)
        startupTimer = undefined
        reject(new Error('Speech-pack recognition failed.'))
        return
      }
      if (response.type !== 'result' || response.id !== (whisper ? 1 : 'speech-pack-self-test')) return
      const text = typeof response.text === 'string' ? response.text.trim() : ''
      if (text.length < 2) reject(new Error('Speech-pack fixture produced no usable recognition text.'))
      else resolve(text)
    })
    if (whisper) {
      startupTimer = setTimeout(
        () => reject(new Error('Speech-pack utility host failed to start in time.')),
        START_TIMEOUT_MS
      )
      host.postMessage({ type: 'init', modelsPath: input.packDir, fetchedModelsPath: null, allowHighMemoryTier: false })
    } else {
      // The Parakeet host accepts a bounded warmup request so model loading is distinct from recognition.
      const files = Object.fromEntries(
        PARAKEET_TDT_V3_INT8.files.map((file) => [file.path, join(input.packDir, file.path)])
      )
      startupTimer = setTimeout(
        () => reject(new Error('Speech-pack utility host failed to start in time.')),
        START_TIMEOUT_MS
      )
      host.postMessage({
        type: 'warmup',
        id: 'speech-pack-startup',
        files: {
          encoder: files['encoder.int8.onnx'],
          decoder: files['decoder.int8.onnx'],
          joiner: files['joiner.int8.onnx'],
          tokens: files['tokens.txt']
        }
      })
    }
  })

  let failure: unknown
  let decoded: string | undefined
  try {
    decoded = await withTimeout(result, RECOGNITION_TIMEOUT_MS, input.signal)
    if (exitError) throw exitError
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(startupTimer)
    try {
      await stopHost(host, () => didExit)
    } catch (stopError) {
      if (!failure) failure = stopError
    }
  }
  if (failure) throw failure
  if (decoded === undefined) throw new Error('Speech-pack recognition returned no result.')
  return decoded
}
