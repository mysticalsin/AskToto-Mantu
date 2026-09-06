import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_MUSIC_CLOSE_EVENTS,
  createOnboardingMusicBed,
  haltAllOnboardingAudio,
  haltOnboardingAudio,
  isOnboardingAudioLocked,
  lockOnboardingAudio,
  shouldStopOnboardingMusicOnEvent,
  unlockOnboardingAudio
} from './onboarding-music'
import { ONBOARDING_AUDIO_LOCK_EVENT } from '@shared/onboarding-audio'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const settings = readFileSync(join(__dirname, '../components/Settings.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const production = readFileSync(join(__dirname, './onboarding-music.ts'), 'utf8')

function FakeAudio(this: {
  autoplay: boolean
  loop: boolean
  volume: number
  src: string
  currentTime: number
  paused: boolean
  preload: string
  pause: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  removeAttribute: ReturnType<typeof vi.fn>
  setAttribute: ReturnType<typeof vi.fn>
}) {
  this.autoplay = true
  this.loop = true
  this.volume = 1
  this.src = 'aria'
  this.currentTime = 18
  this.paused = false
  this.preload = 'auto'
  this.pause = vi.fn(function (this: { paused: boolean }) {
    this.paused = true
  })
  this.play = vi.fn(() => Promise.resolve())
  this.load = vi.fn()
  this.addEventListener = vi.fn()
  this.removeEventListener = vi.fn()
  this.removeAttribute = vi.fn()
  this.setAttribute = vi.fn()
}

describe('closing onboarding hard-stops the Goldberg Aria', () => {
  afterEach(() => {
    haltAllOnboardingAudio()
    unlockOnboardingAudio()
    vi.unstubAllGlobals()
  })

  it('halt + bed.stop spy pause and reset the element', () => {
    vi.stubGlobal('Audio', FakeAudio)
    const bed = createOnboardingMusicBed()
    const el = bed.element
    expect(el.pause).not.toHaveBeenCalled()
    bed.stop()
    expect(el.pause).toHaveBeenCalledTimes(1)
    expect(el.currentTime).toBe(0)
    expect(el.volume).toBe(0)
    expect(el.loop).toBe(false)
    expect(el.autoplay).toBe(false)
    expect(el.src).toBe('')
    expect(el.load).toHaveBeenCalled()
    bed.start()
    expect(el.play).not.toHaveBeenCalled()
  })

  it('Act 6 Ready, unmount, and Replay call haltAll before the onboardingDone patch', () => {
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(finish.indexOf('haltAllOnboardingAudio()')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
    expect(experience).toMatch(/canMarkOnboardingDone\(\{ scene, asrReady, consent \}\)/)
    expect(experience).toMatch(/return \(\) => \{\s*haltAllOnboardingAudio\(\)/)
    expect(experience).not.toMatch(/if \(!bedRef\.current && typeof Audio/)

    const v2 = experience.slice(experience.indexOf('onDone={async ({ mode, recordingConsent })'))
    expect(v2.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(v2.indexOf('haltAllOnboardingAudio()')).toBeLessThan(v2.indexOf('onboardingDone: true'))

    const replay = settings.slice(settings.indexOf('Replay onboarding from the start?'))
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeGreaterThan(-1)
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeLessThan(replay.indexOf('patch({ onboardingDone: false })'))
    expect(production).toMatch(/querySelectorAll\('audio'\)/)
    expect(production).toMatch(/function haltAllOnboardingAudio/)
  })

  it('window close / hide / Escape halt every bed', () => {
    expect(shouldStopOnboardingMusicOnEvent({ type: 'pagehide' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'beforeunload' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'visibilitychange', visibilityState: 'hidden' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'visibilitychange', visibilityState: 'visible' })).toBe(false)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'keydown', key: 'Escape' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'keydown', key: 'Enter' })).toBe(false)
    expect(ONBOARDING_MUSIC_CLOSE_EVENTS).toEqual(['pagehide', 'beforeunload', 'visibilitychange', 'keydown'])
    expect(production).toMatch(/haltAllOnboardingAudio\(\)/)
  })

  it('two Audio() instances cannot play after haltAll', () => {
    vi.stubGlobal('Audio', FakeAudio)
    const a = createOnboardingMusicBed()
    const b = createOnboardingMusicBed()
    const strayPause = vi.fn()
    const stray = {
      autoplay: true,
      loop: true,
      volume: 0.3,
      src: 'stray',
      currentTime: 4,
      pause: strayPause,
      load: vi.fn(),
      removeAttribute: vi.fn()
    } as unknown as HTMLAudioElement
    const querySelectorAll = vi.fn(() => [stray])
    vi.stubGlobal('document', { querySelectorAll, addEventListener: vi.fn(), removeEventListener: vi.fn() })

    haltAllOnboardingAudio()
    expect(a.element.pause).toHaveBeenCalled()
    expect(b.element.pause).toHaveBeenCalled()
    expect(strayPause).toHaveBeenCalled()
    a.start()
    b.start()
    expect(a.element.play).not.toHaveBeenCalled()
    expect(b.element.play).not.toHaveBeenCalled()
  })

  it('after finish lock, music cannot play or restart', () => {
    vi.stubGlobal('Audio', FakeAudio)
    const bed = createOnboardingMusicBed()
    bed.start()
    expect(bed.element.play).toHaveBeenCalledTimes(1)
    lockOnboardingAudio()
    expect(isOnboardingAudioLocked()).toBe(true)
    expect(bed.element.pause).toHaveBeenCalled()
    expect(bed.element.src).toBe('')
    bed.start()
    expect(bed.element.play).toHaveBeenCalledTimes(1)
    const after = createOnboardingMusicBed()
    after.start()
    expect(after.element.play).not.toHaveBeenCalled()
    expect(isOnboardingAudioLocked()).toBe(true)
  })

  it('Ready finish, App after onboardingDone, and exclusive exit lock before leftover play', () => {
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('lockOnboardingAudio()')).toBeGreaterThan(-1)
    expect(finish.indexOf('lockOnboardingAudio()')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
    const v2 = experience.slice(experience.indexOf('onDone={async ({ mode, recordingConsent })'))
    expect(v2.indexOf('lockOnboardingAudio()')).toBeGreaterThan(-1)
    expect(v2.indexOf('lockOnboardingAudio()')).toBeLessThan(v2.indexOf('onboardingDone: true'))

    const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
    expect(app).toMatch(/if \(settings\?\.onboardingDone\) lockOnboardingAudio\(\)/)
    expect(app).toMatch(/installOnboardingAudioLockHooks\(\)/)

    const index = readFileSync(join(__dirname, '../../main/index.ts'), 'utf8')
    expect(index).toMatch(/function lockOnboardingAudioInRenderer/)
    expect(index).toMatch(/ONBOARDING_AUDIO_LOCK_EVENT/)
    const exit = index.slice(index.indexOf('function exitExclusiveOnboardingStage'), index.indexOf('function applyOverlayAlwaysOnTop'))
    expect(exit.indexOf('lockOnboardingAudioInRenderer(win)')).toBeGreaterThan(-1)
    expect(exit.indexOf('lockOnboardingAudioInRenderer(win)')).toBeLessThan(exit.indexOf('leaveExclusiveOsFullscreen'))

    const replay = settings.slice(settings.indexOf('Replay onboarding from the start?'))
    expect(replay.indexOf('unlockOnboardingAudio()')).toBeGreaterThan(-1)
    expect(replay.indexOf('haltAllOnboardingAudio()')).toBeLessThan(replay.indexOf('unlockOnboardingAudio()'))
    expect(replay.indexOf('unlockOnboardingAudio()')).toBeLessThan(replay.indexOf('patch({ onboardingDone: false })'))
    expect(ONBOARDING_AUDIO_LOCK_EVENT).toBe('metis-onboarding-audio-lock')
  })

  it('haltOnboardingAudio spies pause even without a bed', () => {
    const pause = vi.fn()
    const el = {
      autoplay: true,
      loop: true,
      volume: 0.3,
      src: 'x',
      currentTime: 9,
      pause,
      load: vi.fn(),
      removeAttribute: vi.fn()
    } as unknown as HTMLAudioElement
    haltOnboardingAudio(el)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(el.currentTime).toBe(0)
  })
})

describe('post-lady Continue is visible without hover', () => {
  it('problem Continue is opacity 1 above the starfield, not pointer-events-only', () => {
    const problem = experience.slice(experience.indexOf("scene === 'problem'"), experience.indexOf("scene === 'reveal'"))
    expect(problem).toMatch(/onboard-post-lady/)
    expect(problem).toMatch(/className="onboard-cta no-drag focus-ring"/)
    expect(problem.search(/>\s*Continue\s*</)).toBeGreaterThan(-1)
    expect(problem).not.toMatch(/opacity-0/)
    expect(problem).not.toMatch(/hover:opacity/)
    expect(problem).not.toMatch(/group-hover/)
    expect(problem).not.toMatch(/initial:\s*\{[^}]*opacity:\s*0/)

    const cta = css.slice(css.indexOf('.onboard-cta {'), css.indexOf('.onboard-mute {'))
    expect(cta).toMatch(/opacity:\s*1/)
    expect(cta).toMatch(/pointer-events:\s*auto/)
    expect(cta).toMatch(/position:\s*relative/)
    expect(cta).toMatch(/z-index:\s*3/)
    expect(cta).not.toMatch(/opacity:\s*0/)

    const hover = css.slice(css.indexOf('.onboard-cta:hover:not(:disabled) {'), css.indexOf('.onboard-cta:disabled'))
    expect(hover).toMatch(/transform:\s*scale\(1\.02\)/)
    expect(hover).not.toMatch(/opacity/)
    expect(hover).not.toMatch(/pointer-events:\s*none/)

    expect(css).toMatch(/\.onboard-tour-slot,\s*\n\s*\.onboard-tour-chrome \{\s*position:\s*relative;\s*z-index:\s*2/)
    expect(css).toMatch(/\.onboard-post-lady,\s*\n\s*\.onboard-post-lady \.onboard-cta \{[\s\S]*?opacity:\s*1/)
    expect(css).toMatch(/\.onboard-kinetic-grid \{\s*[\s\S]*?z-index:\s*0/)
    expect(experience).toMatch(/onboard-tour-chrome/)
  })

  it('persona click targets do not start at opacity 0', () => {
    const persona = css.slice(css.indexOf('.onboard-persona {'), css.indexOf('.onboard-persona:hover'))
    expect(persona).toMatch(/opacity:\s*1/)
    expect(persona).not.toMatch(/onboard-pop-in/)
    expect(persona).not.toMatch(/animation-fill-mode:\s*both/)
    expect(css).toMatch(/\.onboard-stage \.onboard-pop-in \{\s*animation:\s*none;\s*opacity:\s*1/)
  })
})
