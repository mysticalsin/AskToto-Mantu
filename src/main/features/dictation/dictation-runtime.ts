/**
 * Dictation runtime (G22): the wiring between the dictation session and the rest of main.
 *
 * The voice actions runtime builds one of these from its own deps and calls the same hooks it calls on the voice
 * session (start, refresh, sign-in, hard stop, meeting, renderer reset, speech finished, transcript, report,
 * dispose), so index.ts gains nothing. Dictation has its own chord on its own supervised watcher (the V01 recognizer
 * and helper, a second instance), its own hardware activation kind, its own lease purpose and never the meeting
 * pipeline. This module never opens a microphone: it mints main's own activation and tells the renderer which turn
 * to capture.
 */
import { randomUUID } from 'node:crypto'
import type { CommandMicAvailabilityResult, CommandSpeechResult } from '@shared/command-speech'
import type { InputSessionLease, InputSessionStopReason } from '@shared/input-session'
import { resolveDictationChordMask, resolveDictationEnabled, resolveDictationLatch } from '@shared/dictation-options'
import type { VoiceActionsSettings } from '@shared/voice-actions-settings'
import { VOICE_ACTIONS_IPC, type VoiceReport } from '@shared/voice/voice-turn'
import type { InputSessionAuthority } from '../../input-session-authority'
import { auditLog } from '../../logger'
import type { ChordWatcherEvent } from '../../voice/chord-watcher'
import { createVoiceChordWiring, type VoiceChordWiring } from '../../voice/chord-wiring'
import { createMacDictationPorts } from './dictation-insert-mac'
import { currentDictationMemory } from './dictation-memory-registry'
import type { DictationMemory, DictationMemorySink } from './dictation-memory'
import { UNSUPPORTED_DICTATION_PORTS, type DictationHostPorts } from './dictation-ports'
import { DictationSession, type DictationAuditPhase, type DictationSnapshot } from './dictation-session'

interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

export interface DictationRuntimeDeps {
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform
  /** The QA-identity build: dictation is ON by default there and OFF (Preview) in release builds. */
  qaIdentity: boolean
  /** The stored settings; `voiceActions.dictation` has the managed policy already overlaid by the store. */
  getSettings(): { voiceActions?: VoiceActionsSettings }
  requireAuth(): boolean
  authority: Pick<InputSessionAuthority, 'activeLease' | 'hasMeetingReservation' | 'hardStop'>
  /** Mints and revokes the `hardware-dictation` activation from main's own window frame (never a renderer value). */
  activation: { mint(): boolean; revoke(): void }
  window(): WindowLike | null | undefined
  onboardingActive(): boolean
  /** The same availability the activation authority and IPC handlers use (engine-decoupled). */
  availability(): CommandMicAvailabilityResult
  parakeet: { ensure(): Promise<void> }
  /** The voice hold chord's mask: a dictation chord equal to it is switched off. */
  voiceChordMask(): number
  /** A voice turn is listening or being recognized. */
  voiceTurnBusy(): boolean
  /** The Settings chord recorder is open: a hold opens nothing. */
  chordRecorderActive(): boolean
  /** The dictation chord's watcher. Defaults to the real one; tests may replace it. */
  chord?: VoiceChordWiring
  /**
   * The OS ports. Absent: macOS binds the focused field through the helper's Accessibility commands (G23), every
   * other platform is refused before the microphone opens until G24.
   */
  ports?: DictationHostPorts
  /** A dictation turn begins before capture opens, so playback can stop at the boundary. */
  onBegin?(): void
  /**
   * The encrypted segment journal and dictionary (G26). Resolved on every use, because the owner-session wiring that
   * builds it runs after this runtime exists. Defaults to the process's installed memory; null journals nothing.
   */
  memory?(): DictationMemory | null
  now?(): number
  newTurnId?(): string
  audit?(phase: DictationAuditPhase, detail?: { reason?: string }): void
}

export interface DictationRuntime {
  start(): void
  refresh(): void
  onSignedIn(): void
  onHardStop(reason: InputSessionStopReason): void
  onMeetingReserved(): void
  onRendererReset(): void
  onSpeechFinished(sessionId: string, result: CommandSpeechResult): void
  /** True when a dictation lease owns this text (so the voice pipeline and the command panel must not see it). */
  onTranscript(text: string): boolean
  /** True when the report belonged to the dictation turn. */
  report(report: VoiceReport): boolean
  /** A dictation turn is starting, listening, being recognized or inserted. */
  active(): boolean
  snapshot(): DictationSnapshot
  dispose(): void
}

/** The lease only a dictation can hold: a hardware-activated push-to-talk dictation capture. */
const isDictationLease = (lease: InputSessionLease | null): lease is InputSessionLease =>
  lease !== null && lease.source === 'push-to-talk' && lease.purpose === 'dictation'

export function createDictationRuntime(deps: DictationRuntimeDeps): DictationRuntime {
  const platform = deps.platform ?? process.platform
  const dictation = (): VoiceActionsSettings['dictation'] | undefined => deps.getSettings().voiceActions?.dictation
  const chordMask = (): number =>
    resolveDictationChordMask(deps.getSettings().voiceActions, platform, deps.voiceChordMask())
  // One effective setting feeds both the session and the watcher. A chord that clashes with the voice hold (or has
  // no keys on this platform) switches dictation off rather than running a helper that could never match.
  const effectiveEnabled = (): boolean =>
    resolveDictationEnabled(dictation(), { qaIdentity: deps.qaIdentity }) && chordMask() !== 0
  const send = (channel: string, payload: unknown): void => {
    const win = deps.window()
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* the renderer may be gone; the turn's own watchdog ends it */
    }
  }
  const chord =
    deps.chord ??
    createVoiceChordWiring({
      enabled: effectiveEnabled,
      requireAuth: deps.requireAuth,
      meetingReserved: () => deps.authority.hasMeetingReservation,
      onboardingExclusive: deps.onboardingActive,
      chordRecorderActive: deps.chordRecorderActive,
      platform,
      chordMask,
      latchEnabled: () => resolveDictationLatch(dictation()),
      onChordEvent: (event: ChordWatcherEvent) => session.onChordEvent(event),
      audit: (event, data) => auditLog(event, { ...data, chord: 'dictation' })
    })
  const memory = deps.memory ?? currentDictationMemory
  const memorySink: DictationMemorySink = {
    segmentRecognized: (turnId, text) => memory()?.sink.segmentRecognized(turnId, text),
    draftPreserved: (turnId, draft) => memory()?.sink.draftPreserved(turnId, draft),
    inserted: (turnId, text) => memory()?.sink.inserted(turnId, text),
    turnEnded: (turnId) => memory()?.sink.turnEnded(turnId)
  }
  const session: DictationSession = new DictationSession({
    settings: () => ({ enabled: effectiveEnabled() }),
    gate: {
      signedIn: () => deps.requireAuth(),
      meetingReserved: () => deps.authority.hasMeetingReservation,
      onboardingActive: () => deps.onboardingActive(),
      windowVisible: () => {
        const win = deps.window()
        return Boolean(win && !win.isDestroyed() && win.isVisible())
      },
      captureBusy: () => deps.authority.activeLease !== null || deps.voiceTurnBusy(),
      availability: () => deps.availability()
    },
    activation: deps.activation,
    stopLease: (reason) => {
      if (isDictationLease(deps.authority.activeLease)) deps.authority.hardStop(reason)
    },
    speech: { prewarm: () => deps.parakeet.ensure() },
    ports:
      deps.ports ??
      (platform === 'darwin'
        ? createMacDictationPorts({
            platform,
            now: deps.now,
            audit: (detail) => auditLog('dictation.insert', { ...detail })
          })
        : UNSUPPORTED_DICTATION_PORTS),
    memory: memorySink,
    push: {
      begin: (payload) => {
        deps.onBegin?.()
        send(VOICE_ACTIONS_IPC.begin, payload)
      },
      end: (payload) => send(VOICE_ACTIONS_IPC.end, payload)
    },
    newTurnId: deps.newTurnId ?? randomUUID,
    now: deps.now ?? Date.now,
    audit: deps.audit ?? ((phase, detail) => auditLog('dictation.turn', { phase, ...detail }))
  })
  return {
    start() {
      chord.start()
      session.refresh()
    },
    refresh() {
      // The watcher reads the same effective setting, so refresh starts, re-aims or stops its helper.
      session.refresh()
      chord.refresh()
    },
    onSignedIn: () => chord.onSignedIn(),
    onHardStop(reason) {
      chord.onInputSessionStop(reason)
      session.onHardStop(reason)
    },
    onMeetingReserved: () => session.onMeetingReserved(),
    onRendererReset: () => session.onRendererReset(),
    onSpeechFinished(sessionId, result) {
      const lease = deps.authority.activeLease
      if (isDictationLease(lease) && lease.sessionId === sessionId) session.onSpeechFinished(result)
    },
    onTranscript(text) {
      if (!isDictationLease(deps.authority.activeLease)) return false
      try {
        session.onTranscript(text)
      } catch {
        /* the session reports its own failures; a throw must not reach the capture */
      }
      return true
    },
    report(report) {
      if (!session.ownsTurn(report.turnId)) return false
      session.report(report)
      return true
    },
    active: () => session.active(),
    snapshot: () => session.snapshot(),
    dispose() {
      chord.stop()
      session.dispose()
    }
  }
}
