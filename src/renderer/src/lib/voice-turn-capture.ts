/**
 * Renderer side of a voice turn (V02). Headless: it renders nothing and opens no microphone on its own.
 *
 * Main owns the turn and pushes `begin` (after minting a hardware activation) and `end`. This module only turns
 * those into the ordinary command capture: a push-to-talk lease with the command purpose, the same worklet and
 * the same frame path as the Cmd+Shift+M panel, never the meeting pipeline. It reports only that the capture
 * started or failed to; a report can move the current turn toward failure and nothing else.
 */
import {
  VOICE_REPORT_REASONS,
  commandMicReasonToVoice,
  type VoiceBegin,
  type VoiceEnd,
  type VoiceReport
} from '@shared/voice/voice-turn'
import { CommandMicController, type CommandMicSnapshot, type CommandMicStartOptions } from './use-command-mic'

interface TurnController {
  start(options?: CommandMicStartOptions): Promise<void>
  finish(): Promise<void>
  cancel(): Promise<void>
  dispose(): void
}

export interface VoiceTurnCaptureDeps {
  onBegin(listener: (payload: VoiceBegin) => void): () => void
  onEnd(listener: (payload: VoiceEnd) => void): () => void
  report(report: VoiceReport): Promise<unknown>
  createController(options: {
    maxDurationMs: number
    onSnapshot: (snapshot: CommandMicSnapshot) => void
    onDeviceLostWithAudio?: () => Promise<unknown>
  }): TurnController
}

interface Turn {
  readonly id: string
  controller: TurnController | null
  status: CommandMicSnapshot['status']
  endRequested: boolean
  sealed: boolean
  /** The device went away after speech was captured and main was told to recognize it (G18). */
  deviceSealed: boolean
}

type ReportReason = Extract<VoiceReport, { phase: 'failed' }>['reason']

/** The one vocabulary: a command microphone stop reason, if main accepts it from the renderer. */
function reportReason(reason: CommandMicSnapshot['reason']): ReportReason | null {
  const voice = commandMicReasonToVoice(reason)
  return voice !== null && (VOICE_REPORT_REASONS as readonly string[]).includes(voice) ? (voice as ReportReason) : null
}

function defaultDeps(): VoiceTurnCaptureDeps {
  const bridge = window.toto.voiceActions
  return {
    onBegin: bridge.onBegin,
    onEnd: bridge.onEnd,
    report: bridge.report,
    createController: (options) => new CommandMicController(options)
  }
}

/** Subscribe to main's voice turn pushes. Returns the uninstall function. */
export function installVoiceTurnCapture(deps: VoiceTurnCaptureDeps = defaultDeps()): () => void {
  let current: Turn | null = null

  const report = (value: VoiceReport): void => {
    void deps.report(value).catch(() => {
      /* main's own watchdog ends a turn that never hears back */
    })
  }
  const retire = (turn: Turn, cancel: boolean): void => {
    if (current === turn) current = null
    if (cancel) void turn.controller?.cancel().catch(() => {})
    turn.controller?.dispose()
  }
  const finish = (turn: Turn): void => {
    if (turn.sealed) return
    turn.sealed = true
    void turn.controller?.finish().catch(() => {})
  }
  const onSnapshot = (turn: Turn, snapshot: CommandMicSnapshot): void => {
    if (current !== turn) return
    turn.status = snapshot.status
    if (snapshot.status === 'listening') {
      report({ turnId: turn.id, phase: 'capturing' })
      if (turn.endRequested) finish(turn)
      return
    }
    if (snapshot.status === 'error') {
      // After the person's release main hears the recognition result itself. After a device-changed seal it does
      // too, but a failure on the capture side (a frame that never arrived) would leave it waiting: report it.
      const reason = turn.sealed && !turn.deviceSealed ? null : reportReason(snapshot.reason)
      if (reason) report({ turnId: turn.id, phase: 'failed', reason })
      retire(turn, false)
      return
    }
    if (snapshot.status === 'done') retire(turn, false)
  }

  const offBegin = deps.onBegin((payload) => {
    if (current) retire(current, true)
    const turn: Turn = {
      id: payload.turnId,
      controller: null,
      status: 'idle',
      endRequested: false,
      sealed: false,
      deviceSealed: false
    }
    const controller = deps.createController({
      maxDurationMs: payload.maxMs,
      onSnapshot: (snapshot) => onSnapshot(turn, snapshot),
      onDeviceLostWithAudio: async () => {
        // Accepted speech survives a device change: main treats the turn as released and waits for recognition.
        if (current !== turn || turn.deviceSealed) return
        turn.sealed = true
        turn.deviceSealed = true
        await deps.report({ turnId: turn.id, phase: 'device_changed' })
      }
    })
    turn.controller = controller
    current = turn
    void controller.start({ source: 'push-to-talk' }).catch(() => {})
  })
  const offEnd = deps.onEnd((payload) => {
    const turn = current
    if (!turn || turn.id !== payload.turnId) return
    if (payload.cancelled) {
      retire(turn, true)
      return
    }
    if (turn.status === 'listening') finish(turn)
    else if (turn.status === 'starting' || turn.status === 'idle') turn.endRequested = true
  })

  return () => {
    offBegin()
    offEnd()
    if (current) retire(current, true)
  }
}
