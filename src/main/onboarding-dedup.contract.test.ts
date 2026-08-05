import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression lock for the doubled "Continue without signing in" button (reported 2026-08-04):
// commit 6b75daf added a !signedIn-gated copy of the skip button to legacy Onboarding.tsx's step-1
// welcome but left the original unconditional copy in place, so every first-run (necessarily
// not-signed-in) user saw the button twice. Exactly one occurrence must exist, and it must be the
// gated one (it also carries the consent-aware disabled state).
const onboardingSrc = readFileSync(
  join(__dirname, '..', 'renderer', 'src', 'components', 'Onboarding.tsx'),
  'utf8'
)

describe('legacy onboarding renders exactly one "Continue without signing in" button', () => {
  it('has a single occurrence of the button label', () => {
    const count = onboardingSrc.split('Continue without signing in').length - 1
    expect(count).toBe(1)
  })

  it('the surviving button is the !signedIn-gated, consent-aware one', () => {
    const idx = onboardingSrc.indexOf('Continue without signing in')
    const before = onboardingSrc.slice(Math.max(0, idx - 600), idx)
    expect(before).toMatch(/\{!signedIn && \(/)
    expect(before).toMatch(/disabled=\{busy \|\| !recordingConsent\}/)
  })
})
