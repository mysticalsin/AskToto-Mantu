import type { ListenAudioChannel, ListenMicCapture, ListenSpeaker } from './listen-audio-channels'
import type { ScreenDiagnosis } from '@shared/screen-permission'
import { sysRetryDelayMs } from './loopback-retry'
import { captureHealthForTrack, micSelectionOutcome } from './listen-capture-state'
import { isWindows } from './keys'

/** What the 'them' (system-loopback) side must do when the OS reports an audio-device change. */
export type ThemDeviceAction = 'ignore' | 'watch' | 'recover' | 'recycle'

export function failBrokerCaptureRecovery(
  transport: string | undefined,
  captureId: string | null,
  side: 'microphone' | 'system',
  failCapture: (message: string, options?: { cloudCaptureId?: string }) => void
): boolean {
  if (transport !== 'broker-v1') return false
  const source = side === 'microphone' ? 'microphone' : 'system-audio'
  failCapture(`Cloud speech stopped because its ${source} source could not be recovered.`, {
    cloudCaptureId: captureId ?? undefined
  })
  return true
}

/**
 * Exported for unit testing — the pure decision behind the 'them'-side silent-death recovery (see
 * armThemProbation and the devicechange effect in useListen). Called twice per device change: with
 * `sawWindow: null` when the change is debounced, then with the observed boolean when the probation
 * window expires. A device change that kills the loopback leaves the track in readyState 'live' and fires
 * no 'ended' event, so a still-registered channel is only trustworthy once it has emitted a window SINCE
 * the change — the previous session-long "we heard them once" latch could never notice the death.
 *
 * `hasDeathEvidence` (read only on the expiry call, when sawWindow is a boolean) is the MQA-109 guard: an
 * absent window during probation is NOT proof of death for a channel that was ALREADY confirmed healthy.
 * An unrelated device blip during a normal quiet stretch (you talking, the remote briefly silent) emits no
 * window while the loopback stays perfectly alive; recycling it there tears down a working capture —
 * exactly what armThemProbation's own contract says must never happen. So an already-healthy channel is
 * recycled ONLY with positive evidence its tracks actually died; a channel that never proved itself keeps
 * the original prove-or-die probation. Defaults to true so the debounce call (which returns 'watch' before
 * ever reading it) and any legacy three-arg caller keep the historical behaviour.
 */
export function themDeviceChangeAction(
  wantsSystem: boolean,
  hasThemChannel: boolean,
  sawWindow: boolean | null,
  hasDeathEvidence = true
): ThemDeviceAction {
  if (!wantsSystem) return 'ignore' // mic-only session — there is no loopback to keep alive
  if (!hasThemChannel) return 'recover' // nothing to wait on (start-time failure, or a channel already closed)
  if (sawWindow === null) return 'watch' // registered channel — let it prove itself before tearing it down
  if (sawWindow) return 'ignore' // proved itself again — no gratuitous teardown on a device blip
  return hasDeathEvidence ? 'recycle' : 'ignore' // MQA-109: quiet ≠ dead for an already-healthy channel
}

/**
 * Exported for unit testing — positive death evidence for an already-healthy 'them' channel (MQA-109).
 * The device-change probation recycles a confirmed-healthy loopback only when its audio actually died, not
 * merely because it went quiet: every remaining audio track has ended, or its source went muted (an empty
 * list means the channel is already gone, which also counts as dead so recovery still fires). Only AUDIO
 * tracks are passed in — the macOS/Windows loopback stream carries a 1fps video track that stays live and
 * would otherwise mask a dead audio track.
 */
export function themTracksLookDead(tracks: { readyState: string; muted: boolean }[]): boolean {
  if (tracks.length === 0) return true
  return tracks.every((t) => t.readyState === 'ended' || t.muted)
}

/**
 * Acquire the microphone, honouring a chosen deviceId when one is set. If that specific device has gone
 * away (e.g. AirPods disconnected), fall back to the system default so a meeting never loses its mic over
 * a device that vanished. Empty deviceId means "follow the system default" from the start.
 */
type MicCapture = ListenMicCapture

export async function acquireMic(deviceId: string): Promise<MicCapture> {
  const base: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  let stream: MediaStream
  let usedFallback = false
  if (!deviceId) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: base })
  } else {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } })
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: base })
      usedFallback = true
    }
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    stream.getTracks().forEach((candidate) => candidate.stop())
    throw new Error('no microphone audio track')
  }
  return {
    stream,
    track,
    health: captureHealthForTrack(track, Boolean(deviceId), micSelectionOutcome(Boolean(deviceId), usedFallback))
  }
}

/**
 * MQA-267 — voice processing must be OFF on the loopback ('them') track, and it defaulted ON.
 *
 * Probed on real Windows hardware (the index.ts CAVEAT said this path was never validated): the granted
 * loopback track came back with echoCancellation:true, noiseSuppression:true, autoGainControl:true.
 * Echo cancellation's entire purpose is to subtract the far-end audio playing through the speakers —
 * which on a loopback capture IS the signal. With the mic channel open beside it, the AEC reference
 * lines up and the 'them' audio is partially or wholly cancelled before it ever reaches ASR. That is the
 * reported symptom exactly: the main speaker transcribes, the other person intermittently vanishes, and
 * the transcript breaks mid-conversation. Noise suppression and AGC compound it — both are tuned for a
 * mouth near a microphone, not for rendered playout, so they pump and gate clean far-end speech.
 *
 * The MIC keeps its processing (acquireMic above): AEC on the mic is what stops the speakers bleeding
 * the other person's words into the 'you' channel as duplicates. The asymmetry is the design.
 */
const LOOPBACK_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}

/** getDisplayMedia audio constraints are not reliably honored across Chromium versions, so the
 *  constraint is also applied to the LIVE track after the grant. applyConstraints on these three
 *  booleans works even where the initial request was ignored; a track that refuses is left as-is
 *  rather than failing the capture — degraded audio still beats no 'them' channel at all. */
async function stripLoopbackProcessing(sys: MediaStream): Promise<void> {
  for (const t of sys.getAudioTracks()) {
    try {
      await t.applyConstraints(LOOPBACK_AUDIO)
    } catch {
      /* keep the track — a processed 'them' is still better than none */
    }
  }
}

/** The one way a loopback stream is acquired. Windows tries audio-only first so no genuine screen
 *  source is grabbed (and no OS/EDR screen-recording indicator fires) for what the user intended as
 *  system audio; macOS must bind to a 1fps ScreenCaptureKit video stream or the audio never starts. */
export async function acquireLoopback(): Promise<MediaStream> {
  let sys: MediaStream
  if (isWindows) {
    try {
      sys = await navigator.mediaDevices.getDisplayMedia({ audio: LOOPBACK_AUDIO })
    } catch {
      sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: LOOPBACK_AUDIO })
    }
  } else {
    sys = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: LOOPBACK_AUDIO })
  }
  await stripLoopbackProcessing(sys)
  return sys
}

export interface ListenAudioRecoveryHost {
  currentEpoch(): number
  admissionOpen(epoch: number): boolean
  wantsSystemAudio(): boolean
  micDeviceId(): string
  acquireMic(deviceId: string): Promise<ListenMicCapture>
  acquireLoopback(): Promise<MediaStream>
  armAudio(armed: boolean): Promise<void>
  openChannel(speaker: ListenSpeaker, stream: MediaStream, epoch: number, mic?: ListenMicCapture): Promise<boolean>
  hasChannel(speaker: ListenSpeaker): boolean
  stopStream(stream: MediaStream): void
  publishMicRecoveryFailure(epoch: number): void
  micRecoverySucceeded(): void
  micRecoveryFailed(): void
  systemRecoverySucceeded(): void
  systemRecoveryFailed(): void
  isLive(): boolean
  isStopping(): boolean
  isPaused(): boolean
  isListening(): boolean
  scheduleThemProbation(callback: () => void, delayMs: number): void
  themChannel(): ListenAudioChannel | undefined
  themHeard(): boolean
  themWindowSeen(): boolean
  setThemWindowSeen(seen: boolean): void
  onThemProbationRecycle(): void
  themProbationDuration(): number
  themDeviceChangeAction(
    wantsSystem: boolean,
    hasSystemChannel: boolean,
    sawWindow?: boolean | null,
    hasDeathEvidence?: boolean
  ): 'ignore' | 'watch' | 'recover' | 'recycle'
  recoverMicNow(): void
  recoverSystemNow(): void
  setSystemPermissionNote(diagnosis?: ScreenDiagnosis | null): void
  getPermissions(): Promise<{
    screenRecording?: string
    screenDiagnosis?: ScreenDiagnosis | null
  }>
  deviceChangeTarget(): Pick<MediaDevices, 'addEventListener' | 'removeEventListener'>
  isWindows(): boolean
}

export interface ListenAudioRecovery {
  recoverMic(): Promise<void>
  recoverSystemAudio(): Promise<void>
  resetSystemRetry(): void
  armThemProbation(): void
  watchDeviceChanges(): () => void
  watchSystemPermission(): () => void
}

/** Coordinates device recovery without owning capture policy or UI state. */
export function createListenAudioRecovery(host: () => ListenAudioRecoveryHost): ListenAudioRecovery {
  let micRecovering = false
  let systemRecovering = false
  let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempts = 0
  let retryNextAt = 0

  const recoverMic = async (): Promise<void> => {
    const current = host()
    const epoch = current.currentEpoch()
    if (!current.admissionOpen(epoch) || micRecovering) return
    micRecovering = true
    try {
      const mic = await host().acquireMic(host().micDeviceId())
      if (!host().admissionOpen(epoch)) {
        host().stopStream(mic.stream)
        return
      }
      if (!(await host().openChannel('you', mic.stream, epoch, mic)) || !host().admissionOpen(epoch)) return
      host().micRecoverySucceeded()
    } catch {
      if (!host().admissionOpen(epoch)) return
      host().publishMicRecoveryFailure(epoch)
      host().micRecoveryFailed()
    } finally {
      micRecovering = false
    }
  }

  const recoverSystemAudio = async (): Promise<void> => {
    const current = host()
    const epoch = current.currentEpoch()
    const admitted = (): boolean => host().admissionOpen(epoch) && host().wantsSystemAudio()
    if (!admitted() || systemRecovering || host().hasChannel('them')) return
    systemRecovering = true
    try {
      await host().armAudio(true)
      let stream: MediaStream
      try {
        if (!admitted()) return
        stream = await host().acquireLoopback()
      } finally {
        await host().armAudio(false)
      }
      const liveAudio = stream.getAudioTracks().filter((track) => track.readyState !== 'ended')
      if (!admitted() || !liveAudio.length) {
        host().stopStream(stream)
        return
      }
      if (!(await host().openChannel('them', stream, epoch)) || !admitted()) return
      retryAttempts = 0
      retryNextAt = 0
      host().systemRecoverySucceeded()
    } catch {
      if (admitted()) host().systemRecoveryFailed()
    } finally {
      systemRecovering = false
    }
  }

  const armThemProbation = (): void => {
    const deps = host()
    deps.setThemWindowSeen(false)
    const originEpoch = deps.currentEpoch()
    deps.scheduleThemProbation(() => {
      const latest = host()
      if (!latest.admissionOpen(originEpoch) || latest.isPaused() || !latest.isListening()) return
      const channel = latest.themChannel()
      const hasDeathEvidence = !latest.themHeard() || themTracksLookDead(channel?.stream.getAudioTracks() ?? [])
      const verdict = latest.themDeviceChangeAction(
        latest.wantsSystemAudio(),
        !!channel,
        latest.themWindowSeen(),
        hasDeathEvidence
      )
      if (verdict === 'recycle') latest.onThemProbationRecycle()
    }, deps.themProbationDuration())
  }

  const watchDeviceChanges = (): (() => void) => {
    const current = host()
    const target = current.deviceChangeTarget()
    const onDeviceChange = (): void => {
      const deps = host()
      if (!deps.isLive() || deps.isStopping()) return
      const originEpoch = deps.currentEpoch()
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer)
      deviceChangeTimer = setTimeout(() => {
        deviceChangeTimer = null
        const latest = host()
        if (!latest.admissionOpen(originEpoch)) return
        if (latest.hasChannel('you')) latest.recoverMicNow()
        const action = latest.themDeviceChangeAction(latest.wantsSystemAudio(), latest.hasChannel('them'), null)
        if (action === 'watch') armThemProbation()
        else if (action === 'recover') {
          retryAttempts = 0
          retryNextAt = 0
          latest.recoverSystemNow()
        }
      }, 800)
    }
    target.addEventListener('devicechange', onDeviceChange)
    return () => {
      target.removeEventListener('devicechange', onDeviceChange)
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer)
      deviceChangeTimer = null
    }
  }

  const watchSystemPermission = (): (() => void) => {
    const current = host()
    if (!current.isListening() || !current.wantsSystemAudio()) return () => {}
    const interval = setInterval(() => {
      const deps = host()
      const originEpoch = deps.currentEpoch()
      if (!deps.admissionOpen(originEpoch) || !deps.wantsSystemAudio()) return
      if (deps.hasChannel('them') || systemRecovering) return
      if (deps.isWindows()) {
        const now = Date.now()
        if (now < retryNextAt) return
        retryNextAt = now + sysRetryDelayMs(retryAttempts++)
        deps.recoverSystemNow()
        return
      }
      void deps
        .getPermissions()
        .then((permissions) => {
          const latest = host()
          if (
            latest.admissionOpen(originEpoch) &&
            latest.wantsSystemAudio() &&
            permissions?.screenRecording === 'granted' &&
            !latest.hasChannel('them')
          ) {
            latest.recoverSystemNow()
          } else if (latest.admissionOpen(originEpoch) && !latest.hasChannel('them')) {
            latest.setSystemPermissionNote(permissions?.screenDiagnosis)
          }
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }

  return {
    recoverMic,
    recoverSystemAudio,
    resetSystemRetry: () => {
      retryAttempts = 0
      retryNextAt = 0
    },
    armThemProbation,
    watchDeviceChanges,
    watchSystemPermission
  }
}
