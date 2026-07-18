/**
 * Tap-candidate → 16-dim feature vector.
 *
 * Everything a single processed mono mic can still tell us about WHERE a desk was struck survives in
 * two places: the spectral coloration of the strike (which plate modes the position excites, filtered
 * by the structure-borne path) and the temporal decay structure (distance shifts level, HF rolloff and
 * the direct-to-late balance). So the vector is 12 gain-invariant spectral-shape dims + 3 temporal dims
 * + 1 level dim. Gain invariance is explicit — mean-subtracting the log bands — so tap STRENGTH cannot
 * masquerade as tap POSITION; overall level is kept as exactly one dimension (f[15]) where pooled
 * z-scoring gives it fair, not dominant, weight against 16 calibration examples.
 *
 * Sizing: three 2048-point Hann frames across the ~90 ms window. The hop-averaged spectrum carries the
 * shape information of one long FFT while the per-frame spectra keep the decay structure a single
 * transform smears away. All edges are Hz/ms-denominated and mapped through the real sampleRate, so a
 * profile calibrated at 48 kHz still lines up at 44.1 kHz.
 */
import { hannWindow, powerSpectrum } from './fft'

export const FEATURE_DIM = 16
export const FFT_N = 2048
export const NUM_BANDS = 12
export const BAND_LO_HZ = 100
export const BAND_HI_HZ = 10000
/** Early/late boundary inside the analysis window — the strike vs. the ring. */
export const EARLY_MS = 20

const LOG_FLOOR = 1e-12

/** 13 log-spaced edges (Hz) for the 12 bands — computed once, pure function of the constants. */
export function bandEdgesHz(): number[] {
  const edges: number[] = []
  const r = Math.log(BAND_HI_HZ / BAND_LO_HZ)
  for (let i = 0; i <= NUM_BANDS; i++) edges.push(BAND_LO_HZ * Math.exp((r * i) / NUM_BANDS))
  return edges
}

function bandEnergies(spec: Float64Array, sampleRate: number): number[] {
  // Fractional-bin integration: a boundary bin contributes to each side proportionally to the overlap
  // of the bin's frequency span with the band. Hard-rounding edges to bins made a mode sitting ON an
  // edge (e.g. 320 Hz vs the 316 Hz boundary) flip whole bins between bands when the bin width changed
  // (48 k vs 44.1 k), which was the dominant cross-rate feature drift.
  const edges = bandEdgesHz()
  const hzPerBin = sampleRate / FFT_N
  const out = new Array<number>(NUM_BANDS).fill(0)
  for (let b = 0; b < NUM_BANDS; b++) {
    const loHz = edges[b]
    const hiHz = edges[b + 1]
    const loBin = Math.max(1, Math.floor(loHz / hzPerBin))
    const hiBin = Math.min(spec.length - 1, Math.ceil(hiHz / hzPerBin))
    for (let k = loBin; k <= hiBin; k++) {
      const binLo = k * hzPerBin - hzPerBin / 2
      const binHi = binLo + hzPerBin
      const overlap = Math.min(binHi, hiHz) - Math.max(binLo, loHz)
      if (overlap > 0) out[b] += spec[k] * (overlap / hzPerBin)
    }
  }
  return out
}

function spectralCentroidHz(spec: Float64Array, sampleRate: number): number {
  const hzPerBin = sampleRate / FFT_N
  let num = 0
  let den = 0
  for (let k = 1; k < spec.length; k++) {
    num += k * hzPerBin * spec[k]
    den += spec[k]
  }
  return den > 0 ? num / den : 0
}

function frameAt(pcm: Float32Array, start: number): Float32Array {
  // Copy (never window the caller's buffer in place) and zero-pad the final frame if the window is
  // slightly shorter than start+FFT_N — exact at 48 kHz, ~3 ms short at 44.1 kHz.
  const f = new Float32Array(FFT_N)
  const m = Math.min(FFT_N, pcm.length - start)
  for (let i = 0; i < m; i++) f[i] = pcm[start + i]
  hannWindow(f)
  return f
}

function rmsOf(pcm: Float32Array, from: number, to: number): number {
  const a = Math.max(0, from)
  const b = Math.min(pcm.length, to)
  if (b <= a) return 0
  let s = 0
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i]
  return Math.sqrt(s / (b - a))
}

/**
 * Extract the 16-dim vector from one analysis window (the ~90 ms starting at the onset — pre/post
 * context is the gates' business, not the features').
 *
 *   f[0..11]  mean-subtracted log band energies (gain-invariant spectral shape)
 *   f[12]     early/late log-RMS ratio — decay rate
 *   f[13]     log-centroid drop, frame 0 → frame 2 — how fast HF dies
 *   f[14]     crest factor (peak/RMS) — strike hardness character
 *   f[15]     window log-RMS — the level/distance cue, isolated to one dim
 */
export function extractFeatures(pcm: Float32Array, sampleRate: number): Float64Array {
  const f = new Float64Array(FEATURE_DIM)
  // Frame starts: 0, hop, 2·hop with hop derived from the actual window length so three frames always
  // tile the available samples (hop = 1024 at 48 kHz / 90 ms).
  const hop = Math.max(1, Math.floor(Math.max(0, pcm.length - FFT_N) / 2))
  const specs = [0, 1, 2].map((i) => powerSpectrum(frameAt(pcm, i * hop), FFT_N))

  // Hop-averaged spectrum → 12 log band energies, mean-subtracted.
  const avg = new Float64Array(specs[0].length)
  for (const s of specs) for (let k = 0; k < avg.length; k++) avg[k] += s[k] / specs.length
  const bands = bandEnergies(avg, sampleRate)
  let mean = 0
  for (let b = 0; b < NUM_BANDS; b++) {
    bands[b] = Math.log(bands[b] + LOG_FLOOR)
    mean += bands[b] / NUM_BANDS
  }
  for (let b = 0; b < NUM_BANDS; b++) f[b] = bands[b] - mean

  const early = Math.round((EARLY_MS / 1000) * sampleRate)
  f[12] = Math.log(rmsOf(pcm, 0, early) + LOG_FLOOR) - Math.log(rmsOf(pcm, early, pcm.length) + LOG_FLOOR)
  f[13] =
    Math.log(spectralCentroidHz(specs[0], sampleRate) + 1) - Math.log(spectralCentroidHz(specs[2], sampleRate) + 1)

  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]))
  const winRms = rmsOf(pcm, 0, pcm.length)
  f[14] = winRms > 0 ? peak / winRms : 0
  f[15] = Math.log(winRms + LOG_FLOOR)
  return f
}
