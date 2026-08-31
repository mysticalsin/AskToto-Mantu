import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SURFACES = [
  'Answer.tsx',
  'Copilot.tsx',
  'Review.tsx',
  'BrainView.tsx',
  'BrainRecordPage.tsx',
  'Bar.tsx',
  'ControlBar.tsx',
  'AgendaView.tsx',
  'SignInWall.tsx',
  'LicenseGate.tsx',
  'Settings.tsx',
  'RecallView.tsx',
  'ReviewEntityStrip.tsx',
  'Onboarding.tsx',
  'OnboardingExperience.tsx',
  'OnboardingDemoScene.tsx',
  'ui.tsx'
]

const FORBIDDEN = [
  /from 'lucide-react'[\s\S]*Loader2/,
  /<Loader2\b/,
  /className="[^"]*animate-spin/,
  /loading-spinner/,
  /<svg[^>]*loading-spinner/,
  /Still working…/,
  /Starting Métis…/
]

describe('replaced wait surfaces have no leftover CSS/SVG spinners', () => {
  for (const file of SURFACES) {
    it(`${file} does not keep the old spinner language`, () => {
      const src = readFileSync(resolve(__dirname, file), 'utf8')
      for (const pattern of FORBIDDEN) {
        expect(src, `${file} matches ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('named waits use thinking / working / planning orbs, not Loader2', () => {
    const answer = readFileSync(resolve(__dirname, 'Answer.tsx'), 'utf8')
    const copilot = readFileSync(resolve(__dirname, 'Copilot.tsx'), 'utf8')
    const spec = readFileSync(resolve(__dirname, '../lib/agent-status.ts'), 'utf8')
    expect(answer).toMatch(/kind="thinking"/)
    expect(answer).toMatch(/kind="working"/)
    expect(copilot).toMatch(/kind="thinking"/)
    expect(spec).toMatch(/planning: \{ caption: 'Planning', state: 'shaping' \}/)
    expect(spec).toMatch(/thinking: \{ caption: 'Thinking', state: 'solving' \}/)
    expect(spec).toMatch(/working: \{ caption: 'Thinking', state: 'working' \}/)
  })
})
