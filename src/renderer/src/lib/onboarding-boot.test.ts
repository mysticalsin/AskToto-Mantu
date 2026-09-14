import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isOnboardingBoot,
  exclusiveOnboardingFlag,
  provisionalOnboardingSettings,
  ONBOARDING_BOOT_POSTER_HREF
} from './onboarding-boot'

describe('isOnboardingBoot', () => {
  it('treats missing settings as onboarding (exclusive fail-closed, matches main)', () => {
    expect(isOnboardingBoot(null)).toBe(true)
    expect(isOnboardingBoot(undefined)).toBe(true)
  })

  it('treats onboardingDone false as onboarding', () => {
    const s = provisionalOnboardingSettings()
    expect(s.onboardingDone).toBe(false)
    expect(isOnboardingBoot(s)).toBe(true)
  })

  it('releases once onboardingDone is true', () => {
    const s = { ...provisionalOnboardingSettings(), onboardingDone: true }
    expect(isOnboardingBoot(s)).toBe(false)
  })
})

describe('provisionalOnboardingSettings', () => {
  it('parses as PublicSettings with onboardingDone false', () => {
    const s = provisionalOnboardingSettings()
    expect(s.onboardingDone).toBe(false)
    expect(s.provider).toBe('cloudflare')
    expect(s.hasApiKey).toBe(false)
  })
})

describe('FITO-185-I App boot gate (source contract)', () => {
  const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8')

  it('sync-imports OnboardingV2 so exclusive Act 1 does not wait on a lazy chunk', () => {
    expect(app).toMatch(/import\s*\{\s*OnboardingV2\s*\}\s*from\s*'\.\/components\/OnboardingExperience'/)
    expect(app).not.toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/components\/OnboardingExperience'/)
  })

  it('bypasses the settings/auth loading strip while isOnboardingBoot', () => {
    expect(app).toMatch(/isOnboardingBoot\(/)
    expect(app).toMatch(/provisionalOnboardingSettings\(/)
    expect(app).toMatch(/Onboarding gate FIRST/)
    expect(app).toMatch(/!isOnboardingBoot\(settings\)/)
    // Loading strip must not be the first exclusive paint (onboarding gate comes first).
    const onboardIdx = app.indexOf('Onboarding gate FIRST')
    const stripIdx = app.indexOf('Post-onboarding only:')
    expect(onboardIdx).toBeGreaterThan(0)
    expect(stripIdx).toBeGreaterThan(onboardIdx)
  })

  it('index.html ships a no-JS exclusive bed so force-show is never pure black', () => {
    expect(indexHtml).toMatch(/#05010A/)
    expect(indexHtml).toMatch(/id="boot-bed"/)
    // Real <img> (not only CSS background) — relative public asset under Electron file://
    expect(indexHtml).toMatch(/id="boot-bed-img"/)
    expect(indexHtml).toMatch(/src=['"]onboarding-hero-poster\.jpg['"]/)
    expect(indexHtml).not.toMatch(/src=['"]\/onboarding-hero-poster\.jpg['"]/)
    expect(ONBOARDING_BOOT_POSTER_HREF).toMatch(/onboarding-hero-poster/)
    // Vite may emit /src/... in unit tests; packaged build hashes under assets/. Never the public root path.
    expect(ONBOARDING_BOOT_POSTER_HREF).not.toBe('/onboarding-hero-poster.jpg')
    expect(ONBOARDING_BOOT_POSTER_HREF).toMatch(/assets\/onboarding-hero-poster/)
  })
})

describe('FITO-185-J electron file paths', () => {
  it('boot poster uses Vite asset import, not a leading-slash public path', () => {
    const bootSrc = readFileSync(join(__dirname, './onboarding-boot.ts'), 'utf8')
    expect(bootSrc).toMatch(/import bootPosterUrl from '\.\.\/assets\/onboarding-hero-poster\.jpg'/)
    expect(bootSrc).not.toMatch(/ONBOARDING_BOOT_POSTER_HREF = '\/onboarding-hero-poster\.jpg'/)
  })

  it('exclusive overlay chrome stays opaque #05010A', () => {
    const geo = readFileSync(join(__dirname, '../../../main/island/geometry.ts'), 'utf8')
    expect(geo).toMatch(/EXCLUSIVE_ONBOARDING_BACKGROUND = '#05010A'/)
    expect(geo).toMatch(/if \(onboardingLive\)[\s\S]*?transparent: false/)
  })
})

describe('FITO-185-N exclusiveOnboarding flag', () => {
  it('reads exclusiveOnboarding=1 from search', () => {
    expect(exclusiveOnboardingFlag('?exclusiveOnboarding=1')).toBe(true)
    expect(exclusiveOnboardingFlag('?shotbg=dark')).toBe(false)
    expect(exclusiveOnboardingFlag('')).toBe(false)
  })

  it('forces Act 1 while exclusive flag set even if settings claim done', () => {
    const done = { ...provisionalOnboardingSettings(), onboardingDone: true }
    expect(isOnboardingBoot(done, '?exclusiveOnboarding=1')).toBe(true)
  })

  it('releases Act 1 when done and flag absent (post-recreate)', () => {
    const done = { ...provisionalOnboardingSettings(), onboardingDone: true }
    expect(isOnboardingBoot(done, '')).toBe(false)
  })

  it('main createWindow stamps exclusiveOnboarding on packaged file URL too', () => {
    const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')
    expect(main).toMatch(/exclusiveOnboarding/)
    expect(main).toMatch(/onboardingExclusiveLive\(\)\) params\.set\('exclusiveOnboarding'/)
    // Must not be gated only inside ELECTRON_RENDERER_URL branch.
    expect(main).toMatch(/else if \(qs\)/)
  })
})

describe('FITO-185-T exclusive Act 1 music after interactive', () => {
  it('OnboardingExperience gates Goldberg start on window focus (not mount-only)', () => {
    const experience = readFileSync(
      join(__dirname, '../components/OnboardingExperience.tsx'),
      'utf8'
    )
    expect(experience).toMatch(/FITO-185-T: do not start Goldberg until Act 1 is interactive/)
    expect(experience).toMatch(/document\.hasFocus\(\)/)
    expect(experience).toMatch(/addEventListener\('focus'/)
    // Mount effect must not fire music.start before the focus/fallback gate.
    const mount = experience.slice(
      experience.indexOf('FITO-185-T: do not start Goldberg'),
      experience.indexOf('Demo/Bar/Three chunks')
    )
    expect(mount).toMatch(/kickMusic/)
    expect(mount.indexOf('kickMusic')).toBeLessThan(mount.indexOf("music.start()"))
  })

  it('main exclusive reveal uses showForExclusiveOnboarding under FITO-185-S (no SFS)', () => {
    const main = readFileSync(join(__dirname, '../../../main/index.ts'), 'utf8')
    expect(main).toMatch(/FITO-185-T: without SFS/)
    expect(main).toMatch(/showForExclusiveOnboarding\(win\)/)
    expect(main).toMatch(/showForExclusiveOnboarding\(overlay\)/)
    expect(main).toMatch(/exclusiveOsFullscreenAllowed/)
  })
})

