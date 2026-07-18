/**
 * Calibration session state machine — pure logic, injectable capture, fully unit-testable.
 *
 * Flow: for each zone, collect CALIB_N taps that pass BOTH the runtime gates and calibration-specific
 * quality checks (each rejection carries copy-ready retry guidance); then an optional negatives phase
 * ("type a sentence") harvesting the user's own keyboard/mouse acoustics; then buildProfile() with the
 * separability verdict. The UI (TapCalibration.tsx) renders state; ALL decisions live here.
 */
import { extractFeatures, FEATURE_DIM } from './features'
import { runGates } from './gates'
import { buildProfile, type BuildResult, type CalibExample } from './classify'
import type { TapCandidatePayload } from './tap-control'

export const CALIB_N = 8 // accepted taps per zone
export const MIN_SNR = 4 // window RMS must exceed floor × this, or the tap is too weak to trust
export const DRIFT_SIGMA = 3 // after 4 accepted, a tap this many σ from the running mean = "different spot?"
export const DRIFT_AFTER = 4

export type CalibPhase =
  | { phase: 'zone'; zone: number; accepted: number; needed: number }
  | { phase: 'negatives'; collected: number }
  | { phase: 'done'; result: BuildResult }

export type CalibFeedback =
  | { accepted: true }
  | {
      accepted: false
      /** Copy-ready retry guidance for the UI. */
      hint:
        | 'too-weak' // "Tap a bit harder."
        | 'clipped' // "A bit softer — that one clipped."
        | 'double-hit' // "One single clean tap."
        | 'rang-on' // "That rang on — tap, don't slide."
        | 'too-different' // "That one sounded different — same spot as before?"
        | 'not-a-tap' // generic gate failure
    }

export interface CalibrationSession {
  state: () => CalibPhase
  /** Feed a raw worklet candidate during the zone phase. */
  feedTap: (c: TapCandidatePayload) => CalibFeedback
  /** Feed a raw candidate during the negatives phase (everything triggering there is a negative). */
  feedNegative: (c: TapCandidatePayload) => void
  /** Zone phase exhausted → negatives phase (skippable) → finish(). */
  startNegatives: () => void
  finish: (meta: { micDeviceId: string; now: number }) => BuildResult
  /** Redo one zone from scratch (separability failure UX). */
  redoZone: (zone: number) => void
}

/** Detect a second strike inside the analysis window: two local peaks ≥ half the max, ≥15 ms apart. */
function hasDoubleHit(window: Float32Array, sampleRate: number): boolean {
  const minGap = Math.round(0.015 * sampleRate)
  let peak = 0
  for (let i = 0; i < window.length; i++) peak = Math.max(peak, Math.abs(window[i]))
  const thresh = peak * 0.5
  let lastPeakAt = -Infinity
  let peaks = 0
  // Envelope walk over 2 ms hops — cheap and immune to intra-cycle oscillation.
  const hop = Math.max(1, Math.round(0.002 * sampleRate))
  for (let i = 0; i < window.length; i += hop) {
    let m = 0
    for (let j = i; j < Math.min(i + hop, window.length); j++) m = Math.max(m, Math.abs(window[j]))
    if (m >= thresh) {
      if (i - lastPeakAt >= minGap) peaks++
      lastPeakAt = i
    }
  }
  return peaks >= 2
}

export function makeCalibration(zoneCount: number, sampleRate: number): CalibrationSession {
  const examples: CalibExample[] = []
  const negatives: Array<Float64Array> = []
  let zone = 0
  let phase: 'zone' | 'negatives' | 'done' = 'zone'
  let doneResult: BuildResult | null = null

  // Running per-feature stats PER ZONE — the drift check asks "does this tap match THIS zone's spot so
  // far?", so pooling across zones would wrongly compare zone B's first taps against zone A's tight
  // distribution and reject every one of them as "different".
  interface ZoneStats {
    mean: Float64Array
    m2: Float64Array
    n: number
  }
  const stats = new Map<number, ZoneStats>()
  const statsFor = (z: number): ZoneStats => {
    let s = stats.get(z)
    if (!s) {
      s = { mean: new Float64Array(FEATURE_DIM), m2: new Float64Array(FEATURE_DIM), n: 0 }
      stats.set(z, s)
    }
    return s
  }
  const pushStats = (z: number, f: Float64Array): void => {
    const s = statsFor(z)
    s.n++
    for (let i = 0; i < FEATURE_DIM; i++) {
      const d = f[i] - s.mean[i]
      s.mean[i] += d / s.n
      s.m2[i] += d * (f[i] - s.mean[i])
    }
  }
  const driftDims = (z: number, f: Float64Array): number => {
    // Count dimensions exceeding the drift threshold instead of taking the worst one: with 16 dims,
    // max-statistics makes SOME dim exceed 3σ on perfectly good taps (especially low-energy bands,
    // which are leakage-noise dominated). A genuinely moved hand shifts MANY spectral dims at once,
    // so requiring ≥2 offending dims kills the single-noisy-dim false alarm without losing the check.
    const s = statsFor(z)
    let over = 0
    for (let i = 0; i < FEATURE_DIM; i++) {
      // σ floor 0.5: an unusually consistent early streak must not shrink σ so far that ordinary
      // tap-to-tap variation (±0.5–1 log-band unit on a real desk) reads as "a different spot".
      const sd = Math.max(Math.sqrt(s.m2[i] / Math.max(1, s.n - 1)), 0.5)
      if (Math.abs(f[i] - s.mean[i]) / sd > DRIFT_SIGMA) over++
    }
    return over
  }

  const acceptedInZone = (): number => examples.filter((e) => e.zone === zone).length

  return {
    state() {
      if (phase === 'done' && doneResult) return { phase: 'done', result: doneResult }
      if (phase === 'negatives') return { phase: 'negatives', collected: negatives.length }
      return { phase: 'zone', zone, accepted: acceptedInZone(), needed: CALIB_N }
    },
    feedTap(c) {
      if (phase !== 'zone') return { accepted: false, hint: 'not-a-tap' }
      // Weakness check FIRST, straight off the raw window — a near-inaudible tap also fails the
      // sustained gate (its ring drowns in noise), and "that rang on" is exactly the wrong guidance
      // for a user who needs to tap HARDER.
      const sr = c.sampleRate
      const pre = Math.round((45 / 1000) * sr)
      const win = Math.round((90 / 1000) * sr)
      const seg = c.pcm.subarray(pre, Math.min(pre + win, c.pcm.length))
      let s = 0
      for (let i = 0; i < seg.length; i++) s += seg[i] * seg[i]
      if (Math.sqrt(s / Math.max(1, seg.length)) < Math.max(c.floorRms * MIN_SNR, 0.004)) {
        return { accepted: false, hint: 'too-weak' }
      }
      // Then the runtime gates (no level band — it doesn't exist yet) + calibration-quality checks.
      const v = runGates({ pcm: c.pcm, sampleRate: c.sampleRate, floorRms: c.floorRms })
      if (!v.ok || !v.window || v.logRms === undefined) {
        const hint =
          v.reason === 'clip' ? 'clipped' : v.reason === 'sustained' ? 'rang-on' : ('not-a-tap' as const)
        return { accepted: false, hint }
      }
      if (hasDoubleHit(v.window, c.sampleRate)) return { accepted: false, hint: 'double-hit' }
      const f = extractFeatures(v.window, c.sampleRate)
      if (statsFor(zone).n >= DRIFT_AFTER && driftDims(zone, f) >= 2) {
        return { accepted: false, hint: 'too-different' }
      }
      examples.push({ zone, features: f, logRms: v.logRms })
      pushStats(zone, f)
      if (acceptedInZone() >= CALIB_N) {
        if (zone + 1 < zoneCount) zone++
      }
      return { accepted: true }
    },
    feedNegative(c) {
      if (phase !== 'negatives' || negatives.length >= 24) return
      // Anything that fires the trigger during "type a sentence / click around" IS the enemy — store
      // its features regardless of gate verdicts (gates may rightly reject it; the classifier's veto
      // set benefits from the ones that would have slipped through anyway).
      const v = runGates({ pcm: c.pcm, sampleRate: c.sampleRate, floorRms: c.floorRms })
      const window =
        v.window ??
        c.pcm.subarray(0, Math.min(c.pcm.length, Math.round(0.09 * c.sampleRate)))
      negatives.push(extractFeatures(window, c.sampleRate))
    },
    startNegatives() {
      if (phase === 'zone') phase = 'negatives'
    },
    finish(meta) {
      const result = buildProfile(examples, negatives, {
        sampleRate,
        micDeviceId: meta.micDeviceId,
        now: meta.now
      })
      phase = 'done'
      doneResult = result
      return result
    },
    redoZone(z) {
      for (let i = examples.length - 1; i >= 0; i--) if (examples[i].zone === z) examples.splice(i, 1)
      // Only this zone's running stats are invalidated — the others' distributions are untouched.
      stats.delete(z)
      zone = z
      phase = 'zone'
      doneResult = null
    }
  }
}
