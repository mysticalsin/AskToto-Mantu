import { describe, expect, it } from 'vitest'
import { buildProfile, classify, type CalibExample } from './classify'
import { extractFeatures } from './features'
import { synthKeyClick, synthTap, synthTapB } from './__fixtures__/synth'

const SR = 48000
const META = { sampleRate: SR, micDeviceId: 'test-mic', now: 1700000000000 }

/** 8 calibration examples per zone, seeds varied like real repeated taps. */
function calibSet(): CalibExample[] {
  const out: CalibExample[] = []
  for (let s = 0; s < 8; s++) {
    const a = synthTap({ seed: 10 + s, gain: 0.45 + 0.01 * s })
    out.push({ zone: 0, features: extractFeatures(a, SR), logRms: Math.log(0.1 + 0.01 * s) })
    const b = synthTapB({ seed: 30 + s, gain: 0.45 + 0.01 * s })
    out.push({ zone: 1, features: extractFeatures(b, SR), logRms: Math.log(0.1 + 0.01 * s) })
  }
  return out
}

describe('tap classifier', () => {
  it('two contrasting zones calibrate as separable and classify correctly', () => {
    const { profile, looAccuracy, separable } = buildProfile(calibSet(), [], META)
    expect(separable).toBe(true)
    expect(looAccuracy).toBeGreaterThanOrEqual(0.9)

    const holdoutA = extractFeatures(synthTap({ seed: 99, gain: 0.5 }), SR)
    const holdoutB = extractFeatures(synthTapB({ seed: 98, gain: 0.5 }), SR)
    const ra = classify(holdoutA, profile)
    const rb = classify(holdoutB, profile)
    expect(ra).toMatchObject({ ok: true, zone: 0 })
    expect(rb).toMatchObject({ ok: true, zone: 1 })
  })

  it('identical spots fail the separability gate instead of shipping a coin flip', () => {
    // Both "zones" calibrated from the SAME generator — acoustically indistinguishable.
    const same: CalibExample[] = []
    for (let s = 0; s < 8; s++) {
      same.push({ zone: 0, features: extractFeatures(synthTap({ seed: 50 + s }), SR), logRms: -2 })
      same.push({ zone: 1, features: extractFeatures(synthTap({ seed: 70 + s }), SR), logRms: -2 })
    }
    const { separable, looAccuracy } = buildProfile(same, [], META)
    expect(separable).toBe(false)
    expect(looAccuracy).toBeLessThan(0.9)
  })

  it('rejects out-of-distribution sounds (key click) via the OOD cap', () => {
    const { profile } = buildProfile(calibSet(), [], META)
    const click = extractFeatures(synthKeyClick(), SR)
    const r = classify(click, profile)
    expect(r.ok).toBe(false)
  })

  it('negative examples veto sounds that sneak inside the OOD cap', () => {
    const { profile } = buildProfile(
      calibSet(),
      // The user's calibrated keyboard: clicks stored as negatives.
      [0, 1, 2].map((s) => extractFeatures(synthKeyClick({ seed: 80 + s }), SR)),
      META
    )
    const click = extractFeatures(synthKeyClick({ seed: 83 }), SR)
    const r = classify(click, profile)
    expect(r.ok).toBe(false)
    // Whether it dies by 'ood' or 'negative', it must NOT classify as a zone tap.
  })

  it('D_ACCEPT is robust to one outlier calibration tap', () => {
    const set = calibSet()
    // Corrupt one example massively.
    const bad = set[0].features as Float64Array
    for (let i = 0; i < bad.length; i++) bad[i] += 50
    const { profile } = buildProfile(set, [], META)
    // A clean holdout must still be accepted — median+MAD shrugged the outlier off.
    const r = classify(extractFeatures(synthTap({ seed: 99, gain: 0.5 }), SR), profile)
    expect(r.ok).toBe(true)
  })

  it('single-zone profiles skip the ambiguity test but keep the OOD cap', () => {
    const solo = calibSet().filter((e) => e.zone === 0)
    const { profile, separable } = buildProfile(solo, [], META)
    expect(separable).toBe(true) // one zone: nothing to separate
    expect(classify(extractFeatures(synthTap({ seed: 99, gain: 0.5 }), SR), profile)).toMatchObject({
      ok: true,
      zone: 0
    })
    expect(classify(extractFeatures(synthKeyClick(), SR), profile).ok).toBe(false)
  })

  it('classify without a profile refuses', () => {
    expect(classify(new Float64Array(16), null)).toEqual({ ok: false, reason: 'no-profile' })
  })

  it('profile round-trips through JSON (settings persistence shape)', () => {
    const { profile } = buildProfile(calibSet(), [extractFeatures(synthKeyClick(), SR)], META)
    const revived = JSON.parse(JSON.stringify(profile))
    const f = extractFeatures(synthTap({ seed: 99, gain: 0.5 }), SR)
    expect(classify(f, revived)).toEqual(classify(f, profile))
  })
})
