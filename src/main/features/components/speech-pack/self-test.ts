import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireManagedUtilityHost,
  type UtilityHostFork,
  type UtilityHostPort
} from '../../../infra/process/speech-pack-host'
import { PARAKEET_TDT_V3_INT8, SELF_TEST_FIXTURE, WHISPER_BASE_Q8, type SpeechPackComponentId } from './manifest'

const START_TIMEOUT_MS = 30_000
const RECOGNITION_TIMEOUT_MS = 120_000
const TEARDOWN_TIMEOUT_MS = 5_000
const MAX_FIXTURE_SAMPLES = 16_000 * 30
// Published output for the exact sherpa-onnx Parakeet v3 test_wavs/en.wav fixture.
// Source: k2-fsa/sherpa-onnx docs commit c02f72ca1540163a54019e845127fa52d5de175b.
const FIXTURE_TRANSCRIPT = 'ask not what your country can do for you ask what you can do for your country'

export function recognitionMatchesFixture(value: string): boolean {
  if (value.length > 1024) return false
  const expected = FIXTURE_TRANSCRIPT.split(' ')
  const actual = value.toLowerCase().match(/[a-z0-9]+/g) ?? []
  if (actual.length > 128) return false
  let previous = new Uint8Array(expected.length + 1)
  for (const actualWord of actual) {
    const current = new Uint8Array(expected.length + 1)
    for (let index = 1; index <= expected.length; index++) {
      current[index] =
        actualWord === expected[index - 1] ? previous[index - 1] + 1 : Math.max(previous[index], current[index - 1])
    }
    previous = current
  }
  return previous[expected.length] === expected.length
}

type HostPort = UtilityHostPort
export type SpeechPackHostFork = UtilityHostFork

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

export async function readPinnedFixtureFile(path: string, pin: { bytes: number; sha256: string }): Promise<Buffer> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch {
    throw new Error('Speech-pack self-test fixture does not match its pin.')
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== pin.bytes) {
    throw new Error('Speech-pack self-test fixture does not match its pin.')
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== pin.bytes ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error('Speech-pack self-test fixture does not match its pin.')
    }
    const bytes = Buffer.alloc(pin.bytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat()
    const afterPath = await lstat(path)
    if (
      offset !== pin.bytes ||
      after.size !== pin.bytes ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== pin.bytes
    ) {
      throw new Error('Speech-pack self-test fixture does not match its pin.')
    }
    const result = bytes.subarray(0, offset)
    if (createHash('sha256').update(result).digest('hex') !== pin.sha256) {
      throw new Error('Speech-pack self-test fixture does not match its pin.')
    }
    return result
  } catch {
    throw new Error('Speech-pack self-test fixture does not match its pin.')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Internal protocol seam for lifecycle tests; production verifies the pinned fixture first. */
export async function runSpeechPackHostProtocol(input: {
  componentId: SpeechPackComponentId
  packDir: string
  pcm: ArrayBuffer
  signal: AbortSignal
  fork?: SpeechPackHostFork
  startupTimeoutMs?: number
  recognitionTimeoutMs?: number
  teardownTimeoutMs?: number
}): Promise<string> {
  const whisper = input.componentId === WHISPER_BASE_Q8.id
  const teardownTimeoutMs = input.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS
  const entry = speechPackHostEntryPath(__dirname, input.componentId)
  const lease = await acquireManagedUtilityHost({
    path: entry,
    serviceName: `metis-speech-pack-check-${input.componentId.replace(/[^a-z0-9-]/gi, '-')}`,
    fork: input.fork,
    signal: input.signal,
    waitForExitMs: teardownTimeoutMs
  })
  const host = lease.host
  host.stderr?.on('data', () => undefined)
  host.stdout?.on('data', () => undefined)
  let exitError: Error | null = null
  let didExit = false
  let rejectResult: ((reason?: unknown) => void) | null = null
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  host.on('exit', (code) => {
    didExit = true
    if (code !== 0) exitError = new Error('Speech-pack utility host exited before the self-test completed.')
    rejectResult?.(exitError ?? new Error('Speech-pack utility host exited before the self-test completed.'))
  })

  const result = new Promise<string>((resolve, reject) => {
    rejectResult = reject
    if (input.signal.aborted) {
      reject(new Error('Speech-pack self-test was cancelled.'))
      return
    }
    let sent = false
    host.on('message', (raw) => {
      const msg = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data?: unknown }).data : raw
      if (!msg || typeof msg !== 'object') return
      const response = msg as { type?: string; id?: string | number; text?: unknown; message?: unknown }
      if (whisper && response.type === 'ready' && !sent) {
        clearTimeout(startupTimer)
        startupTimer = undefined
        sent = true
        host.postMessage({ type: 'transcribe', id: 1, pcm: input.pcm })
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
            pcm: input.pcm
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
      if (!recognitionMatchesFixture(text))
        reject(new Error('Speech-pack fixture recognition did not match its phrase.'))
      else resolve(text)
    })
    if (whisper) {
      startupTimer = setTimeout(
        () => reject(new Error('Speech-pack utility host failed to start in time.')),
        input.startupTimeoutMs ?? START_TIMEOUT_MS
      )
      host.postMessage({ type: 'init', modelsPath: input.packDir, fetchedModelsPath: null, allowHighMemoryTier: false })
    } else {
      // The Parakeet host accepts a bounded warmup request so model loading is distinct from recognition.
      const files = Object.fromEntries(
        PARAKEET_TDT_V3_INT8.files.map((file) => [file.path, join(input.packDir, file.path)])
      )
      startupTimer = setTimeout(
        () => reject(new Error('Speech-pack utility host failed to start in time.')),
        input.startupTimeoutMs ?? START_TIMEOUT_MS
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
    decoded = await withTimeout(result, input.recognitionTimeoutMs ?? RECOGNITION_TIMEOUT_MS, input.signal)
    if (exitError) throw exitError
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(startupTimer)
    try {
      await lease.stop(teardownTimeoutMs)
    } catch (stopError) {
      if (!failure) failure = stopError
    }
  }
  if (failure) throw failure
  if (decoded === undefined) throw new Error('Speech-pack recognition returned no result.')
  return decoded
}

/** Run the existing isolated recognizer against the pinned fixture. No transcript is returned to the caller. */
export async function runSpeechPackSelfTest(input: {
  componentId: SpeechPackComponentId
  packDir: string
  wavPath: string
  signal: AbortSignal
  fork?: SpeechPackHostFork
}): Promise<string> {
  const wav = await readPinnedFixtureFile(input.wavPath, SELF_TEST_FIXTURE)
  return runSpeechPackHostProtocol({
    componentId: input.componentId,
    packDir: input.packDir,
    pcm: parseFixturePcm(wav),
    signal: input.signal,
    fork: input.fork
  })
}
