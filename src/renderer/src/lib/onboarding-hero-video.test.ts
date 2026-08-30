import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ONBOARDING_HERO_VIDEO_SRC } from './onboarding-hero-video'

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

  it('Get Started, Skip, and the Tony Walteur byline use liquid glass; logo stays Métis', () => {
    expect(experience).toMatch(/onboard-cta onboard-glass/)
    expect(experience).toMatch(/Skip the tour/)
    expect(experience).toMatch(/onboard-glass onboard-glass-chip/)
    expect(experience).toMatch(/Tony Walteur/)
    expect(experience).toMatch(/<MetisMark size=\{96\}/)
    expect(css).toMatch(/\.onboard-glass\s*\{/)
    expect(css).toMatch(/backdrop-filter:\s*blur/)
    expect(css).toMatch(/\.onboard-glass::before/)
    expect(css).toMatch(/mask-composite:\s*exclude/)
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
