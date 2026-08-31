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
  join(__dirname, './onboarding-portal.ts')
]

describe('onboarding locked copy — punchy second-brain lines', () => {
  it('pins the hero tagline and three problem lines; old four lines are gone', () => {
    const experience = readFileSync(join(__dirname, '../components/OnboardingExperience.tsx'), 'utf8')
    expect(experience).toMatch(/Your second brain in the corner\./)
    expect(experience).toMatch(/Never lose the room\./)
    expect(experience).toMatch(/Métis remembers every word of the meeting\./)
    expect(experience).toMatch(/When the question lands, you already have the answer\./)
    expect(experience).not.toMatch(/Your on-device meeting copilot\./)
    expect(experience).not.toMatch(/You're in the meeting\./)
    expect(experience).not.toMatch(/You know that you know it\./)
    expect(experience).not.toMatch(/and the moment passes/)
  })
})

describe('onboarding user-facing copy — no em dash (U+2014)', () => {
  it('strips U+2014 from OnboardingExperience, onboarding-demo, and helper pins', () => {
    for (const path of files) {
      const body = stripComments(readFileSync(path, 'utf8'))
      expect(body, path).not.toMatch(/\u2014/)
    }
    const helpers = readFileSync(join(__dirname, '../components/Onboarding.helpers.test.ts'), 'utf8')
    expect(helpers).toMatch(/Ready: Métis's built-in Cloudflare/)
    expect(helpers).not.toMatch(/Ready —/)
  })
})
