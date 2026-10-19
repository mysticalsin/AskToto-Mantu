import { useCallback, useEffect, useRef, useState } from 'react'
import { acquireInteractiveMic, type InputMicAdmission } from './input-mic-admission'
import { COMMAND_SPEECH_WORKLET_SRC } from './command-speech-worklet-src'

export type CommandMicStatus = 'idle' | 'starting' | 'listening' | 'finalizing' | 'done' | 'error'
export type CommandMicStopReason =
  | 'cancelled'
  | 'timeout'
  | 'microphone_unavailable'
  | 'activation_required'
  | 'unsupported_engine'
  | 'policy_blocked'
  | 'no_speech'
  | 'recognition_unavailable'

export type CommandMicSnapshot = { status: CommandMicStatus; reason?: CommandMicStopReason }
export type CommandMicOptions = { maxDurationMs?: number; finalizationMs?: number }
type ControllerOptions = CommandMicOptions & { onSnapshot?: (snapshot: CommandMicSnapshot) => void }

type ActiveCapture = {
  admission: InputMicAdmission
  stopMedia: () => void
  sessionId: string
  stream: MediaStream
  track: MediaStreamTrack
  context: AudioContext
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  mute: GainNode
  timeout: ReturnType<typeof setTimeout>
  generation: number
  frameCount: number
  frameQueue: Promise<void>
  resolveSealed: (() => void) | null
  sealed: Promise<void>
  failed: boolean
  onTrackEnded: () => void
  finalizing: boolean
  mediaReleased: boolean
  mediaTeardown: Promise<void> | null
}

const DEFAULT_MAX_DURATION_MS = 8_000
const DEFAULT_FINALIZATION_MS = 1_500
const COMMAND_MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true }
}
let commandSpeechWorkletUrl: string | null = null
function workletUrl(): string {
  if (!commandSpeechWorkletUrl) {
    commandSpeechWorkletUrl = URL.createObjectURL(new Blob([COMMAND_SPEECH_WORKLET_SRC], { type: 'text/javascript' }))
  }
  return commandSpeechWorkletUrl
}

export class CommandMicController {
  private active: ActiveCapture | null = null
  private generation = 0
  private disposed = false
  private admissionAbort: AbortController | null = null
  private snapshot: CommandMicSnapshot = { status: 'idle' }
  private readonly maxDurationMs: number
  private readonly finalizationMs: number

  constructor(private readonly options: ControllerOptions = {}) {
    this.maxDurationMs = Math.min(
      DEFAULT_MAX_DURATION_MS,
      Math.max(1, Math.floor(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS))
    )
    this.finalizationMs = Math.max(0, Math.floor(options.finalizationMs ?? DEFAULT_FINALIZATION_MS))
  }

  getSnapshot(): CommandMicSnapshot {
    return this.snapshot
  }

  async start(): Promise<void> {
    if (this.disposed || this.active || this.snapshot.status === 'starting') return
    const generation = ++this.generation
    const abort = new AbortController()
    this.admissionAbort?.abort()
    this.admissionAbort = abort
    this.publish({ status: 'starting' })
    if (this.disposed || generation !== this.generation) return
    let capture: Awaited<ReturnType<typeof acquireInteractiveMic>> | null = null
    let sessionId: string | null = null
    let startedInMain = false
    let context: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let node: AudioWorkletNode | null = null
    let mute: GainNode | null = null
    try {
      const availability = await window.toto.commandMicAvailability()
      if (!availability.ok) throw new Error(availability.reason)
      if (!(await window.toto.commandMicActivationReady())) {
        const currentAvailability = await window.toto.commandMicAvailability().catch(() => availability)
        throw new Error(currentAvailability.ok ? 'activation_required' : currentAvailability.reason)
      }
      capture = await acquireInteractiveMic(COMMAND_MIC_CONSTRAINTS, 'command', 'deliberate-talk', abort.signal)
      sessionId = capture.admission.sessionId
      if (this.disposed || generation !== this.generation || capture.admission.revoked) throw new Error('cancelled')
      context = new AudioContext()
      await context.resume()
      if (context.state !== 'running') throw new Error('microphone_unavailable')
      await context.audioWorklet.addModule(workletUrl())
      if (this.disposed || generation !== this.generation || capture.admission.revoked) throw new Error('cancelled')
      source = context.createMediaStreamSource(capture.stream)
      node = new AudioWorkletNode(context, 'command-speech-worklet', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      })
      mute = context.createGain()
      mute.gain.value = 0
      const audioTracks =
        typeof capture.stream.getAudioTracks === 'function'
          ? capture.stream.getAudioTracks()
          : capture.stream.getTracks()
      const track = audioTracks[0]
      if (!track || track.readyState === 'ended') throw new Error('microphone_unavailable')
      // Build the full audio graph before starting Main's bounded capture deadline. Keep it
      // disconnected until Main accepts the exact lease so no first PCM frame can be lost.
      const start = await window.toto.commandSpeechStart(sessionId)
      if (!start.ok) throw new Error(start.reason)
      startedInMain = true
      if (this.disposed || generation !== this.generation || capture.admission.revoked) throw new Error('cancelled')
      let resolveSealed: (() => void) | null = null
      const sealed = new Promise<void>((resolve) => {
        resolveSealed = resolve
      })
      const active: ActiveCapture = {
        admission: capture.admission,
        stopMedia: capture.stopMedia,
        sessionId,
        stream: capture.stream,
        track,
        context,
        source,
        node,
        mute,
        timeout: setTimeout(() => {
          void this.finish(generation)
        }, this.maxDurationMs),
        generation,
        frameCount: 0,
        frameQueue: Promise.resolve(),
        resolveSealed,
        sealed,
        failed: false,
        onTrackEnded: () => this.cancelForGeneration(generation, 'microphone_unavailable'),
        finalizing: false,
        mediaReleased: false,
        mediaTeardown: null
      }
      this.active = active
      node.port.onmessage = (event: MessageEvent) => this.onWorkletMessage(active, event.data)
      capture.admission.onRevoke(() => this.cancelForGeneration(generation, 'microphone_unavailable'))
      track.addEventListener?.('ended', active.onTrackEnded, { once: true })
      const stillOwned = (): boolean =>
        this.active === active && !this.disposed && generation === this.generation && !active.admission.revoked
      const requireLiveTrack = (): void => {
        if (track.readyState === 'ended') throw new Error('microphone_unavailable')
      }
      if (!stillOwned()) return
      requireLiveTrack()
      source.connect(node)
      if (!stillOwned()) return
      requireLiveTrack()
      node.connect(mute)
      if (!stillOwned()) return
      requireLiveTrack()
      mute.connect(context.destination)
      if (!stillOwned()) return
      requireLiveTrack()
      if (this.admissionAbort === abort) this.admissionAbort = null
      this.publish({ status: 'listening' })
    } catch (error) {
      if (this.admissionAbort === abort) this.admissionAbort = null
      const reason = error instanceof Error ? error.message : ''
      if (startedInMain && sessionId) void window.toto.commandSpeechCancel(sessionId).catch(() => {})
      const active = this.active
      if (active?.generation === generation) this.release(active)
      else {
        try {
          node && ((node.port.onmessage = null), node.disconnect())
        } catch {
          /* continue cleanup */
        }
        try {
          source?.disconnect()
        } catch {
          /* continue cleanup */
        }
        try {
          mute?.disconnect()
        } catch {
          /* continue cleanup */
        }
        if (context && context.state !== 'closed') void context.close().catch(() => {})
        if (capture) {
          capture.stopMedia()
          await capture.admission.release().catch(() => {})
        }
      }
      if (this.disposed || generation !== this.generation) return
      const latestAvailability =
        reason === 'unauthorized' ? await window.toto.commandMicAvailability().catch(() => null) : null
      if (this.disposed || generation !== this.generation) return
      const mapped: CommandMicStopReason =
        reason === 'unsupported_engine' ||
        (latestAvailability?.ok === false && latestAvailability.reason === 'unsupported_engine')
          ? 'unsupported_engine'
          : reason === 'policy_blocked' ||
              (latestAvailability?.ok === false && latestAvailability.reason === 'policy_blocked')
            ? 'policy_blocked'
            : reason === 'activation_required' || reason === 'unauthorized'
              ? 'activation_required'
              : reason === 'recognition_unavailable'
                ? 'recognition_unavailable'
                : 'microphone_unavailable'
      this.publish({ status: 'error', reason: mapped })
    }
  }

  async finish(expectedGeneration?: number): Promise<void> {
    const active = this.active
    if (!active || active.finalizing || (expectedGeneration !== undefined && active.generation !== expectedGeneration))
      return
    active.finalizing = true
    clearTimeout(active.timeout)
    this.publish({ status: 'finalizing' })
    active.node.port.postMessage('seal')
    await Promise.race([active.sealed, new Promise<void>((resolve) => setTimeout(resolve, 750))])
    await active.frameQueue
    if (this.active !== active || active.failed || active.admission.revoked) {
      if (this.active === active) await this.cancelForGeneration(active.generation, 'recognition_unavailable')
      return
    }
    // The user has explicitly stopped and every sealed frame is now in Main. Stop the physical
    // microphone before local recognition starts; keep only the exact Main lease alive until its
    // final IPC resolves so revocation can still cancel the bounded in-memory PCM.
    await this.teardownMedia(active)
    if (this.active !== active || active.admission.revoked) return
    const result = await window.toto.commandSpeechFinish(active.sessionId, active.frameCount).catch(() => ({
      ok: false as const,
      reason: 'recognition_unavailable' as const
    }))
    if (this.active !== active) return
    this.release(active)
    if (!result.ok) {
      const reason: CommandMicStopReason =
        result.reason === 'unsupported_engine'
          ? 'unsupported_engine'
          : result.reason === 'policy_blocked'
            ? 'policy_blocked'
            : result.reason === 'no_speech'
              ? 'no_speech'
              : 'recognition_unavailable'
      this.publish({ status: 'error', reason })
      return
    }
    const generation = ++this.generation
    this.publish({ status: 'done' })
    setTimeout(() => {
      if (!this.disposed && this.generation === generation) this.publish({ status: 'idle' })
    }, this.finalizationMs)
  }

  async cancel(): Promise<void> {
    this.generation++
    this.admissionAbort?.abort()
    this.admissionAbort = null
    const active = this.active
    if (active) {
      void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
      this.release(active)
    }
    if (!this.disposed) this.publish({ status: 'idle', reason: 'cancelled' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.admissionAbort?.abort()
    this.admissionAbort = null
    const active = this.active
    if (active) {
      void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
      this.release(active)
    }
  }

  private onWorkletMessage(active: ActiveCapture, raw: unknown): void {
    if (this.active !== active || active.generation !== this.generation || !raw || typeof raw !== 'object') return
    const data = raw as { type?: unknown; sequence?: unknown; samples?: unknown }
    if (data.type === 'sealed') {
      active.resolveSealed?.()
      active.resolveSealed = null
      return
    }
    if (data.type === 'limit') {
      void this.finish(active.generation)
      return
    }
    if (data.type !== 'frame' || !(data.samples instanceof Float32Array) || !Number.isSafeInteger(data.sequence)) return
    const sequence = data.sequence as number
    active.frameCount++
    active.frameQueue = active.frameQueue
      .then(async () => {
        if (this.active !== active || active.failed) return
        const result = await window.toto.commandSpeechFrame(active.sessionId, sequence, data.samples as Float32Array)
        if (!result.ok) throw new Error(result.reason)
      })
      .catch(() => {
        active.failed = true
        void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
      })
  }

  private async cancelForGeneration(generation: number, reason: CommandMicStopReason): Promise<void> {
    const active = this.active
    if (active && active.generation === generation) {
      void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
      this.release(active)
    }
    if (!this.disposed && generation === this.generation) this.publish({ status: 'error', reason })
  }

  private release(active: ActiveCapture): void {
    if (this.active === active) this.active = null
    clearTimeout(active.timeout)
    active.resolveSealed?.()
    void this.teardownMedia(active)
    void active.admission.release()
  }

  private teardownMedia(active: ActiveCapture): Promise<void> {
    if (active.mediaTeardown) return active.mediaTeardown
    if (active.mediaReleased) return Promise.resolve()
    active.mediaReleased = true
    active.node.port.onmessage = null
    try {
      active.track.removeEventListener?.('ended', active.onTrackEnded)
    } catch {
      /* continue teardown */
    }
    try {
      active.node.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      active.source.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      active.mute.disconnect()
    } catch {
      /* already disconnected */
    }
    active.stopMedia()
    active.mediaTeardown =
      active.context.state !== 'closed' ? active.context.close().catch(() => {}) : Promise.resolve()
    return active.mediaTeardown
  }

  private publish(snapshot: CommandMicSnapshot): void {
    this.snapshot = snapshot
    this.options.onSnapshot?.(snapshot)
  }
}

export function useCommandMic(options: CommandMicOptions = {}): CommandMicSnapshot & {
  start: () => Promise<void>
  finish: () => Promise<void>
  cancel: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<CommandMicSnapshot>({ status: 'idle' })
  const controllerRef = useRef<CommandMicController | null>(null)
  if (!controllerRef.current) controllerRef.current = new CommandMicController({ ...options, onSnapshot: setSnapshot })
  const controller = controllerRef.current
  useEffect(() => () => controller.dispose(), [controller])
  return {
    ...snapshot,
    start: useCallback(() => controller.start(), [controller]),
    finish: useCallback(() => controller.finish(), [controller]),
    cancel: useCallback(() => controller.cancel(), [controller])
  }
}
