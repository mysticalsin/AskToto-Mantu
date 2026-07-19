import { describe, expect, it } from 'vitest'
import { FEATURE_DIM, extractFeatures } from './features'
import { synthKeyClick, synthTap, synthTapB } from './__fixtures__/synth'

describe('tap features', () => {
  it('is deterministic', () => {
    const tap = synthTap()
    const a = extractFeatures(tap, 48000)
    const b = extractFeatures(tap, 48000)
    expect([...a]).toEqual([...b])
    expect(a.length).toBe(FEATURE_DIM)
  })

  it('spectral shape is gain-invariant; only the level dim moves', () => {
    const loud = synthTap({ gain: 0.8 })
    const soft = new Float32Array(loud.length)
    for (let i = 0; i < loud.length; i++) soft[i] = loud[i] * 0.25
    const fLoud = extractFeatures(loud, 48000)
    const fSoft = extractFeatures(soft, 48000)
    // Shape dims (0..11) and temporal ratios (12..14) unchanged by pure gain.
    for (let i = 0; i < 15; i++) expect(fSoft[i]).toBeCloseTo(fLoud[i], 6)
    // Level dim moves by exactly log(0.25).
    expect(fSoft[15] - fLoud[15]).toBeCloseTo(Math.log(0.25), 3)
  })

  it('separates a desk tap from a key click in shape space', () => {
    const tap = extractFeatures(synthTap(), 48000)
    const click = extractFeatures(synthKeyClick(), 48000)
    // Distance over the 12 shape dims must dominate the noise floor between two same-class taps.
    const tap2 = extractFeatures(synthTap({ seed: 9 }), 48000)
    const d = (a: Float64Array, b: Float64Array): number => {
      let s = 0
      for (let i = 0; i < 12; i++) s += (a[i] - b[i]) ** 2
      return Math.sqrt(s)
    }
    expect(d(tap, click)).toBeGreaterThan(3 * d(tap, tap2))
  })

  it('separates the two synthetic zones', () => {
    const a = extractFeatures(synthTap(), 48000)
    const b = extractFeatures(synthTapB(), 48000)
    let s = 0
    for (let i = 0; i < 12; i++) s += (a[i] - b[i]) ** 2
    expect(Math.sqrt(s)).toBeGreaterThan(0.5)
  })

  it('keeps frames temporally distinct on low-rate mics (window shorter than FFT_N)', () => {
    // 16 kHz BT/HFP mic: a 90ms window = 1440 samples < FFT_N(2048). The old fixed-frame path collapsed
    // hop to 1 → frames at 0/1/2 (identical), so f[13] (centroid drop, frame0→frame2) was ~0 for every
    // input regardless of real spectral change. A rising chirp is the direct probe: its early frame is
    // low-centroid and its late frame high-centroid, so f[13] MUST be strongly non-zero once the frames
    // actually tile the window. On the old code this collapsed to ~0.
    const sr = 16000
    const n = Math.round(0.09 * sr)
    const chirp = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const f0 = 200 + ((3000 - 200) * i) / n // 200 Hz → 3 kHz sweep across the window
      chirp[i] = Math.sin(2 * Math.PI * f0 * t)
    }
    const feat = extractFeatures(chirp, sr)
    expect(Math.abs(feat[13])).toBeGreaterThan(0.2)
  })

  it('cross-rate drift (44.1k vs 48k) stays small relative to class separation', () => {
    // The REAL requirement is not bit-identical features across rates (empty bands are leakage-skirt
    // noise; log of a tiny number is jittery) — it's that a rate change moves a tap LESS than the
    // distance to a different sound class, and that the temporal dims (which carry the decay physics)
    // are rock-solid. Full protection is the runtime's profile.sampleRate stamp → recalibrate prompt.
    const at48 = extractFeatures(synthTap({ sampleRate: 48000 }), 48000)
    const at44 = extractFeatures(synthTap({ sampleRate: 44100 }), 44100)
    const click = extractFeatures(synthKeyClick(), 48000)
    const d = (a: Float64Array, b: Float64Array): number => {
      let s = 0
      for (let i = 0; i < 12; i++) s += (a[i] - b[i]) ** 2
      return Math.sqrt(s)
    }
    expect(d(at48, at44)).toBeLessThan(0.5 * d(at48, click))
    // Integral-based temporal dims (decay ratio, centroid drop, level) are rate-independent physics.
    for (const i of [12, 13, 15]) expect(at44[i]).toBeCloseTo(at48[i], 1)
    // Crest is a single-sample PEAK statistic — the sampling grid catches the true waveform peak
    // slightly differently per rate, so hold it to 5% relative rather than an absolute epsilon.
    expect(Math.abs(at44[14] - at48[14]) / at48[14]).toBeLessThan(0.05)
  })
})
