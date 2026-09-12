import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const files = [
  join(__dirname, '../components/OnboardingExperience.tsx'),
  join(__dirname, './onboarding-demo.ts'),
  join(__dirname, './persona-vibe.ts'),
  join(__dirname, './onboarding-tell-the-room.ts'),
  join(__dirname, './onboarding-portal.ts'),
  join(__dirname, './onboarding-appearance.ts'),
  join(__dirname, '../components/OnboardingAppearance.tsx')
]

describe('onboarding user-facing copy — no em dash (U+2014)', () => {
  it('strips U+2014 from OnboardingExperience, onboarding-demo, and helper pins', () => {
    for (const path of files) {
      const body = stripComments(readFileSync(path, 'utf8'))
      expect(body, path).not.toMatch(/\u2014/)
    }
    const helpers = readFileSync(join(__dirname, '../components/Onboarding.helpers.test.ts'), 'utf8')
    expect(helpers).toMatch(/Ready: Cloudflare AI connected/)
    expect(helpers).not.toMatch(/Ready —/)
  })

  it('MQA-304 — directs a licence-only first run to the working Identity activation', () => {
    const source = stripComments(readFileSync(files[0], 'utf8'))
    expect(source).toContain('Settings → Identity')
    expect(source).toContain('automatic summaries and answers')
    expect(source).not.toContain("Métis's built-in Cloudflare, no key needed")
  })
})
