import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_HERO_VIDEO_SRC,
  playOnboardingMedia,
  playOnboardingVideo
} from './onboarding-hero-video'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const html = readFileSync(join(__dirname, '../../index.html'), 'utf8')

describe('Act 1 welcome video + liquid glass (not a Bloom/Axon page)', () => {
  it('uses Tony’s first-slide clip, muted loop autoplay, object-cover, z-0 under the UI', () => {
    expect(ONBOARDING_HERO_VIDEO_SRC).toBe(
      'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260714_113715_c7e0daa0-8bdd-4486-a2da-040901f8f0ea.mp4'
    )
    expect(experience).toMatch(/ONBOARDING_HERO_VIDEO_SRC/)
    expect(experience).toMatch(/muted/)
    expect(experience).toMatch(/loop/)
    expect(experience).toMatch(/autoPlay/)
    expect(experience).toMatch(/OnboardingHeroVideo/)
    expect(experience).toMatch(/prefersReducedMotion\(\) \|\| failed/)
    expect(css).toMatch(/\.onboard-hero-video\s*\{/)
    expect(css).toMatch(/z-index:\s*0/)
    expect(css).toMatch(/object-fit:\s*cover/)
    expect(css).toMatch(/#3a0b6b/)
    expect(css).toMatch(/#7f00da/)
  })

  it('unmounts the hero video after Act 1 so it is not compositing later', () => {
    expect(experience).toMatch(/\{scene === 'hero' && <OnboardingHeroVideo/)
    expect(experience).toMatch(/el\?\.pause\(\)/)
    const videoRule = css.slice(css.indexOf('.onboard-hero-video video'))
    const videoBlock = videoRule.slice(0, videoRule.indexOf('}', 8) + 1)
    expect(videoBlock).not.toMatch(/filter:/)
  })

  it('Next, Skip, and the Tony Walteur byline use liquid glass; logo stays Métis', () => {
    expect(experience).toMatch(/onboard-cta onboard-glass/)
    expect(experience).toMatch(/>\s*Next\s*</)
    expect(experience).toMatch(/Skip the tour/)
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

    const src = readFileSync(join(__dirname, './onboarding-hero-video.ts'), 'utf8')
    expect(src).toMatch(/const playing = el\.play\(\)[\s\S]*?if \(opts\.restart\) el\.currentTime = 0/)
    expect(src).toMatch(/const audioPlay = audio\?\.play\(\)[\s\S]*?const videoPlay = video\?\.play\(\)/)
    expect(src).not.toMatch(/currentTime = 0\s*\n\s*void el\.play/)
    expect(src).not.toMatch(/await el\.play|setTimeout\(|queueMicrotask|requestAnimationFrame/)

    expect(experience).toMatch(/onBegin=\{\(\) => \{\s*playOnboardingVideo\(/)
    expect(experience).toMatch(/playOnboardingVideo\(heroVideoRef\.current, \{ restart: true \}\)/)
    expect(experience).toMatch(/onboard-mute/)
    expect(experience).not.toMatch(/prefersReducedMotion\(\)[\s\S]{0,80}onboard-mute/)
    const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
    expect(demo).toMatch(/onClick=\{\(\) => \{\s*onPlayVideo\?\.\(\)\s*\n\s*advance\(\)/)
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
})
