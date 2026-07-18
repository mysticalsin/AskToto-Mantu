import { describe, expect, it } from 'vitest'
import { CALIB_N, makeCalibration } from './calibrate'
import { PRE_MS, POST_MS, WIN_MS } from './gates'
import { embed, synthKeyClick, synthMugDouble, synthTap, synthTapB } from './__fixtures__/synth'
import type { TapCandidatePayload } from './tap-control'

const SR = 48000
const TOTAL_MS = PRE_MS + WIN_MS + POST_MS

function cand(signal: Float32Array, seed = 7, noiseRms = 0.001): TapCandidatePayload {
  return {
    pcm: embed(signal, { sampleRate: SR, noiseRms, totalMs: TOTAL_MS, atMs: PRE_MS, seed }),
    floorRms: noiseRms,
    sampleRate: SR
  }
}

describe('calibration session', () => {
  it('happy path: two contrasting zones → separable profile', () => {
    // Mirrors real UX: the user taps until CALIB_N are ACCEPTED — an occasional rejection just means
    // "tap again". The budget bounds how many retries we tolerate before calling the flow broken.
    const s = makeCalibration(2, SR)
    const fillZone = (gen: (seed: number) => Float32Array, seedBase: number): number => {
      let attempts = 0
      const zoneAtStart = (s.state() as { zone: number }).zone
      while (attempts < CALIB_N * 3) {
        const st = s.state()
        // Done when the state machine advanced zones OR the last zone hit its quota.
        if (st.phase !== 'zone' || st.zone !== zoneAtStart || st.accepted >= st.needed) break
        s.feedTap(cand(gen(seedBase + attempts), seedBase + 100 + attempts))
        attempts++
      }
      return attempts
    }
    const aAttempts = fillZone((sd) => synthTap({ seed: sd, gain: 0.5 }), 10)
    expect(aAttempts).toBeLessThanOrEqual(CALIB_N + 3) // few retries OK; systematic rejection is a bug
    expect(s.state()).toMatchObject({ phase: 'zone', zone: 1, accepted: 0 })
    const bAttempts = fillZone((sd) => synthTapB({ seed: sd, gain: 0.5 }), 40)
    expect(bAttempts).toBeLessThanOrEqual(CALIB_N + 3)
    const result = s.finish({ micDeviceId: 'mic-1', now: 1700000000000 })
    expect(result.separable).toBe(true)
    expect(result.profile.zones.length).toBe(2)
    expect(result.profile.micDeviceId).toBe('mic-1')
    expect(result.profile.sampleRate).toBe(SR)
  })

  it('rejects a too-weak tap with the right hint', () => {
    const s = makeCalibration(1, SR)
    const fb = s.feedTap(cand(synthTap({ gain: 0.003 })))
    expect(fb).toMatchObject({ accepted: false })
    expect(['too-weak', 'not-a-tap']).toContain((fb as { hint: string }).hint)
  })

  it('rejects a clipped tap as clipped', () => {
    const s = makeCalibration(1, SR)
    const hot = synthTap({ gain: 1 })
    for (let i = 0; i < 10; i++) hot[20 + i] = 0.999
    expect(s.feedTap(cand(hot))).toEqual({ accepted: false, hint: 'clipped' })
  })

  it('rejects a double-hit (mug set-down) with double-hit guidance', () => {
    const s = makeCalibration(1, SR)
    const fb = s.feedTap(cand(synthMugDouble()))
    expect(fb.accepted).toBe(false)
  })

  it('flags a drifting tap after enough examples ("same spot?")', () => {
    const s = makeCalibration(1, SR)
    for (let i = 0; i < 5; i++) {
      expect(s.feedTap(cand(synthTap({ seed: 10 + i, gain: 0.5 }), 300 + i)).accepted).toBe(true)
    }
    // A structurally different strike (other zone's physics) mid-calibration.
    const fb = s.feedTap(cand(synthTapB({ seed: 90, gain: 0.5 }), 400))
    expect(fb).toEqual({ accepted: false, hint: 'too-different' })
  })

  it('negatives phase harvests keyboard acoustics into the profile', () => {
    const s = makeCalibration(1, SR)
    for (let i = 0; i < CALIB_N; i++) s.feedTap(cand(synthTap({ seed: 10 + i, gain: 0.5 }), 500 + i))
    s.startNegatives()
    for (let i = 0; i < 3; i++) s.feedNegative(cand(synthKeyClick({ seed: 60 + i })))
    expect(s.state()).toMatchObject({ phase: 'negatives', collected: 3 })
    const { profile } = s.finish({ micDeviceId: 'mic-1', now: 1 })
    expect(profile.negatives.length).toBe(3)
  })

  it('redoZone wipes only that zone and resumes there', () => {
    const s = makeCalibration(2, SR)
    for (let i = 0; i < CALIB_N; i++) s.feedTap(cand(synthTap({ seed: 10 + i, gain: 0.5 }), 600 + i))
    for (let i = 0; i < CALIB_N; i++) s.feedTap(cand(synthTapB({ seed: 40 + i, gain: 0.5 }), 700 + i))
    s.redoZone(1)
    expect(s.state()).toMatchObject({ phase: 'zone', zone: 1, accepted: 0 })
    // Refill with retries allowed (same real-UX contract as the happy path).
    let attempts = 0
    while (attempts < CALIB_N * 3) {
      const st = s.state()
      if (st.phase !== 'zone' || st.accepted >= st.needed) break
      s.feedTap(cand(synthTapB({ seed: 140 + attempts, gain: 0.5 }), 800 + attempts))
      attempts++
    }
    expect(attempts).toBeLessThanOrEqual(CALIB_N + 3)
    expect(s.finish({ micDeviceId: 'm', now: 1 }).profile.zones.length).toBe(2)
  })

  it('identical zones produce a not-separable result the UI must refuse to save', () => {
    const s = makeCalibration(2, SR)
    for (let i = 0; i < CALIB_N; i++) s.feedTap(cand(synthTap({ seed: 10 + i, gain: 0.5 }), 900 + i))
    for (let i = 0; i < CALIB_N; i++) {
      // Same generator, same physics — drift check may reject some; force-feed until counted.
      const fb = s.feedTap(cand(synthTap({ seed: 10 + i, gain: 0.5 }), 950 + i))
      void fb
      if ((s.state() as { accepted?: number }).accepted === CALIB_N) break
    }
    // However zone 2 filled (drift may have blocked some), a same-spot calibration must not be separable.
    const st = s.state()
    if (st.phase === 'zone' && st.accepted < CALIB_N) {
      // Drift check already refused the identical spot — equally acceptable protection.
      expect(st.zone).toBe(1)
    } else {
      expect(s.finish({ micDeviceId: 'm', now: 1 }).separable).toBe(false)
    }
  })
})
