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
})
