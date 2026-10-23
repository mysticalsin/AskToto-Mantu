import { COMMAND_SPEECH_MAX_SECONDS } from '@shared/command-speech'
import type { TrustedInputOwner } from '@shared/input-session'

export const COMMAND_SPEECH_SAMPLE_RATE = 16_000
export const COMMAND_SPEECH_MAX_SAMPLES = COMMAND_SPEECH_SAMPLE_RATE * COMMAND_SPEECH_MAX_SECONDS
export const COMMAND_SPEECH_MAX_FRAME_SAMPLES = 2_048
export const COMMAND_SPEECH_MAX_FRAMES = Math.ceil(COMMAND_SPEECH_MAX_SAMPLES / COMMAND_SPEECH_MAX_FRAME_SAMPLES)
/** The cap plus two seconds for the final seal and the last frames still in flight. */
const COMMAND_SPEECH_MAX_AGE_MS = COMMAND_SPEECH_MAX_SECONDS * 1_000 + 2_000
const COMMAND_SPEECH_FINALIZATION_TIMEOUT_MS = 125_000

export type CommandSpeechResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'stale' | 'invalid' | 'no_speech' | 'recognition_unavailable' }

interface Capture {
  readonly owner: TrustedInputOwner
  readonly sessionId: string
  readonly generation: number
  readonly deadline: number
  chunks: Float32Array[]
  nextSequence: number
  totalSamples: number
  finalizing: boolean
  pcm: Float32Array | null
  timer: ReturnType<typeof setTimeout>
}

export class CommandSpeechCapture {
  #capture: Capture | null = null
  #generation = 0

  constructor(
    private readonly options: {
      isCurrent: (owner: TrustedInputOwner, sessionId: string) => boolean
      transcribe: (samples: Float32Array) => Promise<string>
      ingestTranscript: (text: string) => void
      /** G34: the gesture began (main-minted owner and session). Main binds what is in front right now. */
      onStarted?: (owner: TrustedInputOwner, sessionId: string) => void
      onExpired?: (sessionId: string) => void
      /** Every finish outcome, exactly what the renderer is told, after any transcript was ingested. */
      onFinished?: (sessionId: string, result: CommandSpeechResult) => void
      now?: () => number
    }
  ) {}

  start(owner: TrustedInputOwner, sessionId: string): CommandSpeechResult {
    if (this.#capture) return { ok: false, reason: 'busy' }
    if (!this.options.isCurrent(owner, sessionId)) return { ok: false, reason: 'stale' }
    const generation = ++this.#generation
    const capture: Capture = {
      owner: Object.freeze({ ...owner }),
      sessionId,
      generation,
      deadline: (this.options.now ?? Date.now)() + COMMAND_SPEECH_MAX_AGE_MS,
      chunks: [],
      nextSequence: 0,
      totalSamples: 0,
      finalizing: false,
      pcm: null,
      timer: setTimeout(() => {
        this.options.onExpired?.(sessionId)
        if (this.#capture === capture) this.#clear(capture)
      }, COMMAND_SPEECH_MAX_AGE_MS)
    }
    this.#capture = capture
    try {
      this.options.onStarted?.(capture.owner, sessionId)
    } catch {
      /* the binding is best effort: without one a task is simply not constrained by a gesture */
    }
    return { ok: true }
  }

  frame(owner: TrustedInputOwner, sessionId: string, sequence: number, rawSamples: unknown): CommandSpeechResult {
    const capture = this.#capture
    if (!capture || capture.sessionId !== sessionId || !this.#sameOwner(capture.owner, owner)) {
      return { ok: false, reason: 'stale' }
    }
    if (
      capture.finalizing ||
      capture.generation !== this.#generation ||
      (this.options.now ?? Date.now)() > capture.deadline ||
      !this.options.isCurrent(owner, sessionId)
    ) {
      this.#clear(capture)
      return { ok: false, reason: 'stale' }
    }
    if (
      !Number.isSafeInteger(sequence) ||
      sequence !== capture.nextSequence ||
      sequence >= COMMAND_SPEECH_MAX_FRAMES ||
      !(rawSamples instanceof Float32Array) ||
      rawSamples.length < 1 ||
      rawSamples.length > COMMAND_SPEECH_MAX_FRAME_SAMPLES ||
      capture.totalSamples + rawSamples.length > COMMAND_SPEECH_MAX_SAMPLES
    ) {
      this.#clear(capture)
      return { ok: false, reason: 'invalid' }
    }
    const copy = new Float32Array(rawSamples.length)
    for (let i = 0; i < rawSamples.length; i++) {
      const sample = rawSamples[i]!
      if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
        this.#clear(capture)
        return { ok: false, reason: 'invalid' }
      }
      copy[i] = sample
    }
    capture.chunks.push(copy)
    capture.nextSequence++
    capture.totalSamples += copy.length
    return { ok: true }
  }

  async finish(owner: TrustedInputOwner, sessionId: string, frameCount: number): Promise<CommandSpeechResult> {
    const result = await this.#finish(owner, sessionId, frameCount)
    try {
      this.options.onFinished?.(sessionId, result)
    } catch {
      /* an observer never changes what the renderer is told */
    }
    return result
  }

  async #finish(owner: TrustedInputOwner, sessionId: string, frameCount: number): Promise<CommandSpeechResult> {
    const capture = this.#capture
    if (!capture || capture.sessionId !== sessionId || !this.#sameOwner(capture.owner, owner))
      return { ok: false, reason: 'stale' }
    if (
      capture.finalizing ||
      capture.generation !== this.#generation ||
      (this.options.now ?? Date.now)() > capture.deadline ||
      !Number.isSafeInteger(frameCount) ||
      frameCount !== capture.nextSequence ||
      !this.options.isCurrent(owner, sessionId)
    ) {
      this.#clear(capture)
      return { ok: false, reason: 'stale' }
    }
    if (capture.totalSamples < 1) {
      this.#clear(capture)
      return { ok: false, reason: 'invalid' }
    }
    capture.finalizing = true
    clearTimeout(capture.timer)
    capture.timer = setTimeout(() => {
      this.options.onExpired?.(sessionId)
      if (this.#capture === capture) this.#clear(capture)
    }, COMMAND_SPEECH_FINALIZATION_TIMEOUT_MS)
    const pcm = new Float32Array(capture.totalSamples)
    let offset = 0
    for (const chunk of capture.chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
      chunk.fill(0)
    }
    capture.chunks = []
    capture.pcm = pcm
    try {
      const text = await this.options.transcribe(pcm)
      if (
        this.#capture !== capture ||
        capture.generation !== this.#generation ||
        !this.options.isCurrent(owner, sessionId)
      ) {
        if (this.#capture === capture) this.#clear(capture)
        return { ok: false, reason: 'stale' }
      }
      const normalized = typeof text === 'string' ? text.trim() : ''
      if (!normalized) {
        this.#clear(capture)
        return { ok: false, reason: 'no_speech' }
      }
      this.options.ingestTranscript(normalized)
      this.#clear(capture)
      return { ok: true }
    } catch {
      this.#clear(capture)
      return { ok: false, reason: 'recognition_unavailable' }
    }
  }

  cancel(owner: TrustedInputOwner, sessionId: string): CommandSpeechResult {
    const capture = this.#capture
    if (!capture || capture.sessionId !== sessionId || !this.#sameOwner(capture.owner, owner))
      return { ok: false, reason: 'stale' }
    this.#clear(capture)
    return { ok: true }
  }

  cancelForLease(sessionId: string): void {
    if (this.#capture?.sessionId === sessionId) this.#clear(this.#capture)
  }

  cancelAll(): void {
    if (this.#capture) this.#clear(this.#capture)
  }

  #clear(capture: Capture): void {
    clearTimeout(capture.timer)
    for (const chunk of capture.chunks) chunk.fill(0)
    capture.chunks = []
    capture.pcm?.fill(0)
    capture.pcm = null
    capture.totalSamples = 0
    // A delayed completion from an older capture still owns its buffers and must zero them, but it
    // must not advance the shared generation and invalidate a newer capture that has since started.
    if (this.#capture === capture) {
      this.#capture = null
      this.#generation++
    }
  }

  #sameOwner(a: TrustedInputOwner, b: TrustedInputOwner): boolean {
    return (
      a.webContentsId === b.webContentsId &&
      a.frameId === b.frameId &&
      a.isTopFrame === b.isTopFrame &&
      a.authSessionGeneration === b.authSessionGeneration &&
      a.contextRevision === b.contextRevision
    )
  }
}
