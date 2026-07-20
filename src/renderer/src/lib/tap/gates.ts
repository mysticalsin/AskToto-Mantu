/**
 * Accept/reject gates for tap candidates.
 *
 * The worklet's trigger is deliberately dumb (an RMS jump) — every judgment about WHAT jumped lives
 * here, on the main thread, as pure functions over the captured buffer. That keeps the audio thread
 * cheap, keeps every rule unit-testable against synthetic waveforms, and gives each rejection a NAME,
 * because a debuggable "rejected: sustained" beats a silent miss when tuning on a real desk.
 *
 * Ordering matters and is cheapest-first. The two strongest, near-free gates lead: taps emerge from
 * SILENCE (speech plosives and mid-music transients don't — pre-quiet), and taps are ISOLATED (typing
 * is a train — handled by makeTrainGate in the runtime). Spectral work only runs on what survives.
 */
import { powerSpectrum } from './fft'

/** Capture geometry — single source of truth shared by the worklet source and the gates. */
export const PRE_MS = 45 // pre-onset context for the quiet gate; > an inter-phone gap, < a syllable
export const WIN_MS = 90 // strike (~2 ms) + ~3τ of a damped desk ring (τ ≈ 20–40 ms)
export const POST_MS = 45 // aftermath look for the sustained gate without a second capture

export const ATTACK_MAX_MS = 12 // onset→peak longer than this is a swell/speech onset, not a strike
export const SUSTAIN_FRAC = 0.25 // post RMS above this fraction of the strike RMS = still ringing/talking
export const CLIP_MAX_SAMPLES = 3 // more near-full-scale samples than this = clipped, features are garbage
export const KEYCLICK_HF_RATIO = 4 // E(2–8 kHz)/E(80–500 Hz) above this + fast decay = airborne key click
export const KEYCLICK_DECAY_MS = 30 // …"fast decay" = to 10% of peak within this
export const LEVEL_BAND_DB = 6 // accepted window log-RMS must sit within calibration range ± this
export const EARLY_STRIKE_MS = 30 // strike segment used as the sustained gate's reference (hit + first ring)
export const KEYCLICK_FFT_N = 1024 // smaller FFT for the key-click screen — band ratios need only coarse bins

export type RejectReason =
  | 'pre-quiet'
  | 'attack'
  | 'sustained'
  | 'level-band'
  | 'clip'
  | 'key-click'

export interface TapCandidate {
  /** PRE_MS + WIN_MS + POST_MS of samples, onset at the PRE/WIN boundary. */
  pcm: Float32Array
  sampleRate: number
  /** The worklet's ambient-floor estimate at trigger time. */
  floorRms: number
}

export interface GateVerdict {
  ok: boolean
  reason?: RejectReason
  /** The isolated WIN_MS analysis window (valid when ok) — what features.ts consumes. */
  window?: Float32Array
  /** log-RMS of the window, for the level-band gate + calibration stats. */
  logRms?: number
}

const ms = (m: number, sr: number): number => Math.round((m / 1000) * sr)

function rmsOf(pcm: Float32Array, from: number, to: number): number {
  const a = Math.max(0, from)
  const b = Math.min(pcm.length, to)
  if (b <= a) return 0
  let s = 0
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i]
  return Math.sqrt(s / (b - a))
}

/**
 * Run every stateless gate in order. `levelRange` (log-RMS min/max from the calibration profile) is
 * optional — absent during calibration collection, when the level band doesn't exist yet.
 */
export function runGates(
  cand: TapCandidate,
  levelRange?: { min: number; max: number }
): GateVerdict {
  const sr = cand.sampleRate
  const pre = ms(PRE_MS, sr)
  const win = ms(WIN_MS, sr)
  const { pcm } = cand

  // -- pre-quiet: the PRE segment must be near the ambient floor. Kills speech plosives, music hits,
  // clatter during talking — anything that did NOT emerge from silence.
  const preRms = rmsOf(pcm, 0, pre)
  if (preRms > Math.max(2 * cand.floorRms, 0.008)) return { ok: false, reason: 'pre-quiet' }

  const window = pcm.subarray(pre, Math.min(pre + win, pcm.length))

  // -- clip: features of a clipped strike are meaningless.
  let clipped = 0
  for (let i = 0; i < window.length; i++) if (Math.abs(window[i]) >= 0.99) clipped++
  if (clipped > CLIP_MAX_SAMPLES) return { ok: false, reason: 'clip' }

  // -- attack: strikes reach their peak within milliseconds; swells and speech onsets don't.
  let peak = 0
  let peakAt = 0
  for (let i = 0; i < window.length; i++) {
    const a = Math.abs(window[i])
    if (a > peak) {
      peak = a
      peakAt = i
    }
  }
  if (peakAt > ms(ATTACK_MAX_MS, sr)) return { ok: false, reason: 'attack' }

  // -- sustained: the POST segment must have died down relative to the strike. Kills speech, music,
  // chair scrapes — anything still making noise ~135 ms after "the hit".
  const strikeRms = rmsOf(window, 0, ms(EARLY_STRIKE_MS, sr))
  const postRms = rmsOf(pcm, pre + win, pcm.length)
  if (strikeRms > 0 && postRms > SUSTAIN_FRAC * strikeRms) return { ok: false, reason: 'sustained' }

  // -- key-click prior: airborne clicks from the keyboard directly under the mics are short and
  // HF-heavy; structure-borne desk taps are LF-heavy. A hardcoded prior — the calibrated negative
  // set is the precise, per-keyboard defense; this catches the worst before any calibration exists.
  const spec = powerSpectrum(window, KEYCLICK_FFT_N)
  const hzPerBin = sr / KEYCLICK_FFT_N
  const bandE = (lo: number, hi: number): number => {
    let e = 0
    const a = Math.max(1, Math.round(lo / hzPerBin))
    const b = Math.min(spec.length - 1, Math.round(hi / hzPerBin))
    for (let k = a; k <= b; k++) e += spec[k]
    return e
  }
  const hf = bandE(2000, 8000)
  const lf = bandE(80, 500)
  if (lf > 0 && hf / lf > KEYCLICK_HF_RATIO) {
    // Only condemn if it ALSO decays like a click (desk taps near hard objects can be bright too).
    const decayTarget = peak * 0.1
    let decayedAt = window.length
    for (let i = peakAt; i < window.length; i++) {
      if (Math.abs(window[i]) <= decayTarget) {
        decayedAt = i
        break
      }
    }
    if (decayedAt - peakAt < ms(KEYCLICK_DECAY_MS, sr)) return { ok: false, reason: 'key-click' }
  }

  // -- level-band: a candidate far louder/softer than everything seen in calibration is a slam or a
  // graze, not the user's tap. Only enforceable once a profile exists.
  const logRms = Math.log(rmsOf(window, 0, window.length) + 1e-12)
  if (levelRange) {
    const dB = LEVEL_BAND_DB * (Math.LN10 / 20) // ±6 dB expressed in natural-log RMS units
    if (logRms < levelRange.min - dB || logRms > levelRange.max + dB) {
      return { ok: false, reason: 'level-band' }
    }
  }

  return { ok: true, window: window.slice(), logRms }
}

/**
 * Onset-train suppressor — the typing killer. Stateful, so it's a pure factory (same pattern as
 * makeVad): feed EVERY worklet trigger's timestamp; while ≥3 onsets land inside 1 s, everything is
 * suppressed until 500 ms of quiet. Applies to raw triggers, before the stateless gates run.
 */
export function makeTrainGate(): { step: (nowMs: number) => boolean; reset: () => void } {
  const WINDOW_MS = 1000
  const TRAIN_N = 3
  const COOLDOWN_MS = 500
  let times: number[] = []
  let coolUntil = 0
  return {
    /** Returns true when this onset is allowed through. */
    step(nowMs) {
      times = times.filter((t) => nowMs - t < WINDOW_MS)
      times.push(nowMs)
      if (times.length >= TRAIN_N) {
        coolUntil = nowMs + COOLDOWN_MS
        return false
      }
      if (nowMs < coolUntil) {
        // Still cooling down: any onset extends the quiet requirement.
        coolUntil = nowMs + COOLDOWN_MS
        return false
      }
      return true
    },
    reset() {
      times = []
      coolUntil = 0
    }
  }
}
