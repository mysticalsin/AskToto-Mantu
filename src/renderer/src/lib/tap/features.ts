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

function frameAt(pcm: Float32Array, start: number, frameLen: number): Float32Array {
  // Window ONLY the real samples (a Hann taper over the whole FFT_N would distort a short frame that's
  // mostly zero-pad), then place them at the head of a zero-padded FFT_N buffer so bin resolution stays
  // constant regardless of frame length.
  const f = new Float32Array(FFT_N)
  const m = Math.max(0, Math.min(frameLen, pcm.length - start))
  const w = new Float32Array(m)
  for (let i = 0; i < m; i++) w[i] = pcm[start + i]
  hannWindow(w)
  f.set(w, 0)
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
  // Adaptive frame length: the largest power of two that fits the window, capped at FFT_N. At ≥48 kHz
  // the 90 ms window exceeds FFT_N so frameLen = FFT_N (unchanged behavior). Below ~22.75 kHz (BT/HFP
  // mics) the window is shorter than FFT_N — a fixed FFT_N frame made `hop` collapse to 1, so all three
  // frames started at samples 0/1/2 (identical), zeroing the temporal decay feature f[13]. Shrinking the
  // frame to fit lets the three frames actually tile the short window and keep f[13] discriminative.
  const frameLen = Math.min(FFT_N, 1 << Math.floor(Math.log2(Math.max(2, pcm.length))))
  const hop = Math.max(1, Math.floor((pcm.length - frameLen) / 2))
  const specs = [0, 1, 2].map((i) => powerSpectrum(frameAt(pcm, i * hop, frameLen), FFT_N))

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
