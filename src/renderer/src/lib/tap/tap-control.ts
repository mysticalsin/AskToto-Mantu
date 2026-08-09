/**
 * Desk Tap Control runtime — mic acquisition, worklet lifecycle, and the full candidate pipeline:
 *
 *   tap-worklet trigger → train gate (typing) → keydown veto → stateless gates → features → classifier
 *   → HotkeyAction dispatch through the exact router the keyboard shortcuts use.
 *
 * The capture is INDEPENDENT of the meeting mic on purpose: listen.ts opens its stream with echo
 * cancellation + noise suppression ON (right for speech, ruinous for percussive transients — the NS
 * treats a tap as noise and eats it). This stream asks for all processing OFF. macOS surfaces one
 * mic-in-use indicator either way; Settings copy owns the "mic stays on while armed" disclosure.
 */
import { useEffect, useRef } from 'react'
import { extractFeatures } from './features'
import { makeTrainGate, runGates, type RejectReason } from './gates'
import { classify, type TapProfile } from './classify'
import { TAP_WORKLET_SRC } from './tap-worklet-src'

/** A keydown this close to an acoustic onset means "the user is typing", not "the user tapped". */
const KEYDOWN_VETO_MS = 80

export type TapEvent =
  | { kind: 'tap'; zone: number; distance: number }
  | { kind: 'reject'; reason: RejectReason | 'train' | 'keyboard' | 'ood' | 'ambiguous' | 'negative' | 'no-profile' }
  | { kind: 'error'; message: string }

export interface TapCandidatePayload {
  pcm: Float32Array
  floorRms: number
  sampleRate: number
}

let cachedUrl: string | null = null
function tapWorkletUrl(): string {
  if (!cachedUrl) cachedUrl = URL.createObjectURL(new Blob([TAP_WORKLET_SRC], { type: 'text/javascript' }))
  return cachedUrl
}

export interface TapCaptureSession {
  stop: () => void
  setSensitivity: (s: number) => void
  /** The context's real sample rate — calibration stamps it into the profile. */
  sampleRate: number
}

/**
 * Low-level capture shared by the runtime and the calibration flow: open the raw mic, run the tap
 * worklet, hand every RAW candidate (post-trigger, pre-gates) to the callback.
 */
export async function startTapCapture(opts: {
  micDeviceId?: string
  sensitivity: number
  onCandidate: (c: TapCandidatePayload) => void
  onError?: (message: string) => void
}): Promise<TapCaptureSession> {
  // EC/NS/AGC off — and honor the user's chosen mic with the same vanished-device fallback shape as
  // listen.ts acquireMic: try exact, fall back to default rather than failing the whole feature.
  const base = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  } as MediaTrackConstraints
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: opts.micDeviceId ? { ...base, deviceId: { exact: opts.micDeviceId } } : base
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ audio: base })
  }
  const ctx = new AudioContext()
  try {
    await ctx.audioWorklet.addModule(tapWorkletUrl())
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    throw e
  }
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'tap-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  })
  node.port.onmessage = (e) => {
    const d = e.data as TapCandidatePayload
    if (d && d.pcm instanceof Float32Array) opts.onCandidate(d)
  }
  node.port.postMessage({ sensitivity: opts.sensitivity })
  src.connect(node)
  // Keep the node pulled without hearing it — the MicLevelMeter zero-gain trick.
  const mute = ctx.createGain()
  mute.gain.value = 0
  node.connect(mute)
  mute.connect(ctx.destination)

  let stopped = false
  return {
    sampleRate: ctx.sampleRate,
    setSensitivity(s) {
      if (!stopped) node.port.postMessage({ sensitivity: s })
    },
    stop() {
      if (stopped) return
      stopped = true
      node.port.onmessage = null
      try {
        node.disconnect()
        src.disconnect()
        mute.disconnect()
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

export interface TapControlSession {
  stop: () => void
  setSensitivity: (s: number) => void
}

/** Full recognition pipeline on top of startTapCapture. */
export async function startTapControl(opts: {
  profile: TapProfile
  micDeviceId?: string
  sensitivity: number
  onEvent: (e: TapEvent) => void
}): Promise<TapControlSession> {
  const train = makeTrainGate()
  let lastKeydown = -Infinity
  const onKey = (): void => {
    lastKeydown = performance.now()
  }
  window.addEventListener('keydown', onKey, true)

  let cap: TapCaptureSession
  try {
    cap = await startTapCapture({
      micDeviceId: opts.micDeviceId,
      sensitivity: opts.sensitivity,
      onCandidate(c) {
        const now = performance.now()
        if (!train.step(now)) {
          opts.onEvent({ kind: 'reject', reason: 'train' })
          return
        }
        if (now - lastKeydown < KEYDOWN_VETO_MS) {
          opts.onEvent({ kind: 'reject', reason: 'keyboard' })
          return
        }
        const verdict = runGates(
          { pcm: c.pcm, sampleRate: c.sampleRate, floorRms: c.floorRms },
          opts.profile.levelRange
        )
        if (!verdict.ok || !verdict.window) {
          opts.onEvent({ kind: 'reject', reason: verdict.reason ?? 'pre-quiet' })
          return
        }
        const f = extractFeatures(verdict.window, c.sampleRate)
        const r = classify(f, opts.profile)
        if (!r.ok) {
          opts.onEvent({ kind: 'reject', reason: r.reason })
          return
        }
        opts.onEvent({ kind: 'tap', zone: r.zone, distance: r.distance })
      },
      onError(message) {
        opts.onEvent({ kind: 'error', message })
      }
    })
  } catch (e) {
    // stop() below is the listener's ONLY other release path, and a rejected capture never hands the
    // caller a session to call it on — without this, every failed arm (mic denied, device busy) orphans
    // one more capturing keydown listener on window, and the hook re-arms whenever settings change.
    window.removeEventListener('keydown', onKey, true)
    throw e
  }

  return {
    setSensitivity: cap.setSensitivity,
    stop() {
      window.removeEventListener('keydown', onKey, true)
      cap.stop()
    }
  }
}

export interface UseTapControlArgs {
  /** The whole feature switch: settings.tapControl.enabled AND (armed per armOnlyWhileListening). */
  active: boolean
  profile: TapProfile | null
  micDeviceId?: string
  sensitivity: number
  /** Fired with the recognized zone index — caller maps it to a HotkeyAction and dispatches. */
  onZone: (zone: number) => void
  /** Profile was calibrated on a different mic/rate — surface a "recalibrate" prompt. */
  onProfileMismatch?: () => void
}

/**
 * Lifecycle hook: arms/disarms the pipeline as `active`/profile/mic change (sensitivity is pushed into
 * the open session instead). Stale-close safe — a torn-down session's late events are dropped via the
 * generation counter.
 */
export function useTapControl(args: UseTapControlArgs): void {
  const gen = useRef(0)
  const zoneRef = useRef(args.onZone)
  zoneRef.current = args.onZone
  const mismatchRef = useRef(args.onProfileMismatch)
  mismatchRef.current = args.onProfileMismatch
  const sessionRef = useRef<TapControlSession | null>(null)

  const { active, profile, micDeviceId, sensitivity } = args
  const sensitivityRef = useRef(sensitivity)
  sensitivityRef.current = sensitivity

  // `profile` is a nested object that arrives fresh over IPC on EVERY settings read — window focus and
  // every patch (including the unattended fallback patches a live meeting writes). Keying the effect on
  // its object identity re-acquired the mic several times a meeting: taps in each ~100-400 ms
  // re-acquisition window are lost and makeTrainGate's typing history restarts, so a keystroke-adjacent
  // false positive can slip through right after a focus. A saved profile is fully identified by these
  // four fields (createdAt is stamped once, at calibration), so re-arm only on a real recalibration.
  const profileKey = profile
    ? `${profile.version}|${profile.sampleRate}|${profile.micDeviceId}|${profile.createdAt}`
    : ''
  const profileRef = useRef(profile)
  profileRef.current = profile

  useEffect(() => {
    const p = profileRef.current
    if (!active || !p) return
    // Mic identity is part of the acoustic model — a different mic has a different transfer function.
    if (p.micDeviceId !== (micDeviceId ?? p.micDeviceId)) {
      mismatchRef.current?.()
      return
    }
    const my = ++gen.current
    const armed = sensitivityRef.current
    void startTapControl({
      profile: p,
      micDeviceId,
      sensitivity: armed,
      onEvent(e) {
        if (gen.current !== my) return
        if (e.kind === 'tap') zoneRef.current(e.zone)
      }
    })
      .then((s) => {
        if (gen.current !== my) {
          s.stop()
          return
        }
        sessionRef.current = s
        // The slider can move while getUserMedia is still resolving — the effect below found no session
        // to push that change into, so apply it here or the session runs on a stale threshold.
        if (sensitivityRef.current !== armed) s.setSensitivity(sensitivityRef.current)
      })
      .catch(() => {
        /* mic denied or worklet failed — feature silently unavailable this session */
      })
    return () => {
      gen.current++
      sessionRef.current?.stop()
      sessionRef.current = null
    }
  }, [active, profileKey, micDeviceId])

  // Sensitivity is a live worklet threshold, not part of the acoustic model: push it through the open
  // session instead of re-arming, or a slider drag cycles the mic once per step.
  useEffect(() => {
    sessionRef.current?.setSensitivity(sensitivity)
  }, [sensitivity])

  // Sample-rate drift (same mic, OS changed the device rate) is checked inside the session via the
  // capture's real rate — a profile calibrated at another rate classifies worse; the calibration UI
  // surfaces this as a "recalibrate" hint rather than hard-disabling the feature.
}
