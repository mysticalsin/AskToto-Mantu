/**
 * Main-process Parakeet facade. Native sherpa/ONNX work is isolated in
 * parakeet-asr-host.ts so model construction and decode cannot stall Electron's
 * main loop or collide with another native ONNX runtime on Windows.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { mainLog } from './logger'
import {
  ASR_ASSETS_MISSING,
  PARAKEET_MODEL_NAME,
  ensureParakeetAssets,
  parakeetFilesReady,
  resolveParakeetDir
} from './asr-bundled-ensure'

const SAMPLE_RATE = 16_000
const MAX_SAMPLES = SAMPLE_RATE * 30
// The child serializes decode, so bound audio admitted across both its message queue and the parent.
// Two worst-case windows leave one queued behind one active without allowing an unbounded PCM backlog.
const MAX_QUEUED_PCM_BYTES = MAX_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2
const MAX_PENDING_REQUESTS = 16
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_EXIT_TIMEOUT_MS = 5_000

interface ModelFiles {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

interface HostResponse {
  type?: string
  id?: string
  text?: string
  message?: string
}

interface PendingRequest {
  resolve: (response: HostResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface HostGeneration {
  number: number
  child: UtilityProcess
  state: 'active' | 'releasing' | 'blocked'
  pending: Map<string, PendingRequest>
  termination: Promise<void> | null
  resolveTermination: (() => void) | null
  rejectTermination: ((error: Error) => void) | null
  exitTimer: NodeJS.Timeout | null
}

/** A bounded-capacity rejection. Callers may retry the same immutable audio window later. */
export class ParakeetBusyError extends Error {
  readonly code = 'PARAKEET_BUSY'

  constructor() {
    super('Parakeet is busy; retry this audio window.')
    this.name = 'ParakeetBusyError'
  }
}

let current: HostGeneration | null = null
let releaseGate: Promise<void> | null = null
let blockedRelease: { generation: HostGeneration; error: Error } | null = null
let nextGeneration = 1
let nextRequest = 1
let admittedPcmBytes = 0

function modelDir(): string {
  return resolveParakeetDir()
}

function modelFiles(): ModelFiles {
  const dir = modelDir()
  return {
    encoder: join(dir, 'encoder.int8.onnx'),
    decoder: join(dir, 'decoder.int8.onnx'),
    joiner: join(dir, 'joiner.int8.onnx'),
    tokens: join(dir, 'tokens.txt')
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function failPending(generation: HostGeneration, error: Error): void {
  for (const pending of generation.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  generation.pending.clear()
}

function finishTermination(generation: HostGeneration): void {
  if (generation.exitTimer) clearTimeout(generation.exitTimer)
  generation.exitTimer = null
  if (current === generation) current = null
  if (releaseGate === generation.termination) releaseGate = null
  if (blockedRelease?.generation === generation) blockedRelease = null
  generation.resolveTermination?.()
  generation.resolveTermination = null
  generation.rejectTermination = null
}

function handleExit(generation: HostGeneration, code: number | null): void {
  if (generation.state === 'active') {
    failPending(generation, new Error(`The Parakeet helper exited unexpectedly (code ${code ?? 'unknown'}).`))
    if (current === generation) current = null
    return
  }
  finishTermination(generation)
}

function spawnGeneration(): HostGeneration {
  const number = nextGeneration++
  const child = utilityProcess.fork(join(__dirname, 'parakeet-asr-host.js'), [], {
    serviceName: `metis-parakeet-asr-${number}`,
    stdio: 'pipe'
  })
  const generation: HostGeneration = {
    number,
    child,
    state: 'active',
    pending: new Map(),
    termination: null,
    resolveTermination: null,
    rejectTermination: null,
    exitTimer: null
  }
  child.stderr?.on('data', (chunk: Buffer) => mainLog.warn('[parakeet-host]', chunk.toString('utf8').trim()))
  child.stdout?.on('data', () => {})
  child.on('message', (message: unknown) => {
    const response = message as HostResponse
    if ((response?.type !== 'result' && response?.type !== 'error') || typeof response.id !== 'string') return
    const pending = generation.pending.get(response.id)
    if (!pending) return
    generation.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.type === 'result') pending.resolve(response)
    else pending.reject(new Error(response.message || 'Parakeet processing failed.'))
  })
  child.on('exit', (code) => handleExit(generation, code))
  current = generation
  return generation
}

async function activeGeneration(): Promise<HostGeneration> {
  const blockedBeforeWait = blockedRelease?.error
  if (blockedBeforeWait) throw blockedBeforeWait
  const gate = releaseGate
  if (gate) await gate
  // Read through a function so TypeScript does not incorrectly preserve its pre-await narrowing of
  // mutable process state. The exit-timeout callback can set this while the gate is being awaited.
  const blockedAfterWait = (() => blockedRelease?.error)()
  if (blockedAfterWait) throw blockedAfterWait
  if (current?.state === 'active') return current
  return spawnGeneration()
}

function terminateGeneration(generation: HostGeneration, pendingError: Error): Promise<void> {
  if (generation.termination) return generation.termination
  generation.state = 'releasing'
  failPending(generation, pendingError)
  generation.termination = new Promise<void>((resolve, reject) => {
    generation.resolveTermination = resolve
    generation.rejectTermination = reject
  })
  releaseGate = generation.termination
  generation.exitTimer = setTimeout(() => {
    if (generation.state !== 'releasing') return
    generation.state = 'blocked'
    const error = new Error('Could not confirm that the Parakeet helper exited; restart is blocked to prevent overlapping native recognizers.')
    blockedRelease = { generation, error }
    if (releaseGate === generation.termination) releaseGate = null
    generation.rejectTermination?.(error)
    generation.resolveTermination = null
    generation.rejectTermination = null
  }, DEFAULT_EXIT_TIMEOUT_MS)
  try {
    generation.child.kill()
  } catch (error) {
    mainLog.warn('[parakeet] helper termination request failed:', asError(error).message)
  }
  return generation.termination
}

async function requestHost(
  request: { type: 'probe' } | { type: 'warmup'; files: ModelFiles } | { type: 'transcribe'; files: ModelFiles; pcm: ArrayBuffer }
): Promise<HostResponse> {
  let generation = await activeGeneration()
  // activeGeneration crosses an async boundary. A release can begin before this continuation resumes;
  // never enqueue into that dying generation. Waiting on its exact exit also prevents two recognizers.
  while (generation.state !== 'active') generation = await activeGeneration()
  if (generation.pending.size >= MAX_PENDING_REQUESTS) throw new ParakeetBusyError()
  const id = `g${generation.number}:r${nextRequest++}`
  return new Promise<HostResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      generation.pending.delete(id)
      const error = new Error(`Parakeet ${request.type} timed out.`)
      reject(error)
      void terminateGeneration(generation, error).catch((terminationError) => {
        mainLog.error('[parakeet] timed-out helper did not exit:', asError(terminationError).message)
      })
    }, DEFAULT_REQUEST_TIMEOUT_MS)
    generation.pending.set(id, { resolve, reject, timer })
    try {
      generation.child.postMessage({ ...request, id })
    } catch (error) {
      generation.pending.delete(id)
      clearTimeout(timer)
      const failure = asError(error)
      reject(failure)
      void terminateGeneration(generation, failure).catch((terminationError) => {
        mainLog.error('[parakeet] failed helper did not exit:', asError(terminationError).message)
      })
    }
  })
}

/** True when all model files are present and are real weights, not an HTML error page. */
export function parakeetModelReady(): boolean {
  return parakeetFilesReady(modelDir())
}

/** Probe native addon availability in the helper without constructing model weights. */
export async function parakeetAddonError(): Promise<string | null> {
  try {
    await requestHost({ type: 'probe' })
    return null
  } catch (error) {
    return asError(error).message
  }
}

/** Ensure model assets and prewarm genuine weights in the isolated helper. */
export async function ensureParakeetModel(onProgress?: (pct: number) => void): Promise<void> {
  if (!parakeetModelReady()) await ensureParakeetAssets(onProgress)
  if (!parakeetModelReady()) throw new Error(ASR_ASSETS_MISSING)
  // Unit tests use tiny placeholder ONNX files. Never pass them into Ort, which
  // treats malformed protobufs as a process-fatal error in some builds.
  const encoder = modelFiles().encoder
  if (existsSync(encoder) && statSync(encoder).size > 1_024) {
    await requestHost({ type: 'warmup', files: modelFiles() })
  }
}

/** Transcribe one mono 16kHz Float32 PCM window. Empty text means genuine silence. */
export async function parakeetTranscribe(samples: Float32Array): Promise<string> {
  if (!(samples instanceof Float32Array)) throw new Error('Parakeet PCM must be Float32 samples.')
  if (samples.length > MAX_SAMPLES) throw new Error('Parakeet PCM is too large.')
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('Parakeet PCM samples must be finite.')
  }
  if (admittedPcmBytes + samples.byteLength > MAX_QUEUED_PCM_BYTES) {
    throw new ParakeetBusyError()
  }
  admittedPcmBytes += samples.byteLength
  try {
    // Reserve first, then clone. Rejected callers never allocate a second PCM buffer and are never
    // parked in an await queue that would retain their original audio indefinitely.
    const pcm = new Float32Array(samples).buffer
    const response = await requestHost({ type: 'transcribe', files: modelFiles(), pcm })
    return String(response.text ?? '').trim()
  } finally {
    admittedPcmBytes -= samples.byteLength
  }
}

/** Kill the exact helper generation and resolve only after Electron reports its exit. */
export async function parakeetRelease(): Promise<void> {
  if (blockedRelease) throw blockedRelease.error
  if (releaseGate) return releaseGate
  if (!current) return
  return terminateGeneration(current, new Error('Parakeet processing was cancelled.'))
}

export { PARAKEET_MODEL_NAME }
