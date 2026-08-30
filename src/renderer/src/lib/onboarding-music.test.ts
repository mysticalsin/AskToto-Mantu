import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_MUSIC_GAIN,
  ONBOARDING_MUSIC_REDUCED_GAIN,
  onboardingMusicGain,
  synthesizeOnboardingPad
} from './onboarding-music'

describe('onboarding music — original bed, mute, reduced-motion duck', () => {
  it('mute is silence; reduced-motion is quieter than the default, never louder', () => {
    expect(onboardingMusicGain(true, false)).toBe(0)
    expect(onboardingMusicGain(true, true)).toBe(0)
    expect(onboardingMusicGain(false, true)).toBe(ONBOARDING_MUSIC_REDUCED_GAIN)
    expect(onboardingMusicGain(false, false)).toBe(ONBOARDING_MUSIC_GAIN)
    expect(ONBOARDING_MUSIC_REDUCED_GAIN).toBeLessThan(ONBOARDING_MUSIC_GAIN)
    expect(ONBOARDING_MUSIC_GAIN).toBeLessThan(0.08)
  })

  it('synthesizes a loop-safe original pad (no asset file)', () => {
    const samples = synthesizeOnboardingPad(8000, 1)
    expect(samples.length).toBe(8000)
    let energy = 0
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i]
    expect(energy).toBeGreaterThan(0)
    expect(Math.abs(samples[0])).toBeLessThan(0.01)
    expect(Math.abs(samples[samples.length - 1])).toBeLessThan(0.01)
  })

  it('the bed is Web Audio only — no copyrighted recording, no fetch, no auto-send', () => {
    const src = readFileSync(new URL('./onboarding-music.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/AudioContext/)
    expect(src).toMatch(/setMuted/)
    expect(src).toMatch(/ctx\.destination/)
    expect(src).not.toMatch(/beethoven|mozart|bach|mp3|wav|spotify|youtube|itunes/i)
    expect(src).not.toMatch(/fetch\(|window\.toto|playCue\('send'\)/)
  })
})
