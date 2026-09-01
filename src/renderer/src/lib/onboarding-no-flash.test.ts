import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/ipc'
import { vaultRowStatus } from '../components/OnboardingExperience'

const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
const demo = readFileSync(join(__dirname, '../components/OnboardingDemoScene.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

function eachPrimaryCta(src: string): string[] {
  const out: string[] = []
  const re = /className=\{?['"`][^'"`]*onboard-cta[^'"`]*['"`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[0])
  return out
}

describe('Onboarding no-flash (DESIGN.md)', () => {
  it('primary CTAs never use fade-up (tests must not require it)', () => {
    for (const cls of [...eachPrimaryCta(experience), ...eachPrimaryCta(demo)]) {
      expect(cls).not.toMatch(/fade-up/)
    }
    expect(experience).toMatch(/className="onboard-cta no-drag focus-ring"/)
    expect(experience).not.toMatch(/onboard-cta[^>]{0,80}fade-up/)
    expect(demo).not.toMatch(/onboard-cta[^>]{0,80}fade-up/)
  })

  it('tour copy does not hide behind fade-up or opacity-0 scene-enter', () => {
    const problem = experience.slice(experience.indexOf("scene === 'problem'"), experience.indexOf("scene === 'reveal'"))
    expect(problem).not.toMatch(/fade-up/)
    expect(problem).not.toMatch(/animationFillMode/)
    expect(problem).not.toMatch(/1100ms/)
    expect(css).toMatch(/\.onboard-stage \.fade-up \{\s*animation:\s*none/)
    expect(css).toMatch(/\.onboard-stage \.scene-enter \{\s*animation:\s*none/)
    expect(css).toMatch(/\.onboard-tour-slot \{/)
    expect(css).toMatch(/min-height:\s*28rem/)
    expect(experience).toMatch(/onboard-tour-slot/)
  })

  it('starfield stays mounted after hero (no remount flash); reveal only pauses', () => {
    expect(experience).toMatch(/scene !== 'hero' && !starfieldFailed/)
    expect(experience).toMatch(/active=\{shouldMountStarfield\(scene\)\}/)
  })

  it('maps the second-brain vault with honest offline + create offer', () => {
    expect(experience).toMatch(/secondBrainDetect/)
    expect(experience).toMatch(/secondBrainCreate/)
    expect(experience).toMatch(/Using your AI Second Brain vault/)
    expect(experience).toMatch(/OneDrive is not available/)
    expect(experience).toMatch(/Create vault/)
    expect(experience).not.toMatch(/Métis Second Brain/)
    expect(vaultRowStatus({ status: 'found', path: '/v', suggestedPath: '/v' })).toEqual({
      state: 'ready',
      detail: 'Using your AI Second Brain vault.'
    })
    expect(vaultRowStatus({ status: 'offline', suggestedPath: '/v', reason: 'OneDrive is not available' }).detail).toMatch(
      /OneDrive is not available/
    )
    expect(vaultRowStatus({ status: 'not-found', suggestedPath: '/v' }).state).toBe('action')
    expect(vaultRowStatus(null).state).toBe('checking')
  })

  it('Dust write-in defaults true', () => {
    expect(DEFAULT_SETTINGS.dustWriteToVault).toBe(true)
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS }).dustWriteToVault).toBe(true)
  })
})
