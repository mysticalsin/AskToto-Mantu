/**
 * Calibrated zone classifier + the rejection math that makes it honest.
 *
 * With 8 examples per zone there is no budget for anything fancier than nearest-centroid in a pooled
 * z-space (equivalent to a shared diagonal-Mahalanobis distance — the most a dataset this small can
 * support without overfitting). The intelligence is in the REJECTIONS:
 *   1. OOD cap D_ACCEPT — derived from the calibration data itself (leave-one-out median + 2.5×MAD),
 *      so it adapts to how tight the user's tapping actually is instead of trusting a magic number.
 *   2. Ambiguity — best/second-best distance ratio must clear a margin, or we'd be coin-flipping.
 *   3. Negatives — a 1-NN veto set harvested from the user's OWN keyboard/mouse during calibration;
 *      if a stored negative is closer than the best zone, the candidate is one of THOSE, not a tap.
 * And in the separability gate: if leave-one-out can't tell the user's chosen spots apart, calibration
 * refuses to save, instead of shipping a classifier that guesses.
 */
import { FEATURE_DIM } from './features'

export const AMBIGUITY_RATIO = 0.8 // d_best/d_second above this = too close to call → reject
export const D_ACCEPT_MAD_K = 2.5 // D_ACCEPT = LOO median + K × MAD — robust to one weird calib tap
export const MAX_NEGATIVES = 24
export const SEPARABILITY_MIN_ACC = 0.9 // LOO accuracy the calibration set must reach to save
export const SEPARABILITY_MAX_MARGIN = 0.7 // …and the median cross-zone margin ratio it must beat
export const STD_FLOOR = 1e-3 // σ floor: a feature with no calibration variance must not explode z

export interface TapProfile {
  version: 1
  sampleRate: number
  micDeviceId: string
  mean: number[]
  std: number[]
  zones: Array<{ name: string; centroid: number[] }>
  negatives: number[][]
  dAccept: number
  /** log-RMS range seen across accepted calibration taps — feeds the runtime level-band gate. */
  levelRange: { min: number; max: number }
  createdAt: number
}

export interface CalibExample {
  zone: number
  features: Float64Array | number[]
  logRms: number
}

export type Classification =
  | { ok: true; zone: number; distance: number; margin: number }
  | { ok: false; reason: 'ood' | 'ambiguous' | 'negative' | 'no-profile' }

const zscore = (f: ArrayLike<number>, mean: number[], std: number[]): Float64Array => {
  const z = new Float64Array(FEATURE_DIM)
  for (let i = 0; i < FEATURE_DIM; i++) z[i] = (f[i] - mean[i]) / std[i]
  return z
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let s = 0
  for (let i = 0; i < FEATURE_DIM; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return Math.sqrt(s)
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Pooled per-feature mean/σ over all POSITIVE examples (negatives must not warp the tap-space). */
function pooledStats(examples: CalibExample[]): { mean: number[]; std: number[] } {
  const n = examples.length
  const mean = new Array<number>(FEATURE_DIM).fill(0)
  const std = new Array<number>(FEATURE_DIM).fill(0)
  for (const e of examples) for (let i = 0; i < FEATURE_DIM; i++) mean[i] += e.features[i] / n
  for (const e of examples) {
    for (let i = 0; i < FEATURE_DIM; i++) {
      const d = e.features[i] - mean[i]
      std[i] += (d * d) / n
    }
  }
  for (let i = 0; i < FEATURE_DIM; i++) std[i] = Math.max(Math.sqrt(std[i]), STD_FLOOR)
  return { mean, std }
}

function centroidOf(zs: Float64Array[]): number[] {
  const c = new Array<number>(FEATURE_DIM).fill(0)
  for (const z of zs) for (let i = 0; i < FEATURE_DIM; i++) c[i] += z[i] / zs.length
  return c
}

export interface BuildResult {
  profile: TapProfile
  looAccuracy: number
  medianMargin: number
  separable: boolean
}

/**
 * Turn accepted calibration examples (+ optional negatives) into a profile, and judge whether the
 * user's chosen spots are actually distinguishable. Callers must refuse to persist when !separable.
 */
export function buildProfile(
  examples: CalibExample[],
  negatives: Array<Float64Array | number[]>,
  meta: { sampleRate: number; micDeviceId: string; now: number }
): BuildResult {
  const zoneIds = [...new Set(examples.map((e) => e.zone))].sort((a, b) => a - b)
  const { mean, std } = pooledStats(examples)
  const zByZone = new Map<number, Float64Array[]>(zoneIds.map((z) => [z, []]))
  for (const e of examples) zByZone.get(e.zone)!.push(zscore(e.features, mean, std))

  // Leave-one-out: distance of each example to its OWN zone's centroid recomputed without it —
  // the honest estimate of "how far does one of MY real taps sit from home".
  const loo: number[] = []
  const margins: number[] = []
  let looCorrect = 0
  for (const e of examples) {
    const z = zscore(e.features, mean, std)
    const own = zByZone.get(e.zone)!
    // Rebuild own-zone centroid without this example (identify it by exact-distance match).
    const rest = own.filter((v) => dist(v, z) > 1e-12)
    const ownCentroid = centroidOf(rest.length > 0 ? rest : own)
    const dOwn = dist(z, ownCentroid)
    loo.push(dOwn)
    if (zoneIds.length > 1) {
      let dBest = Infinity
      let bestZone = e.zone
      let dSecond = Infinity
      for (const zid of zoneIds) {
        const c = zid === e.zone ? ownCentroid : centroidOf(zByZone.get(zid)!)
        const d = dist(z, c)
        if (d < dBest) {
          dSecond = dBest
          dBest = d
          bestZone = zid
        } else if (d < dSecond) {
          dSecond = d
        }
      }
      if (bestZone === e.zone) looCorrect++
      if (dSecond < Infinity && dSecond > 0) margins.push(dBest / dSecond)
    } else {
      looCorrect++
    }
  }
  const looMedian = median(loo)
  const mad = median(loo.map((d) => Math.abs(d - looMedian)))
  const dAccept = looMedian + D_ACCEPT_MAD_K * Math.max(mad, 0.1) // MAD floor: a too-tight calib set
  // must not produce a cap so strict that real (slightly varied) taps all fail.

  const logRmss = examples.map((e) => e.logRms)
  const profile: TapProfile = {
    version: 1,
    sampleRate: meta.sampleRate,
    micDeviceId: meta.micDeviceId,
    mean,
    std,
    zones: zoneIds.map((z) => ({ name: `Zone ${z + 1}`, centroid: centroidOf(zByZone.get(z)!) })),
    negatives: negatives.slice(0, MAX_NEGATIVES).map((n) => [...zscore(n, mean, std)]),
    dAccept,
    levelRange: { min: Math.min(...logRmss), max: Math.max(...logRmss) },
    createdAt: meta.now
  }
  const looAccuracy = examples.length > 0 ? looCorrect / examples.length : 0
  const medianMargin = margins.length > 0 ? median(margins) : 0
  const separable =
    zoneIds.length < 2 || (looAccuracy >= SEPARABILITY_MIN_ACC && medianMargin <= SEPARABILITY_MAX_MARGIN)
  return { profile, looAccuracy, medianMargin, separable }
}

/** Classify one gated candidate's features against the profile. */
export function classify(features: Float64Array | number[], profile: TapProfile | null): Classification {
  if (!profile || profile.zones.length === 0) return { ok: false, reason: 'no-profile' }
  const z = zscore(features, profile.mean, profile.std)
  let best = -1
  let dBest = Infinity
  let dSecond = Infinity
  for (let k = 0; k < profile.zones.length; k++) {
    const d = dist(z, profile.zones[k].centroid)
    if (d < dBest) {
      dSecond = dBest
      dBest = d
      best = k
    } else if (d < dSecond) {
      dSecond = d
    }
  }
  if (dBest > profile.dAccept) return { ok: false, reason: 'ood' }
  if (profile.zones.length > 1 && dBest / dSecond > AMBIGUITY_RATIO) return { ok: false, reason: 'ambiguous' }
  for (const n of profile.negatives) {
    if (dist(z, n) < dBest) return { ok: false, reason: 'negative' }
  }
  return { ok: true, zone: best, distance: dBest, margin: dSecond < Infinity ? dBest / dSecond : 0 }
}
