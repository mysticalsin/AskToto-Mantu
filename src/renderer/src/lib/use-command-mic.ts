import { useCallback, useEffect, useRef, useState } from 'react'

export type CommandMicStatus = 'idle' | 'starting' | 'listening' | 'finalizing' | 'error'
export type CommandMicStopReason = 'cancelled' | 'timeout' | 'microphone_unavailable'

export type CommandMicSnapshot = {
  status: CommandMicStatus
  reason?: CommandMicStopReason
}

export type CommandMicOptions = {
  /** A command turn is short by design, so it cannot become another meeting recorder. */
  maxDurationMs?: number
  /** Allows a short, visible terminal state before the control returns to idle. */
  finalizationMs?: number
}

type CommandMicControllerOptions = CommandMicOptions & {
  onSnapshot?: (snapshot: CommandMicSnapshot) => void
}

type ActiveCapture = {
  stream: MediaStream
  timeout: ReturnType<typeof setTimeout>
  track: MediaStreamTrack | null
  onTrackEnded: (() => void) | null
}

const DEFAULT_MAX_DURATION_MS = 8_000
const DEFAULT_FINALIZATION_MS = 300
const COMMAND_MIC_CONSTRAINTS = {
  audio: {
    autoGainControl: true,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true
  }
} satisfies MediaStreamConstraints

function stopTracks(stream: MediaStream): void {
  let tracks: MediaStreamTrack[]
  try {
    tracks = stream.getTracks()
  } catch {
    return
  }
  for (const track of tracks) {
    try {
      track.stop()
    } catch {
      // Track teardown is best effort. A stopped device must never keep the command turn alive.
    }
  }
}

function trackIsEnded(track: MediaStreamTrack): boolean {
  return track.readyState === 'ended'
}

/**
 * A deliberately narrow microphone lease for an explicit command turn.
 *
 * It owns no recorder, ASR buffer, system-audio capture, or meeting state. Audio is not retained here:
 * the active MediaStream is released on every terminal path. A future main-owned command recognizer must
 * provide its own reviewed handoff rather than reaching into this renderer-only lease.
 */
export class CommandMicController {
  private active: ActiveCapture | null = null
  private finalizationTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private disposed = false
  private snapshot: CommandMicSnapshot = { status: 'idle' }
  private readonly maxDurationMs: number
  private readonly finalizationMs: number

  constructor(private readonly options: CommandMicControllerOptions = {}) {
    this.maxDurationMs = Math.max(1, Math.floor(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS))
    this.finalizationMs = Math.max(0, Math.floor(options.finalizationMs ?? DEFAULT_FINALIZATION_MS))
  }

  getSnapshot(): CommandMicSnapshot {
    return this.snapshot
  }

  async start(): Promise<void> {
    if (this.disposed || this.snapshot.status === 'starting' || this.active) return
    this.clearFinalizationTimer()
    const generation = ++this.generation
    this.publish({ status: 'starting' })

    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia(COMMAND_MIC_CONSTRAINTS)
      if (this.disposed || generation !== this.generation) {
        stopTracks(stream)
        return
      }
      // A real MediaStream exposes getAudioTracks(). Only test doubles without that API fall back to
      // getTracks(); an empty real audio list fails closed rather than treating any non-audio track as mic input.
      const audioTracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : stream.getTracks()
      const track = audioTracks[0] ?? null
      if (!track || trackIsEnded(track)) {
        stopTracks(stream)
        this.publish({ status: 'error', reason: 'microphone_unavailable' })
        return
      }
      const onTrackEnded = () => this.handleMicrophoneUnavailable(generation)
      const timeout = setTimeout(() => this.finish('timeout', generation), this.maxDurationMs)
      // Assign the active lease before registering the listener: some implementations can report an
      // already-ended device synchronously from addEventListener().
      this.active = { stream, timeout, track, onTrackEnded }
      if (typeof track.addEventListener === 'function') {
        track.addEventListener('ended', onTrackEnded)
      }
      if (this.disposed || generation !== this.generation || !this.active) return
      if (trackIsEnded(track)) {
        this.handleMicrophoneUnavailable(generation)
        return
      }
      this.publish({ status: 'listening' })
    } catch {
      if (this.active?.stream === stream) this.releaseActiveCapture()
      else if (stream) stopTracks(stream)
      if (this.disposed || generation !== this.generation) return
      this.publish({ status: 'error', reason: 'microphone_unavailable' })
    }
  }

  cancel(): void {
    if (this.snapshot.status === 'error') {
      this.generation++
      this.clearFinalizationTimer()
      this.publish({ status: 'idle' })
      return
    }
    this.finish('cancelled')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.clearFinalizationTimer()
    this.releaseActiveCapture()
  }

  private finish(reason: Extract<CommandMicStopReason, 'cancelled' | 'timeout'>, expectedGeneration?: number): void {
    if (expectedGeneration != null && expectedGeneration !== this.generation) return
    if (!this.active && this.snapshot.status !== 'starting' && this.snapshot.status !== 'listening') return
    const generation = ++this.generation
    this.releaseActiveCapture()
    if (this.disposed) return
    this.publish({ status: 'finalizing', reason })
    this.settleToIdle(generation)
  }

  private releaseActiveCapture(): void {
    const active = this.active
    this.active = null
    if (!active) return
    clearTimeout(active.timeout)
    if (active.track && active.onTrackEnded && typeof active.track.removeEventListener === 'function') {
      try {
        active.track.removeEventListener('ended', active.onTrackEnded)
      } catch {
        // A damaged track must not prevent stream teardown.
      }
    }
    stopTracks(active.stream)
  }

  private handleMicrophoneUnavailable(expectedGeneration: number): void {
    if (expectedGeneration !== this.generation || !this.active) return
    this.generation++
    this.releaseActiveCapture()
    if (!this.disposed) this.publish({ status: 'error', reason: 'microphone_unavailable' })
  }

  private settleToIdle(generation: number): void {
    this.clearFinalizationTimer()
    this.finalizationTimer = setTimeout(() => {
      this.finalizationTimer = null
      if (!this.disposed && generation === this.generation) this.publish({ status: 'idle' })
    }, this.finalizationMs)
  }

  private clearFinalizationTimer(): void {
    if (!this.finalizationTimer) return
    clearTimeout(this.finalizationTimer)
    this.finalizationTimer = null
  }

  private publish(snapshot: CommandMicSnapshot): void {
    this.snapshot = snapshot
    this.options.onSnapshot?.(snapshot)
  }
}

export function createCommandMicController(options: CommandMicOptions = {}): CommandMicController {
  return new CommandMicController(options)
}

/**
 * Renderer-only UI hook around an explicit microphone lease. It intentionally has no command-ingest,
 * execution, or meeting-audio capability.
 */
export function useCommandMic(options: CommandMicOptions = {}): CommandMicSnapshot & {
  start: () => Promise<void>
  cancel: () => void
} {
  const [snapshot, setSnapshot] = useState<CommandMicSnapshot>({ status: 'idle' })
  const controllerRef = useRef<CommandMicController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new CommandMicController({ ...options, onSnapshot: setSnapshot })
  }
  const controller = controllerRef.current

  useEffect(() => () => controller.dispose(), [controller])

  return {
    ...snapshot,
    start: useCallback(() => controller.start(), [controller]),
    cancel: useCallback(() => controller.cancel(), [controller])
  }
}
