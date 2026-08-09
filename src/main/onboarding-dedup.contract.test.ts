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

/** Occurrences of the phrase as a rendered BUTTON label, i.e. immediately followed by the arrow icon
 *  the button renders. The phrase also legitimately appears in explanatory copy ("…continue without
 *  signing in below.") and in comments; counting every occurrence made this test fail the moment the
 *  not-configured sign-in message was reworded to point AT the button, which is not the regression it
 *  exists to catch. What must stay unique is the control itself. */
const BUTTON_LABEL = /Continue without signing in <ArrowRight/g

describe('legacy onboarding renders exactly one "Continue without signing in" button', () => {
  it('has a single occurrence of the button label', () => {
    expect(onboardingSrc.match(BUTTON_LABEL) ?? []).toHaveLength(1)
  })

  it('the surviving button is the !signedIn-gated, consent-aware one', () => {
    const idx = onboardingSrc.search(BUTTON_LABEL)
    expect(idx).toBeGreaterThan(-1)
    const before = onboardingSrc.slice(Math.max(0, idx - 600), idx)
    expect(before).toMatch(/\{!signedIn && \(/)
    expect(before).toMatch(/disabled=\{busy \|\| !recordingConsent\}/)
  })
})
