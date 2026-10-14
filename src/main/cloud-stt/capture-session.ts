import { randomUUID } from 'node:crypto'
import {
  CloudSpeechCaptureCeilingAckSchema,
  CloudSpeechEpochTransitionAckSchema,
  type CloudSpeechCaptureCeilingAck,
  type CloudSpeechCaptureCeilingEvent,
  type CloudSpeechEpochTransitionAck,
  type CloudSpeechEpochTransitionEvent
} from '../../shared/cloud-speech'
import { scheduleCaptureDeadline, type CaptureDeadlineScheduler } from '../infra/scheduler/capture-deadline'
import type { SpeechTrack } from './broker-client'

export const CLOUD_SPEECH_CAPTURE_MAX_MS = 4 * 60 * 60 * 1_000
export const CLOUD_SPEECH_CAPTURE_MAX_SAMPLES = 230_400_000
export const CLOUD_SPEECH_HANDOFF_MAX_MS = 2_000

export type MainSpeechCapturePhase =
  | 'active'
  | 'closing-old'
  | 'awaiting-old-application'
  | 'opening-next'
  | 'awaiting-next-application'
  | 'finishing'
  | 'cancelled'
  | 'closed'

type ClosedStream = { track: SpeechTrack; previousEpoch: number; lastSequence: number }
type OpenedStream = ClosedStream & { nextEpoch: number }
type TransitionStreams = ClosedStream[] | OpenedStream[]

export type MainSpeechCaptureSessionOptions = {
  captureId: string
  captureGeneration: number
  tracks: readonly SpeechTrack[]
  startedAt: number
  maxDurationMs?: number
  monotonicNow?: () => number
  schedule?: CaptureDeadlineScheduler
}

type PendingReceipt = {
  event: CloudSpeechEpochTransitionEvent
  deadlineAt: number
  acknowledged: CloudSpeechEpochTransitionAck | null
  resolve: (applied: boolean) => void
  cancelTimer: () => void
}

type PendingCeiling = {
  event: CloudSpeechCaptureCeilingEvent
  deadlineAt: number
  acknowledged: CloudSpeechCaptureCeilingAck | null
  resolve: (applied: CloudSpeechCaptureCeilingAck | null) => void
  cancelTimer: () => void
}

export type PendingCaptureFrame = {
  track: SpeechTrack
  frame: unknown
  deadlineAt: number
  resolve: (result: unknown) => void
  cancelTimer: () => void
}

/** Bounded main-owned capture deadline and applied-transition receipt state. */
export class MainSpeechCaptureSession {
  readonly deadlineAt: number
  phase: MainSpeechCapturePhase = 'active'
  private transitionCounter = 0
  private pending: PendingReceipt | null = null
  private lastCompleted: CloudSpeechEpochTransitionAck | null = null
  private pendingCeiling: PendingCeiling | null = null
  private pendingCeilingPromise: Promise<CloudSpeechCaptureCeilingAck | null> | null = null
  private lastCeiling: CloudSpeechCaptureCeilingAck | null = null
  private readonly pendingFrames = new Map<SpeechTrack, PendingCaptureFrame>()
  private readonly monotonicNow: () => number
  private readonly schedule: CaptureDeadlineScheduler

  constructor(private readonly options: MainSpeechCaptureSessionOptions) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.schedule = options.schedule ?? scheduleCaptureDeadline
    this.deadlineAt = options.startedAt + (options.maxDurationMs ?? CLOUD_SPEECH_CAPTURE_MAX_MS)
  }

  beginTransition(
    stage: 'closed',
    streams: ClosedStream[],
    deadlineAt: number
  ): { event: CloudSpeechEpochTransitionEvent; applied: Promise<boolean> }
  beginTransition(
    stage: 'opened',
    streams: OpenedStream[],
    deadlineAt: number
  ): { event: CloudSpeechEpochTransitionEvent; applied: Promise<boolean> }
  beginTransition(
    stage: 'closed' | 'opened',
    streams: TransitionStreams,
    deadlineAt: number
  ): { event: CloudSpeechEpochTransitionEvent; applied: Promise<boolean> } {
    if (this.phase === 'cancelled' || this.phase === 'closed' || this.pending)
      throw new Error('speech transition is not available')
    if (!this.matchesOrderedTracks(streams) || deadlineAt <= this.monotonicNow())
      throw new Error('speech transition inventory or deadline is invalid')
    const transitionId = ++this.transitionCounter
    if (!Number.isSafeInteger(transitionId)) throw new Error('speech transition counter exhausted')
    const event = {
      type: 'epoch-transition' as const,
      captureId: this.options.captureId,
      captureGeneration: this.options.captureGeneration,
      transitionId,
      handoffNonce: randomUUID(),
      stage,
      streams
    } as CloudSpeechEpochTransitionEvent
    let resolve!: (applied: boolean) => void
    const applied = new Promise<boolean>((finish) => (resolve = finish))
    const remaining = Math.max(0, deadlineAt - this.monotonicNow())
    const pending: PendingReceipt = {
      event,
      deadlineAt,
      acknowledged: null,
      resolve,
      cancelTimer: () => undefined
    }
    pending.cancelTimer = this.schedule(() => {
      if (this.pending !== pending) return
      this.pending = null
      pending.resolve(false)
    }, remaining)
    this.pending = pending
    return { event, applied }
  }

  acknowledge(raw: unknown): boolean {
    const parsed = CloudSpeechEpochTransitionAckSchema.safeParse(raw)
    if (!parsed.success) return false
    const receipt = parsed.data
    if (this.sameReceipt(this.lastCompleted, receipt)) return true
    const pending = this.pending
    if (!pending || this.monotonicNow() >= pending.deadlineAt || !this.sameEvent(pending.event, receipt)) return false
    if (pending.acknowledged) return this.sameReceipt(pending.acknowledged, receipt)
    pending.acknowledged = receipt
    pending.cancelTimer()
    pending.resolve(true)
    return true
  }

  beginCeiling(
    maxSampleOffsetExclusive: number,
    deadlineAt: number
  ): { event: CloudSpeechCaptureCeilingEvent; applied: Promise<CloudSpeechCaptureCeilingAck | null> } {
    if (this.pendingCeiling && this.pendingCeilingPromise)
      return { event: this.pendingCeiling.event, applied: this.pendingCeilingPromise }
    if (this.lastCeiling || this.phase === 'cancelled' || this.phase === 'closed' || deadlineAt <= this.monotonicNow())
      throw new Error('capture ceiling is not available')
    const event: CloudSpeechCaptureCeilingEvent = {
      type: 'capture-ceiling',
      captureId: this.options.captureId,
      captureGeneration: this.options.captureGeneration,
      ceilingId: randomUUID(),
      maxSampleOffsetExclusive
    }
    let resolve!: (applied: CloudSpeechCaptureCeilingAck | null) => void
    const applied = new Promise<CloudSpeechCaptureCeilingAck | null>((finish) => (resolve = finish))
    const pending: PendingCeiling = {
      event,
      deadlineAt,
      acknowledged: null,
      resolve,
      cancelTimer: () => undefined
    }
    pending.cancelTimer = this.schedule(() => {
      if (this.pendingCeiling !== pending) return
      this.pendingCeiling = null
      this.pendingCeilingPromise = null
      pending.resolve(null)
    }, deadlineAt - this.monotonicNow())
    this.pendingCeiling = pending
    this.pendingCeilingPromise = applied
    return { event, applied }
  }

  acknowledgeCeiling(raw: unknown): boolean {
    const parsed = CloudSpeechCaptureCeilingAckSchema.safeParse(raw)
    if (!parsed.success) return false
    const receipt = parsed.data
    if (this.sameCeiling(this.lastCeiling, receipt)) return true
    const pending = this.pendingCeiling
    if (!pending || this.monotonicNow() >= pending.deadlineAt || !this.sameCeilingEvent(pending.event, receipt))
      return false
    if (pending.acknowledged) return this.sameCeiling(pending.acknowledged, receipt)
    pending.acknowledged = receipt
    pending.cancelTimer()
    pending.resolve(receipt)
    return true
  }

  completeCeiling(): void {
    const pending = this.pendingCeiling
    if (!pending?.acknowledged) throw new Error('capture ceiling was not applied')
    pending.cancelTimer()
    this.lastCeiling = pending.acknowledged
    this.pendingCeiling = null
    this.pendingCeilingPromise = null
  }

  reserveFrame(
    track: SpeechTrack,
    frame: unknown,
    deadlineAt: number,
    resolve: (result: unknown) => void,
    refusal: unknown,
    onExpired: () => void
  ): boolean {
    if (
      !this.options.tracks.includes(track) ||
      !['closing-old', 'awaiting-old-application', 'opening-next', 'awaiting-next-application'].includes(this.phase) ||
      this.pendingFrames.has(track) ||
      deadlineAt <= this.monotonicNow()
    )
      return false
    const pending: PendingCaptureFrame = {
      track,
      frame,
      deadlineAt,
      resolve,
      cancelTimer: () => undefined
    }
    pending.cancelTimer = this.schedule(() => {
      if (this.pendingFrames.get(track) !== pending) return
      this.pendingFrames.delete(track)
      pending.resolve(refusal)
      onExpired()
    }, deadlineAt - this.monotonicNow())
    this.pendingFrames.set(track, pending)
    return true
  }

  takePendingFrames(): PendingCaptureFrame[] {
    const frames = [...this.pendingFrames.values()]
    this.pendingFrames.clear()
    for (const frame of frames) frame.cancelTimer()
    return frames
  }

  failPendingFrames(refusal: unknown): void {
    for (const frame of this.takePendingFrames()) frame.resolve(refusal)
  }

  completeTransition(): void {
    const pending = this.pending
    if (!pending?.acknowledged) throw new Error('speech transition was not applied')
    pending.cancelTimer()
    this.lastCompleted = pending.acknowledged
    this.pending = null
  }

  invalidate(phase: 'cancelled' | 'closed' = 'cancelled', frameRefusal: unknown = { ok: false, code: 'CLOSED' }): void {
    const pending = this.pending
    const ceiling = this.pendingCeiling
    this.pending = null
    this.pendingCeiling = null
    this.pendingCeilingPromise = null
    pending?.cancelTimer()
    pending?.resolve(false)
    ceiling?.cancelTimer()
    ceiling?.resolve(null)
    this.failPendingFrames(frameRefusal)
    this.phase = phase
  }

  private matchesOrderedTracks(streams: TransitionStreams): boolean {
    return (
      streams.length === this.options.tracks.length &&
      streams.every((stream, index) => stream.track === this.options.tracks[index]) &&
      new Set(streams.map((stream) => stream.track)).size === streams.length
    )
  }

  private sameEvent(event: CloudSpeechEpochTransitionEvent, ack: CloudSpeechEpochTransitionAck): boolean {
    return (
      event.type === 'epoch-transition' &&
      event.captureId === ack.captureId &&
      event.captureGeneration === ack.captureGeneration &&
      event.transitionId === ack.transitionId &&
      event.handoffNonce === ack.handoffNonce &&
      event.stage === ack.stage &&
      JSON.stringify(event.streams) === JSON.stringify(ack.streams)
    )
  }

  private sameReceipt(left: CloudSpeechEpochTransitionAck | null, right: CloudSpeechEpochTransitionAck): boolean {
    return (
      left !== null &&
      left.captureId === right.captureId &&
      left.captureGeneration === right.captureGeneration &&
      left.transitionId === right.transitionId &&
      left.handoffNonce === right.handoffNonce &&
      left.stage === right.stage &&
      JSON.stringify(left.streams) === JSON.stringify(right.streams)
    )
  }

  private sameCeilingEvent(event: CloudSpeechCaptureCeilingEvent, ack: CloudSpeechCaptureCeilingAck): boolean {
    return (
      event.captureId === ack.captureId &&
      event.captureGeneration === ack.captureGeneration &&
      event.ceilingId === ack.ceilingId &&
      this.options.tracks.length === ack.tracks.length &&
      this.options.tracks.every((track, index) => ack.tracks[index]?.track === track)
    )
  }

  private sameCeiling(left: CloudSpeechCaptureCeilingAck | null, right: CloudSpeechCaptureCeilingAck): boolean {
    return left !== null && JSON.stringify(left) === JSON.stringify(right)
  }
}
