import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isOnboardingBoot,
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

  it('does not sync-import OnboardingExperience on the App critical path', () => {
    expect(app).not.toMatch(/import\s*\{\s*OnboardingV2\s*\}\s*from\s*'\.\/components\/OnboardingExperience'/)
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/components\/OnboardingExperience'/)
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
    expect(indexHtml).toMatch(/onboarding-hero-poster\.jpg/)
    expect(ONBOARDING_BOOT_POSTER_HREF).toBe('/onboarding-hero-poster.jpg')
  })
})
