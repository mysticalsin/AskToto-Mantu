import { CaptureSchema, type Capture, type Track } from '@shared/contracts/speech'

export type ListenCaptureSource = 'mic' | 'system' | 'both'
export type ListenCaptureEngine = 'whisper' | 'parakeet' | 'apple' | 'cloud'

export interface CaptureDegraded {
  side: 'you' | 'them'
  note: string
  permission: boolean
  repair?: boolean
}

export type CaptureSelectionOutcome = 'system-default' | 'requested-device' | 'fallback-default' | 'unavailable'

export interface CaptureHealth {
  requestedDevice: boolean
  selectionOutcome: CaptureSelectionOutcome
  inputSampleRate: number | null
  inputChannelCount: number | null
  processingSampleRate: 16000
  trackState: 'connected' | 'ended' | 'unavailable'
}

export type CaptureStateResult =
  | { ok: true; state: Capture }
  | { ok: false; reason: 'stale-generation' | 'invalid-state' }

type BeginCapture = {
  generation: number
  source: ListenCaptureSource
  engine: string
  cloudProvider?: unknown
}

type CaptureTrack = Pick<MediaStreamTrack, 'readyState' | 'getSettings'>

function safeTrackNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function micSelectionOutcome(
  requestedDevice: boolean,
  usedFallback: boolean,
  unavailable = false
): CaptureSelectionOutcome {
  if (unavailable) return 'unavailable'
  if (!requestedDevice) return 'system-default'
  return usedFallback ? 'fallback-default' : 'requested-device'
}

export function captureHealthForTrack(
  track: CaptureTrack | null,
  requestedDevice: boolean,
  selectionOutcome: CaptureSelectionOutcome
): CaptureHealth {
  if (!track) {
    return {
      requestedDevice,
      selectionOutcome,
      inputSampleRate: null,
      inputChannelCount: null,
      processingSampleRate: 16000,
      trackState: 'unavailable'
    }
  }
  let settings: MediaTrackSettings = {}
  try {
    settings = track.getSettings()
  } catch {
    // A browser-specific settings read must not turn into a capture failure.
  }
  return {
    requestedDevice,
    selectionOutcome,
    inputSampleRate: safeTrackNumber(settings.sampleRate),
    inputChannelCount: safeTrackNumber(settings.channelCount),
    processingSampleRate: 16000,
    trackState: track.readyState === 'ended' ? 'ended' : 'connected'
  }
}

export function captureHealthIfCurrent<T>(currentEpoch: number, eventEpoch: number, current: T, next: T): T {
  return currentEpoch === eventEpoch ? next : current
}

export function sameCaptureHealth(left: CaptureHealth | null, right: CaptureHealth | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.requestedDevice === right.requestedDevice &&
      left.selectionOutcome === right.selectionOutcome &&
      left.inputSampleRate === right.inputSampleRate &&
      left.inputChannelCount === right.inputChannelCount &&
      left.processingSampleRate === right.processingSampleRate &&
      left.trackState === right.trackState)
  )
}

export function shouldShowNoSpeechWarning(
  currentEpoch: number,
  eventEpoch: number,
  captureHealth: CaptureHealth | null,
  speechAdmitted: boolean,
  captureDegraded: CaptureDegraded | null
): boolean {
  return (
    currentEpoch === eventEpoch &&
    captureHealth?.trackState === 'connected' &&
    !speechAdmitted &&
    captureDegraded === null
  )
}

/** Map a real Listen engine selection to its contract identity; cloud providers are never inferred. */
export function listenSpeechEngine(engine: unknown, cloudProvider?: unknown): Capture['engine'] | null {
  if (engine === 'whisper' || engine === 'parakeet' || engine === 'apple') return engine
  if (engine !== 'cloud') return null
  return cloudProvider === 'cloudflare-nova3' || cloudProvider === 'soniox' ? cloudProvider : null
}

function requestedTracksFor(source: unknown): Track[] {
  if (source === 'mic') return ['microphone']
  if (source === 'system') return ['system']
  if (source === 'both') return ['microphone', 'system']
  return []
}

function copyCapture(capture: Capture): Capture {
  return {
    generation: capture.generation,
    engine: capture.engine,
    requestedTracks: [...capture.requestedTracks],
    capturedTracks: [...capture.capturedTracks]
  }
}

/** Owns only validated metadata; media streams and their resource ownership remain in Listen. */
export function createListenCaptureState(): {
  begin: (request: BeginCapture) => CaptureStateResult
  setEngine: (generation: number, engine: string, cloudProvider?: unknown) => CaptureStateResult
  setCaptured: (generation: number, track: Track, captured: boolean) => CaptureStateResult
  snapshot: (generation: number) => CaptureStateResult
  current: (generation: number) => Capture | null
  clear: (generation: number) => boolean
} {
  let current: Capture | null = null

  const parsed = (candidate: unknown, commit: boolean): CaptureStateResult => {
    const result = CaptureSchema.safeParse(candidate)
    if (!result.success) return { ok: false, reason: 'invalid-state' }
    if (commit) current = result.data
    return { ok: true, state: copyCapture(result.data) }
  }

  const forGeneration = (generation: number): CaptureStateResult => {
    if (!current || current.generation !== generation) return { ok: false, reason: 'stale-generation' }
    return parsed(current, false)
  }

  return {
    begin(request) {
      if (current && request.generation <= current.generation) {
        return { ok: false, reason: 'stale-generation' }
      }
      const engine = listenSpeechEngine(request.engine, request.cloudProvider)
      if (!engine) return { ok: false, reason: 'invalid-state' }
      return parsed(
        {
          generation: request.generation,
          engine,
          requestedTracks: requestedTracksFor(request.source),
          capturedTracks: []
        },
        true
      )
    },
    setEngine(generation, selectedEngine, cloudProvider) {
      const before = forGeneration(generation)
      if (!before.ok) return before
      const engine = listenSpeechEngine(selectedEngine, cloudProvider)
      if (!engine) return { ok: false, reason: 'invalid-state' }
      return parsed({ ...before.state, engine }, true)
    },
    setCaptured(generation, track, captured) {
      const before = forGeneration(generation)
      if (!before.ok) return before
      if (!before.state.requestedTracks.includes(track)) return { ok: false, reason: 'invalid-state' }
      const selected = new Set(before.state.capturedTracks)
      if (captured) selected.add(track)
      else selected.delete(track)
      return parsed(
        {
          ...before.state,
          capturedTracks: before.state.requestedTracks.filter((candidate) => selected.has(candidate))
        },
        true
      )
    },
    snapshot: forGeneration,
    current(generation) {
      const result = forGeneration(generation)
      return result.ok ? result.state : null
    },
    clear(generation) {
      if (!current || current.generation !== generation) return false
      current = null
      return true
    }
  }
}

export function degradedAfterMicRecovery(
  current: CaptureDegraded | null,
  themDegraded: CaptureDegraded | null,
  wantsSystem: boolean,
  hasThemChannel: boolean
): CaptureDegraded | null {
  if (current?.side !== 'you') return current
  return wantsSystem && !hasThemChannel ? themDegraded : null
}

export function themRecoveryFailureIsNoop(error: string | null, captureDegraded: CaptureDegraded | null): boolean {
  return error !== null && captureDegraded !== null
}
