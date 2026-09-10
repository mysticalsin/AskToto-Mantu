/** Main-process facade for the isolated native speaker-embedding helper. */

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { mainLog } from './logger'
import {
  SPEAKER_EMBEDDING_DIMENSIONS,
  SPEAKER_MAX_SAMPLES,
  type SpeakerEmbeddingHostRequest,
  type SpeakerEmbeddingHostResponse,
  type SpeakerEmbeddingOwner
} from './speaker-embedding-protocol'

const MAX_QUEUED_PCM_BYTES = SPEAKER_MAX_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2
const MAX_PENDING_REQUESTS = 16
const REQUEST_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 5_000

interface PendingRequest {
  resolve(response: SpeakerEmbeddingHostResponse): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface AdmittedWork {
  done: Promise<void>
  finish(): void
}

interface Generation {
  number: number
  child: UtilityProcess
  state: 'active' | 'releasing' | 'blocked'
  pending: Map<string, PendingRequest>
  termination: Promise<void> | null
  resolveTermination: (() => void) | null
  rejectTermination: ((error: Error) => void) | null
  exitTimer: NodeJS.Timeout | null
}

export class SpeakerEmbeddingBusyError extends Error {
  readonly code = 'SPEAKER_EMBEDDING_BUSY'
  constructor() {
    super('Speaker embedding is busy; retry this audio window.')
    this.name = 'SpeakerEmbeddingBusyError'
  }
}

let current: Generation | null = null
let releaseGate: Promise<void> | null = null
let blockedRelease: { generation: Generation; error: Error } | null = null
let generationNumber = 1
let requestNumber = 1
let admittedPcmBytes = 0
let admittedRequests = 0
const ownerEpoch: Record<SpeakerEmbeddingOwner, number> = { live: 0, import: 0 }
const ownerAdmissionVersion: Record<SpeakerEmbeddingOwner, number> = { live: 0, import: 0 }
const admittedWorkByOwner: Record<SpeakerEmbeddingOwner, Set<AdmittedWork>> = {
  live: new Set(),
  import: new Set()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function failPending(generation: Generation, error: Error): void {
  for (const pending of generation.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  generation.pending.clear()
}

function finishTermination(generation: Generation): void {
  if (generation.exitTimer) clearTimeout(generation.exitTimer)
  generation.exitTimer = null
  if (current === generation) current = null
  if (releaseGate === generation.termination) releaseGate = null
  if (blockedRelease?.generation === generation) blockedRelease = null
  generation.resolveTermination?.()
  generation.resolveTermination = null
  generation.rejectTermination = null
}

function handleExit(generation: Generation, code: number | null): void {
  if (generation.state === 'active') {
    failPending(generation, new Error(`The speaker embedding helper exited unexpectedly (code ${code ?? 'unknown'}).`))
    if (current === generation) current = null
    return
  }
  finishTermination(generation)
}

function spawnGeneration(): Generation {
  const number = generationNumber++
  const child = utilityProcess.fork(join(__dirname, 'speaker-embedding-host.js'), [], {
    serviceName: `metis-speaker-embedding-${number}`,
    stdio: 'pipe'
  })
  const generation: Generation = {
    number,
    child,
    state: 'active',
    pending: new Map(),
    termination: null,
    resolveTermination: null,
    rejectTermination: null,
    exitTimer: null
  }
  child.stderr?.on('data', (chunk: Buffer) => mainLog.warn('[speaker-embedding-host]', chunk.toString('utf8').trim()))
  child.stdout?.on('data', () => {})
  child.on('message', (raw: unknown) => {
    const response = raw as SpeakerEmbeddingHostResponse
    if ((response?.type !== 'result' && response?.type !== 'error') || typeof response.id !== 'string') return
    const pending = generation.pending.get(response.id)
    if (!pending) return
    generation.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.type === 'result') pending.resolve(response)
    else pending.reject(new Error(response.message || 'Speaker embedding failed.'))
  })
  child.on('exit', (code) => handleExit(generation, code))
  current = generation
  return generation
}

function terminateGeneration(generation: Generation, error: Error): Promise<void> {
  if (generation.termination) return generation.termination
  generation.state = 'releasing'
  failPending(generation, error)
  generation.termination = new Promise<void>((resolve, reject) => {
    generation.resolveTermination = resolve
    generation.rejectTermination = reject
  })
  releaseGate = generation.termination
  generation.exitTimer = setTimeout(() => {
    if (generation.state !== 'releasing') return
    generation.state = 'blocked'
    const failure = new Error('Could not confirm that the speaker embedding helper exited; restart is blocked to prevent overlapping native extractors.')
    blockedRelease = { generation, error: failure }
    if (releaseGate === generation.termination) releaseGate = null
    generation.rejectTermination?.(failure)
    generation.resolveTermination = null
    generation.rejectTermination = null
  }, EXIT_TIMEOUT_MS)
  try {
    generation.child.kill()
  } catch (killError) {
    mainLog.warn('[speaker-embedding] helper termination request failed:', asError(killError).message)
  }
  return generation.termination
}

async function requestHost(
  request:
    | Omit<Extract<SpeakerEmbeddingHostRequest, { type: 'warmup' }>, 'id'>
    | Omit<Extract<SpeakerEmbeddingHostRequest, { type: 'embed' }>, 'id'>,
  owner: SpeakerEmbeddingOwner,
  admittedEpoch: number
): Promise<SpeakerEmbeddingHostResponse> {
  const blockedBeforeWait = blockedRelease?.error
  if (blockedBeforeWait) throw blockedBeforeWait
  const gate = releaseGate
  if (gate) await gate
  const blockedAfterWait = (() => blockedRelease?.error)()
  if (blockedAfterWait) throw blockedAfterWait
  if (ownerEpoch[owner] !== admittedEpoch) throw new Error('Speaker embedding processing was cancelled.')

  // No await between the epoch check, generation choice and pending-map insertion: release cannot race
  // a reserved request into an untracked fresh child on this single JS event loop.
  const generation = current?.state === 'active' ? current : spawnGeneration()
  const id = `g${generation.number}:r${requestNumber++}`
  return new Promise<SpeakerEmbeddingHostResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      generation.pending.delete(id)
      const failure = new Error(`Speaker embedding ${request.type} timed out.`)
      reject(failure)
      void terminateGeneration(generation, failure).catch((terminationError) => {
        mainLog.error('[speaker-embedding] timed-out helper did not exit:', asError(terminationError).message)
      })
    }, REQUEST_TIMEOUT_MS)
    generation.pending.set(id, { resolve, reject, timer })
    try {
      generation.child.postMessage({ ...request, id })
    } catch (error) {
      generation.pending.delete(id)
      clearTimeout(timer)
      const failure = asError(error)
      reject(failure)
      void terminateGeneration(generation, failure).catch((terminationError) => {
        mainLog.error('[speaker-embedding] failed helper did not exit:', asError(terminationError).message)
      })
    }
  })
}

async function admitted<T>(owner: SpeakerEmbeddingOwner, bytes: number, run: (epoch: number) => Promise<T>): Promise<T> {
  if (admittedRequests >= MAX_PENDING_REQUESTS || admittedPcmBytes + bytes > MAX_QUEUED_PCM_BYTES) {
    throw new SpeakerEmbeddingBusyError()
  }
  const epoch = ownerEpoch[owner]
  let finishWork = (): void => {}
  const work: AdmittedWork = {
    done: new Promise<void>((resolve) => { finishWork = resolve }),
    finish: () => finishWork()
  }
  admittedRequests++
  ownerAdmissionVersion[owner]++
  admittedPcmBytes += bytes
  admittedWorkByOwner[owner].add(work)
  try {
    return await run(epoch)
  } finally {
    admittedPcmBytes -= bytes
    admittedRequests--
    admittedWorkByOwner[owner].delete(work)
    work.finish()
  }
}

export async function speakerEmbeddingAvailable(
  model: string,
  owner: SpeakerEmbeddingOwner = 'live'
): Promise<boolean> {
  if (!model) return false
  try {
    await admitted(owner, 0, (epoch) => requestHost({ type: 'warmup', model }, owner, epoch))
    return true
  } catch (error) {
    if (error instanceof SpeakerEmbeddingBusyError) throw error
    return false
  }
}

export async function computeSpeakerEmbedding(
  model: string,
  samples: Float32Array,
  owner: SpeakerEmbeddingOwner = 'live'
): Promise<Float32Array | null> {
  if (!(samples instanceof Float32Array)) throw new Error('Speaker PCM must be Float32 samples.')
  if (samples.length > SPEAKER_MAX_SAMPLES) throw new Error('Speaker PCM is too large.')
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('Speaker PCM samples must be finite.')
  }
  // Immutable admission accounting: caller-owned views may be detached/resized while this awaits.
  const admittedBytes = samples.byteLength
  return admitted(owner, admittedBytes, async (epoch) => {
    // Reserve before this allocation. A busy caller never creates a second PCM buffer.
    const pcm = new Float32Array(samples).buffer
    const response = await requestHost({ type: 'embed', model, pcm }, owner, epoch)
    if (!(response.embedding instanceof ArrayBuffer)) throw new Error('Speaker helper returned no embedding.')
    const embedding = new Float32Array(response.embedding)
    if (embedding.length !== SPEAKER_EMBEDDING_DIMENSIONS) {
      throw new Error(`Speaker embedding must contain exactly ${SPEAKER_EMBEDDING_DIMENSIONS} values.`)
    }
    for (const value of embedding) {
      if (!Number.isFinite(value)) throw new Error('Speaker embedding values must be finite.')
    }
    return new Float32Array(embedding)
  })
}

/** Release this owner's use without killing a currently admitted request owned by the other path. */
export async function releaseSpeakerEmbedding(
  owner: SpeakerEmbeddingOwner
): Promise<'released' | 'superseded' | 'idle'> {
  ownerEpoch[owner]++
  const other: SpeakerEmbeddingOwner = owner === 'live' ? 'import' : 'live'
  const ownerVersion = ownerAdmissionVersion[owner]
  const otherVersion = ownerAdmissionVersion[other]
  const otherWorkAtRelease = [...admittedWorkByOwner[other]].map((work) => work.done)
  const hasNewOwner = (): boolean =>
    ownerAdmissionVersion[owner] !== ownerVersion || ownerAdmissionVersion[other] !== otherVersion
  // A shared native process cannot cancel only one request. Wait (bounded by the existing request/exit deadlines)
  // only for the other-owner work present at entry. Later admission belongs to a replacement consumer
  // and supersedes this teardown instead of extending its wait or being killed by it.
  await Promise.all(otherWorkAtRelease)
  if (hasNewOwner()) return 'superseded'
  if (blockedRelease) throw blockedRelease.error
  if (releaseGate) {
    await releaseGate
    return hasNewOwner() ? 'superseded' : 'released'
  }
  if (!current) return 'idle'
  await terminateGeneration(current, new Error('Speaker embedding processing was cancelled.'))
  return hasNewOwner() ? 'superseded' : 'released'
}
