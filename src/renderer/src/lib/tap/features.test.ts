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
