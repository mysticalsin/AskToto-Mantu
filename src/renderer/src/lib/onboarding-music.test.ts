import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_MUSIC_GAIN,
  ONBOARDING_MUSIC_PAD_SECONDS,
  ONBOARDING_MUSIC_REDUCED_GAIN,
  onboardingMusicGain,
  synthesizeOnboardingPad
} from './onboarding-music'

function goertzelPower(samples: Float32Array, sampleRate: number, freq: number): number {
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

describe('onboarding music — original choir bed, mute, reduced-motion duck', () => {
  it('mute is silence; reduced-motion is quieter than the default, never louder', () => {
    expect(onboardingMusicGain(true, false)).toBe(0)
    expect(onboardingMusicGain(true, true)).toBe(0)
    expect(onboardingMusicGain(false, true)).toBe(ONBOARDING_MUSIC_REDUCED_GAIN)
    expect(onboardingMusicGain(false, false)).toBe(ONBOARDING_MUSIC_GAIN)
    expect(ONBOARDING_MUSIC_REDUCED_GAIN).toBeLessThan(ONBOARDING_MUSIC_GAIN)
    expect(ONBOARDING_MUSIC_GAIN).toBeLessThan(0.08)
  })

  it('synthesizes a loop-safe high-register pad (no 110Hz bass, no asset file)', () => {
    expect(ONBOARDING_MUSIC_PAD_SECONDS).toBeGreaterThanOrEqual(20)
    expect(ONBOARDING_MUSIC_PAD_SECONDS).toBeLessThanOrEqual(24)
    const samples = synthesizeOnboardingPad(8000, 1)
    expect(samples.length).toBe(8000)
    let energy = 0
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i]
    expect(energy).toBeGreaterThan(0)
    expect(Math.abs(samples[0])).toBeLessThan(0.01)
    expect(Math.abs(samples[samples.length - 1])).toBeLessThan(0.01)

    const long = synthesizeOnboardingPad(8000, 2)
    const bass = goertzelPower(long, 8000, 110)
    const a3 = goertzelPower(long, 8000, 220)
    const a4 = goertzelPower(long, 8000, 440)
    expect(a3 + a4).toBeGreaterThan(bass * 4)
  })

  it('the bed is Web Audio only — no copyrighted recording, no fetch, no auto-send', () => {
    const src = readFileSync(new URL('./onboarding-music.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/AudioContext/)
    expect(src).toMatch(/setMuted/)
    expect(src).toMatch(/ctx\.destination/)
    expect(src).toMatch(/getChannelData\(0\)\.set\(samples\)/)
    expect(src).toMatch(/createDelay/)
    expect(src).not.toMatch(/copyToChannel/)
    expect(src).not.toMatch(/110\s*\*/)
    expect(src).not.toMatch(/ave maria|pachelbel|canon|amazing grace|hymn/i)
    expect(src).not.toMatch(/beethoven|mozart|bach|mp3|wav|spotify|youtube|itunes/i)
    expect(src).not.toMatch(/fetch\(|window\.toto|playCue\('send'\)/)
  })
})
