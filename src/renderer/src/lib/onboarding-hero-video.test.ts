import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_HERO_POSTER_SRC,
  ONBOARDING_HERO_VIDEO_REMOTE_SRC,
  ONBOARDING_HERO_VIDEO_SRC,
  playOnboardingMedia,
  playOnboardingVideo,
  resolveOnboardingHeroVideoSrc
} from './onboarding-hero-video'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const html = readFileSync(join(__dirname, '../../index.html'), 'utf8')

describe('Act 1 welcome video + liquid glass (not a Bloom/Axon page)', () => {
  it('uses Tony’s first-slide clip, muted loop autoplay, object-cover, z-0 under the UI', () => {
    expect(ONBOARDING_HERO_VIDEO_REMOTE_SRC).toMatch(/hf_20260429_115139_0fc6bd3d/)
    expect(ONBOARDING_HERO_VIDEO_SRC).toMatch(/onboarding-hero-lady-planet/)
    expect(ONBOARDING_HERO_POSTER_SRC).toMatch(/onboarding-hero-poster/)
    expect(ONBOARDING_HERO_VIDEO_REMOTE_SRC).not.toMatch(/hf_20260714_113715_c7e0daa0/)
    expect(experience).toMatch(/ONBOARDING_HERO_VIDEO_SRC/)
    expect(experience).toMatch(/muted/)
    expect(experience).toMatch(/loop/)
    expect(experience).toMatch(/autoPlay/)
    expect(experience).toMatch(/preload="auto"/)
    expect(experience).toMatch(/OnboardingHeroVideo/)
    expect(experience).toMatch(/onboard-hero-poster/)
    expect(css).toMatch(/\.onboard-hero-video\s*\{/)
    expect(css).toMatch(/position:\s*absolute/)
    expect(css).toMatch(/object-fit:\s*cover/)
    expect(css).toMatch(/object-position:\s*center/)
    expect(css).toMatch(/onboard-hero-kenburns/)
    expect(css).toMatch(/\.hero-welcome/)
    expect(experience).toMatch(/hero-welcome/)
    expect(css).toMatch(/#3a0b6b/)
    expect(css).toMatch(/#7f00da/)
  })

  it('keeps the hero video mounted through problem/reveal (FITO-185-P keep-alive)', () => {
    // Unmounting on Next killed atmosphere — lady bed stays through problem|reveal.
    expect(experience).toMatch(/\(scene === 'hero' \|\| scene === 'problem' \|\| scene === 'reveal'\) && \(\s*<OnboardingHeroVideo/)
    expect(experience).toMatch(/FITO-185-P: keep lady bed through problem\/reveal/)
    expect(experience).toMatch(/v\?\.pause\(\)/)
    const videoRule = css.slice(css.indexOf('.onboard-hero-video video'))
    const videoBlock = videoRule.slice(0, videoRule.indexOf('}', 8) + 1)
    expect(videoBlock).not.toMatch(/filter:/)
  })

  it('Next and the Tony Walteur byline use liquid glass; logo stays Métis; no Skip', () => {
    expect(experience).toMatch(/onboard-cta no-drag focus-ring/)
    expect(experience).toMatch(/>\s*Next\s*</)
    expect(experience).not.toMatch(/Skip the tour/)
    expect(experience).toMatch(/onboard-glass onboard-glass-chip/)
    expect(experience).toMatch(/Tony Walteur/)
    expect(experience).toMatch(/<MetisMark size=\{96\}/)
    expect(experience).toMatch(/<span aria-hidden="true">\{WORDMARK\}<\/span>/)
    expect(experience).not.toMatch(/useScrambleReveal/)
    expect(css).toMatch(/\.onboard-glass\s*\{/)
    const glass = css.slice(css.indexOf('.onboard-glass {'), css.indexOf('.onboard-glass::before'))
    expect(glass).toMatch(/backdrop-filter:\s*blur\(12px\)/)
    expect(glass).not.toMatch(/blur\((1[3-9]|[2-9]\d)px\)/)
    expect(css).toMatch(/\.onboard-glass::before/)
    expect(css).toMatch(/mask-composite:\s*exclude/)
  })

  it('Get Started and Next call play() in the click, before seek or setState', () => {
    const order: string[] = []
    const video = {
      currentTime: 12,
      play: vi.fn(function (this: { currentTime: number }) {
        order.push('video-play')
        expect(this.currentTime).toBe(12)
        return Promise.resolve()
      })
    } as unknown as HTMLVideoElement
    const audio = {
      currentTime: 8,
      play: vi.fn(function (this: { currentTime: number }) {
        order.push('audio-play')
        expect(this.currentTime).toBe(8)
        return Promise.resolve()
      })
    } as unknown as HTMLAudioElement
    playOnboardingMedia(video, audio, { restart: true })
    order.push('seek')
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(video.play).toHaveBeenCalledTimes(1)
    expect(audio.currentTime).toBe(0)
    expect(video.currentTime).toBe(0)
    expect(order[0]).toBe('audio-play')
    expect(order[1]).toBe('video-play')
    expect(order[2]).toBe('seek')

    const v = {
      currentTime: 4,
      play: vi.fn(function (this: { currentTime: number }) {
        expect(this.currentTime).toBe(4)
        return Promise.resolve()
      })
    } as unknown as HTMLVideoElement
    playOnboardingVideo(v, { restart: true })
    expect(v.currentTime).toBe(0)

    // Observe the actual setters: variable-name regexes missed the regression where
    // restarting audio happened before attempting video. Keep both starts in the click.
    const observed: string[] = []
    function tracked(name: string): HTMLMediaElement {
      return {
        play() { observed.push(`${name}:play`); return Promise.resolve() },
        set currentTime(value: number) { observed.push(`${name}:seek:${value}`) }
      } as unknown as HTMLMediaElement
    }
    playOnboardingMedia(tracked('video') as HTMLVideoElement, tracked('audio') as HTMLAudioElement, { restart: true })
    expect(observed).toEqual(['audio:play', 'video:play', 'audio:seek:0', 'video:seek:0'])
    observed.length = 0
    playOnboardingVideo(tracked('video') as HTMLVideoElement, { restart: true })
    expect(observed).toEqual(['video:play', 'video:seek:0'])

    const src = readFileSync(join(__dirname, './onboarding-hero-video.ts'), 'utf8')
    expect(src).not.toMatch(/currentTime = 0\s*\n\s*void el\.play/)
    expect(src).toMatch(/document\.head\.appendChild/)
    expect(src).not.toMatch(/await el\.play|queueMicrotask|requestAnimationFrame/)
    expect(src).not.toMatch(/function playOnboardingVideo[\s\S]*?setTimeout\(/)

    expect(experience).toMatch(/onBegin=\{\(\) => \{[\s\S]*?music\.start\(\)/)
    expect(experience).toMatch(/setScene\('problem'\)/)
    expect(experience).toMatch(/onboard-mute/)
    expect(experience).not.toMatch(/prefersReducedMotion\(\)[\s\S]{0,80}onboard-mute/)
    const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
    expect(demo).toMatch(/onClick=\{\(\) => \{\s*onPlayVideo\?\.\(\)\s*\n\s*if \(demoNextLeavesTour\(beat\)\) onContinue\(\)/)
    expect(demo).toMatch(/demoPlaybackAfterNext/)
    expect(demo).toMatch(/setLocalMs\(next\.localMs\)/)
    expect(demo).not.toMatch(/setTimeout\(/)
  })

  it('does not ship a Bloom or Axon landing page, and CSP pins only that media host', () => {
    expect(experience).not.toMatch(/Bloom|Axon|Marcus Aurelio|Y Combinator|YC/i)
    expect(css).not.toMatch(/Bloom|Axon/i)
    const policy = html.slice(html.indexOf('content="default-src'))
    const media = policy.slice(policy.indexOf('media-src'), policy.indexOf('connect-src'))
    expect(media).toMatch(/d8j0ntlcm91z4\.cloudfront\.net/)
    expect(media).not.toMatch(/https:\s/)
  })

  it('does not eager-preload from App boot; Act 1 owns local auto load + poster', () => {
    const appSrc = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
    const heroSrc = readFileSync(join(__dirname, './onboarding-hero-video.ts'), 'utf8')
    expect(appSrc).not.toMatch(/preloadOnboardingHeroVideo/)
    expect(experience).toMatch(/preload="auto"/)
    expect(experience).toMatch(/preloadOnboardingHeroVideo\(\)/)
    expect(experience).toMatch(/el\.load\(\)/)
    expect(experience).toMatch(/ONBOARDING_HERO_POSTER_SRC/)
    expect(experience).toMatch(/onboard-hero-poster/)
    expect(heroSrc).toMatch(/document\.head\.appendChild/)
    expect(heroSrc).toMatch(/onboarding-hero-lady-planet\.mp4/)
    expect(css).toMatch(/position:\s*absolute/)
  })

})

describe('FITO-185-L poster paint contracts', () => {
  it('ONBOARDING_HERO_POSTER_SRC is a Vite asset import; poster img always in OnboardingHeroVideo', () => {
    const heroSrc = readFileSync(join(__dirname, './onboarding-hero-video.ts'), 'utf8')
    expect(heroSrc).toMatch(/import localPosterUrl from '\.\.\/assets\/onboarding-hero-poster\.jpg'/)
    expect(heroSrc).toMatch(/export const ONBOARDING_HERO_POSTER_SRC = localPosterUrl/)
    expect(experience).toMatch(/<img className="onboard-hero-poster" src=\{ONBOARDING_HERO_POSTER_SRC\}/)
  })
})

describe('FITO-185-V hero video ready promotion', () => {
  it('marks ready on canplay/timeupdate/playing and 800ms decode fallback', () => {
    expect(experience).toMatch(/onCanPlay=\{markReady\}/)
    expect(experience).toMatch(/onTimeUpdate=\{markReady\}/)
    expect(experience).toMatch(/onPlaying=\{markReady\}/)
    expect(experience).toMatch(/onLoadedData=\{markReady\}/)
    expect(experience).toMatch(/readyState >= 2/)
    expect(experience).toMatch(/currentTime > 0/)
    expect(experience).toMatch(/setTimeout\([\s\S]*?800\)/)
    expect(experience).toMatch(/playOnboardingVideo\(heroVideoRef\.current\)/)
    // Queue the scene first so media startup cannot hold up the visible transition.
    expect(experience).toMatch(
      /onBegin=\{\(\) => \{[\s\S]*?setScene\('problem'\)[\s\S]*?playOnboardingVideo\(heroVideoRef\.current\)/
    )
  })
})

describe('FITO-185-W packaged hero mp4 plays outside asar', () => {
  it('rewrites app.asar media URLs to app.asar.unpacked for Chromium decode', () => {
    const asarBase = 'file:///Applications/Metis.app/Contents/Resources/app.asar/out/renderer/index.html'
    const viteSrc = './assets/onboarding-hero-lady-planet-CpyqQ-62.mp4'
    expect(resolveOnboardingHeroVideoSrc(viteSrc, asarBase)).toBe(
      'file:///Applications/Metis.app/Contents/Resources/app.asar.unpacked/out/renderer/assets/onboarding-hero-lady-planet-CpyqQ-62.mp4'
    )
    // Already unpacked — leave alone
    const unpacked = 'file:///Applications/Metis.app/Contents/Resources/app.asar.unpacked/out/renderer/assets/x.mp4'
    expect(resolveOnboardingHeroVideoSrc(unpacked, asarBase)).toBe(unpacked)
    // Dev server — leave relative / return absolute http
    expect(resolveOnboardingHeroVideoSrc(viteSrc, 'http://localhost:5173/')).toMatch(/onboarding-hero-lady-planet/)
    expect(resolveOnboardingHeroVideoSrc(viteSrc, undefined)).toBe(viteSrc)
  })

  it('Experience uses resolveOnboardingHeroVideoSrc; builder unpacks **/*.mp4; CTA stays hittable', () => {
    expect(experience).toMatch(/resolveOnboardingHeroVideoSrc\(ONBOARDING_HERO_VIDEO_SRC\)/)
    const builder = readFileSync(join(__dirname, '../../../../electron-builder.yml'), 'utf8')
    const unpack = builder.slice(builder.indexOf('asarUnpack:'), builder.indexOf('extraResources:'))
    expect(unpack).toMatch(/\*\*\/\*\.mp4/)
    expect(css).toMatch(/FITO-185-W: kenburns on poster/)
    expect(css).toMatch(/pointer-events:\s*auto\s*!important/)
    expect(css).toMatch(/\.hero-welcome \.onboard-cta/)
    expect(experience).toMatch(
      /onBegin=\{\(\) => \{[\s\S]*?setScene\('problem'\)[\s\S]*?playOnboardingVideo\(heroVideoRef\.current\)/
    )
  })
})

// R11: optional media may fail, but it cannot swallow a navigation click.
describe('R11 optional onboarding media failures', () => {
  it('does not throw on a synchronous play failure', () => {
    const media = { play() { throw new Error('fixture missing media') } } as unknown as HTMLVideoElement
    expect(() => playOnboardingVideo(media, { restart: true })).not.toThrow()
  })
  it('handles rejection before a synchronous seek failure', async () => {
    const media = {
      play: () => Promise.reject(new Error('fixture blocked playback')),
      set currentTime(_value: number) { throw new Error('fixture not seekable') }
    } as unknown as HTMLVideoElement
    expect(() => playOnboardingVideo(media, { restart: true })).not.toThrow()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  it('audio failure cannot prevent an independent video play attempt', () => {
    const audio = { play() { throw new Error('fixture audio failure') } } as unknown as HTMLAudioElement
    const video = { play: vi.fn(() => Promise.resolve()) } as unknown as HTMLVideoElement
    expect(() => playOnboardingMedia(video, audio)).not.toThrow()
    expect(video.play).toHaveBeenCalledOnce()
  })
})

// These assertions exercise the shared production functions, not their source spelling.
describe('R11 repair: two-phase optional media startup', () => {
  for (const fail of ['audio-play', 'video-play', 'audio-seek', 'video-seek'] as const) {
    it(`attempts both starts before seeking even when ${fail} fails`, () => {
      const events: string[] = []
      function media(name: string): HTMLMediaElement {
        return {
          play() {
            events.push(`${name}-play`)
            if (fail === `${name}-play`) throw new Error('fixture media failure')
            return Promise.resolve()
          },
          set currentTime(_value: number) {
            events.push(`${name}-seek`)
            if (fail === `${name}-seek`) throw new Error('fixture seek failure')
          }
        } as unknown as HTMLMediaElement
      }
      expect(() => playOnboardingMedia(media('video') as HTMLVideoElement, media('audio') as HTMLAudioElement, { restart: true })).not.toThrow()
      expect(events).toEqual(['audio-play', 'video-play', 'audio-seek', 'video-seek'])
    })
  }
  it('does not seek when restart is false', () => {
    const seek = vi.fn()
    const video = { play: vi.fn(() => Promise.resolve()), set currentTime(v: number) { seek(v) } } as unknown as HTMLVideoElement
    playOnboardingMedia(video, null)
    expect(video.play).toHaveBeenCalledOnce()
    expect(seek).not.toHaveBeenCalled()
  })
})
