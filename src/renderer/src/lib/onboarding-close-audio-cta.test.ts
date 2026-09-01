import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_MUSIC_CLOSE_EVENTS,
  createOnboardingMusicBed,
  haltOnboardingAudio,
  shouldStopOnboardingMusicOnEvent
} from './onboarding-music'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const production = readFileSync(join(__dirname, './onboarding-music.ts'), 'utf8')

function FakeAudio(this: {
  autoplay: boolean
  loop: boolean
  volume: number
  src: string
  currentTime: number
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
  this.preload = 'auto'
  this.pause = vi.fn()
  this.play = vi.fn(() => Promise.resolve())
  this.load = vi.fn()
  this.addEventListener = vi.fn()
  this.removeEventListener = vi.fn()
  this.removeAttribute = vi.fn()
  this.setAttribute = vi.fn()
}

describe('closing onboarding stops audio', () => {
  afterEach(() => {
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

  it('visibility hidden and Escape are close paths that halt playback', () => {
    expect(shouldStopOnboardingMusicOnEvent({ type: 'pagehide' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'beforeunload' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'visibilitychange', visibilityState: 'hidden' })).toBe(
      true
    )
    expect(shouldStopOnboardingMusicOnEvent({ type: 'visibilitychange', visibilityState: 'visible' })).toBe(
      false
    )
    expect(shouldStopOnboardingMusicOnEvent({ type: 'keydown', key: 'Escape' })).toBe(true)
    expect(shouldStopOnboardingMusicOnEvent({ type: 'keydown', key: 'Enter' })).toBe(false)
    expect(ONBOARDING_MUSIC_CLOSE_EVENTS).toEqual([
      'pagehide',
      'beforeunload',
      'visibilitychange',
      'keydown'
    ])

    vi.stubGlobal('Audio', FakeAudio)
    const listeners = new Map<string, (e: { type: string; key?: string }) => void>()
    const target = {
      visibilityState: 'hidden' as Document['visibilityState'],
      addEventListener: (type: string, fn: (e: { type: string }) => void) => {
        listeners.set(type, fn)
      },
      removeEventListener: vi.fn()
    }
    vi.stubGlobal('window', target)
    vi.stubGlobal('document', target)
    const bed = createOnboardingMusicBed()
    expect(listeners.has('pagehide')).toBe(true)
    expect(listeners.has('beforeunload')).toBe(true)
    expect(listeners.has('keydown')).toBe(true)
    expect(listeners.has('visibilitychange')).toBe(true)

    listeners.get('visibilitychange')?.({ type: 'visibilitychange' })
    expect(bed.element.pause).toHaveBeenCalledTimes(1)

    const escBed = createOnboardingMusicBed()
    listeners.get('keydown')?.({ type: 'keydown', key: 'Escape' })
    expect(escBed.element.pause).toHaveBeenCalledTimes(1)
  })

  it('finish, skip Get started, and unmount invoke music.stop', () => {
    const finish = experience.slice(experience.indexOf('const finish = async'))
    expect(finish.indexOf('music.stop()')).toBeGreaterThan(-1)
    expect(finish.indexOf('music.stop()')).toBeLessThan(finish.indexOf('onDone({ mode, recordingConsent: true })'))
    expect(experience).toMatch(/onClick=\{\(\) => void finish\(\)\}/)
    expect(experience).toMatch(/bedRef\.current\?\.stop\(\)/)
    expect(experience).toMatch(/return \(\) => \{\s*bedRef\.current\?\.stop\(\)/)
    expect(production).toMatch(/visibilitychange/)
    expect(production).toMatch(/e\.key === 'Escape'/)
    expect(production).toMatch(/el\.currentTime = 0/)
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
    expect(problem).not.toMatch(/framer-motion/)

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
    expect(css).toMatch(/\.onboard-post-lady,\s*\n\s*\.onboard-post-lady \.onboard-cta \{[\s\S]*?z-index:\s*3/)
    expect(css).toMatch(/\.onboard-starfield \{\s*[\s\S]*?z-index:\s*0/)
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
