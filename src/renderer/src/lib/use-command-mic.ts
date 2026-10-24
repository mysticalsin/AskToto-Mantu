import { useCallback, useEffect, useRef, useState } from 'react'
import { acquireInteractiveMic, type InputMicAdmission } from './input-mic-admission'
import { COMMAND_SPEECH_MAX_SECONDS } from '@shared/command-speech'
import { COMMAND_SPEECH_WORKLET_SRC } from './command-speech-worklet-src'
import {
  ConversationCaptureBeginSchema,
  ConversationCaptureFailureSchema,
  type ConversationAsk,
  type ConversationCaptureBegin,
  type ConversationCaptureBinding,
  type ConversationCaptureFailure,
  type ConversationSnapshot
} from '@shared/conversation/conversation-session'
import type { InputSessionContext, InputSessionResult } from '@shared/input-session'

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
  | 'device_missing'
  | 'device_lost'
  | 'device_busy'

export type CommandMicSnapshot = { status: CommandMicStatus; reason?: CommandMicStopReason }
export type CommandMicOptions = { maxDurationMs?: number; finalizationMs?: number }
/** `push-to-talk` is a voice turn whose activation main minted from the held chord; no click is involved. */
export type CommandMicStartOptions = {
  source?: 'deliberate-talk' | 'push-to-talk'
  /** Main chooses `dictation` for a held dictation chord (G22); the panel and voice turns are `command`. */
  purpose?: 'command' | 'dictation'
  /** An exact, main-issued listening window. This cannot be minted by the renderer. */
  conversation?: ConversationCaptureBegin
}
export type ConversationMicResult = { ok: true } | { ok: false; reason: ConversationCaptureFailure['reason'] }
/** Main's latest snapshot must still own the text and generation before a renderer ask is started. */
export function conversationAskMatchesSnapshot(
  message: ConversationAsk,
  snapshot: ConversationSnapshot | null
): boolean {
  return (
    !!snapshot?.active &&
    snapshot.sessionId === message.sessionId &&
    snapshot.replyGeneration === message.replyGeneration
  )
}
export function conversationCaptureMatches(
  begin: ConversationCaptureBegin,
  binding: ConversationCaptureBinding
): boolean {
  return begin.sessionId === binding.sessionId && begin.captureToken === binding.captureToken
}
type ConversationBridge = {
  startCapture(token: string, context: InputSessionContext): Promise<InputSessionResult>
  captureStart(begin: ConversationCaptureBegin): Promise<unknown>
  captureFrame(binding: ConversationCaptureBinding, sequence: number, samples: Float32Array): Promise<unknown>
  captureFinish(binding: ConversationCaptureBinding, frameCount: number): Promise<unknown>
  captureCancel(binding: ConversationCaptureBinding): Promise<unknown>
  reportCaptureFailure(failure: ConversationCaptureFailure): Promise<unknown>
}
function conversationBridge(): ConversationBridge {
  return (window.toto as typeof window.toto & { conversation: ConversationBridge }).conversation
}
const conversationBinding = (begin: ConversationCaptureBegin): ConversationCaptureBinding => ({
  sessionId: begin.sessionId,
  captureToken: begin.captureToken
})
function captureFailureReason(reason: CommandMicStopReason): ConversationCaptureFailure['reason'] {
  if (
    reason === 'device_missing' ||
    reason === 'device_lost' ||
    reason === 'device_busy' ||
    reason === 'policy_blocked' ||
    reason === 'no_speech' ||
    reason === 'recognition_unavailable' ||
    reason === 'microphone_unavailable'
  )
    return reason
  return reason === 'unsupported_engine' ? 'speech_unavailable' : 'not_ready'
}
function conversationResult(raw: unknown): ConversationMicResult {
  if (raw && typeof raw === 'object') {
    const value = raw as { ok?: unknown; reason?: unknown }
    if (value.ok === true && Object.keys(value).length === 1) return { ok: true }
    if (
      value.ok === false &&
      Object.keys(value).length === 2 &&
      ConversationCaptureFailureSchema.shape.reason.safeParse(value.reason).success
    )
      return { ok: false, reason: value.reason as ConversationCaptureFailure['reason'] }
  }
  return { ok: false, reason: 'recognition_unavailable' }
}
type ControllerOptions = CommandMicOptions & {
  onSnapshot?: (snapshot: CommandMicSnapshot) => void
  /**
   * The input device went away after speech was captured (G18). Awaited once, after the captured audio is sealed
   * and before it is sent for recognition, so the owner can move its own turn on. A rejection never drops audio.
   */
  onDeviceLostWithAudio?: () => Promise<unknown>
  /** Capture completion only; recognized text arrives separately from main's validated ask event. */
  onConversationResult?: (binding: ConversationCaptureBinding, result: ConversationMicResult) => void
}

type ActiveCapture = {
  admission: InputMicAdmission
  stopMedia: () => void
  sessionId: string
  conversation: ConversationCaptureBinding | null
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
/** The hard cap main enforces; a caller (the voice turn) may ask for up to this much, never more. */
export const COMMAND_MIC_HARD_MAX_DURATION_MS = COMMAND_SPEECH_MAX_SECONDS * 1_000
const DEFAULT_FINALIZATION_MS = 1_500
const COMMAND_MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true }
}
/**
 * What a failed getUserMedia means (G18): no input device, or another app holds it. A refusal (NotAllowedError)
 * and anything unknown stay with the microphone permission reason, which is where the guided Settings helper is.
 */
export function micFailureReason(error: unknown): CommandMicStopReason | null {
  const name = typeof (error as { name?: unknown } | null)?.name === 'string' ? (error as { name: string }).name : ''
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return 'device_missing'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'device_busy'
  return null
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
      COMMAND_MIC_HARD_MAX_DURATION_MS,
      Math.max(1, Math.floor(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS))
    )
    this.finalizationMs = Math.max(0, Math.floor(options.finalizationMs ?? DEFAULT_FINALIZATION_MS))
  }

  getSnapshot(): CommandMicSnapshot {
    return this.snapshot
  }

  async start(startOptions: CommandMicStartOptions = {}): Promise<void> {
    const begin = startOptions.conversation
    if (
      begin &&
      (!ConversationCaptureBeginSchema.safeParse(begin).success || startOptions.source || startOptions.purpose)
    )
      return
    const inputSource = begin ? 'push-to-talk' : (startOptions.source ?? 'deliberate-talk')
    const purpose = begin ? 'conversation' : (startOptions.purpose ?? 'command')
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
      const availability = begin ? null : await window.toto.commandMicAvailability()
      if (availability && !availability.ok) throw new Error(availability.reason)
      // A voice turn has no click to observe: main minted the activation from the held chord and consumes it
      // when the push-to-talk lease is requested below, refusing it if it is missing.
      if (!begin && inputSource !== 'push-to-talk' && !(await window.toto.commandMicActivationReady())) {
        const currentAvailability = await window.toto.commandMicAvailability().catch(() => availability)
        throw new Error(currentAvailability?.ok ? 'activation_required' : currentAvailability?.reason)
      }
      // A device change is not a revocation: speech already captured must still be recognized (G18).
      capture = await acquireInteractiveMic(COMMAND_MIC_CONSTRAINTS, purpose, inputSource, abort.signal, {
        conversationCaptureToken: begin?.captureToken,
        onDeviceChange: () => void this.deviceLost(generation)
      })
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
      if (!track) throw new Error('device_missing')
      if (track.readyState === 'ended') throw new Error('device_lost')
      // Build the full audio graph before starting Main's bounded capture deadline. Keep it
      // disconnected until Main accepts the exact lease so no first PCM frame can be lost.
      const start: unknown = begin
        ? await conversationBridge().captureStart(begin)
        : await window.toto.commandSpeechStart(sessionId)
      if (!start || typeof start !== 'object' || (start as { ok?: unknown }).ok !== true)
        throw new Error((start as { reason?: string } | null)?.reason ?? 'recognition_unavailable')
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
        conversation: begin ? conversationBinding(begin) : null,
        stream: capture.stream,
        track,
        context,
        source,
        node,
        mute,
        timeout: setTimeout(
          () => {
            void this.finish(generation)
          },
          begin ? Math.min(COMMAND_MIC_HARD_MAX_DURATION_MS, begin.maxMs) : this.maxDurationMs
        ),
        generation,
        frameCount: 0,
        frameQueue: Promise.resolve(),
        resolveSealed,
        sealed,
        failed: false,
        onTrackEnded: () => void this.deviceLost(generation),
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
        if (track.readyState === 'ended') throw new Error('device_lost')
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
      const message = error instanceof Error ? error.message : ''
      const reason = /^Microphone admission denied: unauthorized$/.test(message) ? 'unauthorized' : message
      const deviceReason =
        micFailureReason(error) ??
        (reason === 'device_lost' || reason === 'device_missing' ? (reason as CommandMicStopReason) : null)
      if (startedInMain && sessionId) {
        if (begin)
          void conversationBridge()
            .captureCancel(conversationBinding(begin))
            .catch(() => {})
        else void window.toto.commandSpeechCancel(sessionId).catch(() => {})
      }
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
                : (deviceReason ?? 'microphone_unavailable')
      this.publish({ status: 'error', reason: mapped })
      if (begin)
        void conversationBridge()
          .reportCaptureFailure({ ...conversationBinding(begin), reason: captureFailureReason(mapped) })
          .catch(() => {})
    }
  }

  async finish(expectedGeneration?: number): Promise<void> {
    return this.seal(expectedGeneration, false)
  }

  /** The device went away (track ended or the device list changed). Never reachable once sealing has begun. */
  private deviceLost(generation: number): Promise<void> {
    return this.seal(generation, true)
  }

  private async seal(expectedGeneration: number | undefined, deviceLost: boolean): Promise<void> {
    const active = this.active
    if (!active || active.finalizing || (expectedGeneration !== undefined && active.generation !== expectedGeneration))
      return
    active.finalizing = true
    clearTimeout(active.timeout)
    this.publish({ status: 'finalizing' })
    active.node.port.postMessage('seal')
    await Promise.race([active.sealed, new Promise<void>((resolve) => setTimeout(resolve, 750))])
    await active.frameQueue
    if (deviceLost && this.active === active && !active.failed && !active.admission.revoked) {
      // Accepted speech survives a device change: what was captured is still recognized. Only a device that went
      // away before anything was captured fails the turn, with its own reason.
      if (active.frameCount === 0) {
        await this.cancelForGeneration(active.generation, 'device_lost')
        return
      }
      await Promise.resolve()
        .then(() => this.options.onDeviceLostWithAudio?.())
        .catch(() => {})
    }
    if (this.active !== active || active.failed || active.admission.revoked) {
      if (this.active === active) await this.cancelForGeneration(active.generation, 'recognition_unavailable')
      return
    }
    // The user has explicitly stopped and every sealed frame is now in Main. Stop the physical
    // microphone before local recognition starts; keep only the exact Main lease alive until its
    // final IPC resolves so revocation can still cancel the bounded in-memory PCM.
    await this.teardownMedia(active)
    if (this.active !== active || active.admission.revoked) return
    const rawResult: unknown = active.conversation
      ? await conversationBridge()
          .captureFinish(active.conversation, active.frameCount)
          .catch(() => ({ ok: false, reason: 'recognition_unavailable' }))
      : await window.toto.commandSpeechFinish(active.sessionId, active.frameCount).catch(() => ({
          ok: false as const,
          reason: 'recognition_unavailable' as const
        }))
    if (this.active !== active) return
    const result = active.conversation
      ? conversationResult(rawResult)
      : (rawResult as Awaited<ReturnType<typeof window.toto.commandSpeechFinish>>)
    this.release(active)
    if (!result.ok) {
      const completedGeneration = this.generation
      const reason: CommandMicStopReason =
        result.reason === 'unsupported_engine'
          ? 'unsupported_engine'
          : result.reason === 'policy_blocked'
            ? 'policy_blocked'
            : result.reason === 'no_speech'
              ? 'no_speech'
              : 'recognition_unavailable'
      this.publish({ status: 'error', reason })
      if (active.conversation && !this.disposed && this.generation === completedGeneration) {
        try {
          this.options.onConversationResult?.(active.conversation, { ok: false, reason: captureFailureReason(reason) })
        } catch {
          /* owner callback cannot prevent cleanup */
        }
        void conversationBridge()
          .reportCaptureFailure({ ...active.conversation, reason: captureFailureReason(reason) })
          .catch(() => {})
      }
      return
    }
    const generation = ++this.generation
    this.publish({ status: 'done' })
    if (active.conversation && !this.disposed && this.generation === generation) {
      try {
        this.options.onConversationResult?.(active.conversation, result as ConversationMicResult)
      } catch {
        /* owner callback cannot prevent idle cleanup */
      }
    }
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
      if (active.conversation)
        void conversationBridge()
          .captureCancel(active.conversation)
          .catch(() => {})
      else void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
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
      if (active.conversation)
        void conversationBridge()
          .captureCancel(active.conversation)
          .catch(() => {})
      else void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
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
        const result: unknown = active.conversation
          ? await conversationBridge().captureFrame(active.conversation, sequence, data.samples as Float32Array)
          : await window.toto.commandSpeechFrame(active.sessionId, sequence, data.samples as Float32Array)
        if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true)
          throw new Error('recognition_unavailable')
      })
      .catch(() => {
        active.failed = true
        if (active.conversation)
          void conversationBridge()
            .captureCancel(active.conversation)
            .catch(() => {})
        else void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
      })
  }

  private async cancelForGeneration(generation: number, reason: CommandMicStopReason): Promise<void> {
    const active = this.active
    if (active && active.generation === generation) {
      if (active.conversation) {
        void conversationBridge()
          .captureCancel(active.conversation)
          .catch(() => {})
        void conversationBridge()
          .reportCaptureFailure({ ...active.conversation, reason: captureFailureReason(reason) })
          .catch(() => {})
      } else void window.toto.commandSpeechCancel(active.sessionId).catch(() => {})
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
