import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_MUSIC_FADE_SECONDS,
  ONBOARDING_MUSIC_FILE,
  ONBOARDING_MUSIC_GAIN,
  onboardingMusicGain,
  onboardingMusicLoopEnvelope,
  playOnboardingAudio
} from './onboarding-music'

const musicDir = join(__dirname, '../assets/music')
const oggPath = join(musicDir, ONBOARDING_MUSIC_FILE)
const licensePath = join(musicDir, 'LICENSE.OPEN-GOLDBERG.txt')
const production = readFileSync(join(__dirname, './onboarding-music.ts'), 'utf8')
const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')

describe('onboarding music — CC0 Goldberg Aria, HTML audio, no choir synth', () => {
  it('bundles a real piano recording ≤ 4MB with a LICENSE note', () => {
    const st = statSync(oggPath)
    expect(st.size).toBeGreaterThan(80_000)
    expect(st.size).toBeLessThanOrEqual(4 * 1024 * 1024)
    const license = readFileSync(licensePath, 'utf8')
    expect(license).toMatch(/Kimiko Ishizaka/)
    expect(license).toMatch(/Goldberg Variations BWV 988/)
    expect(license).toMatch(/CC0 1\.0/)
    expect(license).toMatch(/commons\.wikimedia\.org/)
    expect(production).toMatch(/ONBOARDING_MUSIC_FILE/)
    expect(production).toMatch(/new Audio/)
    expect(production).toMatch(/el\.loop = true/)
  })

  it('has no synthesizeOnboardingPad / AudioBuffer choir pad on the production path', () => {
    expect(production).not.toMatch(/function synthesizeOnboardingPad/)
    expect(production).not.toMatch(/AudioContext|webkitAudioContext/)
    expect(production).not.toMatch(/createBuffer|getChannelData|createDelay/)
    expect(production).not.toMatch(/function choirVoice|ONBOARDING_MUSIC_PAD_SECONDS/)
    expect(experience).not.toMatch(/synthesizeOnboardingPad|AudioContext/)
    expect(experience).toMatch(/createOnboardingMusicBed/)
    expect(experience).toMatch(/playOnboardingMedia/)
    expect(experience).not.toMatch(/void bed\.start\(\)/)
    expect(experience).not.toMatch(/setReducedMotion/)
  })

  it('mute zeros volume; reduced-motion is not a mute switch', () => {
    expect(onboardingMusicGain(true)).toBe(0)
    expect(onboardingMusicGain(false)).toBe(ONBOARDING_MUSIC_GAIN)
    expect(ONBOARDING_MUSIC_GAIN).toBeGreaterThan(0.05)
    expect(ONBOARDING_MUSIC_GAIN).toBeLessThan(0.4)
    expect(production).not.toMatch(/ONBOARDING_MUSIC_REDUCED_GAIN/)
    expect(onboardingMusicGain.length).toBe(1)
    expect(experience).toMatch(/onboard-mute/)
    expect(experience).not.toMatch(/prefersReducedMotion\(\)[\s\S]{0,80}onboard-mute/)
    expect(experience).not.toMatch(/prefersReducedMotion\(\)[\s\S]{0,40}setMuted/)
  })

  it('loops with a cosine fade at both ends', () => {
    expect(ONBOARDING_MUSIC_FADE_SECONDS).toBeGreaterThan(1)
    expect(onboardingMusicLoopEnvelope(0, 300)).toBeCloseTo(0, 5)
    expect(onboardingMusicLoopEnvelope(300, 300)).toBeCloseTo(0, 5)
    expect(onboardingMusicLoopEnvelope(150, 300)).toBe(1)
    expect(onboardingMusicLoopEnvelope(1.2, 300, 2.4)).toBeGreaterThan(0.4)
    expect(onboardingMusicLoopEnvelope(1.2, 300, 2.4)).toBeLessThan(0.6)
  })

  it('play() is the first media call — no seek before play()', () => {
    const order: string[] = []
    const el = {
      currentTime: 12,
      play: vi.fn(function (this: { currentTime: number }) {
        order.push('play')
        expect(this.currentTime).toBe(12)
        return Promise.resolve()
      })
    } as unknown as HTMLAudioElement
    playOnboardingAudio(el, { restart: true })
    order.push('seek')
    expect(el.play).toHaveBeenCalledTimes(1)
    expect(el.currentTime).toBe(0)
    expect(order[0]).toBe('play')
    expect(production).toMatch(/const playing = el\.play\(\)[\s\S]*?if \(opts\.restart\) el\.currentTime = 0/)
  })
})
