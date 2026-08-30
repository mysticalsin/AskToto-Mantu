import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * MQA-283 — Act 6 (Ready) + the tail re-point. OnboardingExperience.tsx and Onboarding.tsx have no
 * render harness (see the other *.helpers.test.ts / *.contract.test.ts files in this directory), so
 * these are structural contract tests: they pin the SHAPE of the re-point rather than exercising it
 * through a DOM. `onboarding-flow.test.ts` covers the pure scene-transition rules these strings wire up.
 */
const experienceSrc = readFileSync(join(__dirname, 'OnboardingExperience.tsx'), 'utf8')
const settingsSrc = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8')

describe('MQA-283 — the narrative experience now ends at Ready, not a legacy provider handoff', () => {
  it('OnboardingV2 no longer has a "provider" phase — only experience and legacy-full', () => {
    expect(experienceSrc).toMatch(/useState<'experience' \| 'legacy-full'>\('experience'\)/)
    expect(experienceSrc).not.toMatch(/'experience' \| 'provider' \| 'legacy-full'/)
    expect(experienceSrc).not.toMatch(/setPhase\('provider'\)/)
  })

  it('OnboardingV2 marks onboardingDone itself inside the experience\'s onDone, not via a provider phase', () => {
    expect(experienceSrc).toMatch(/onboardingDone: true, onboardingDoneAt: Date\.now\(\)/)
  })

  it('the legacy Onboarding is only entered at step 1 now (the Skip path) — never step 5', () => {
    expect(experienceSrc).toMatch(/initialStep=\{1\}/)
    expect(experienceSrc).not.toMatch(/initialStep=\{phase === 'legacy-full' \? 1 : 5\}/)
  })

  it('setup always advances to personalize — license no longer sits between setup and personalize', () => {
    expect(experienceSrc).toMatch(/setScene\(sceneAfterSetup\(\)\)/)
    expect(experienceSrc).not.toMatch(/setScene\(settings\?\.licenseGateEnabled \? 'license' : 'personalize'\)/)
  })

  it('personalize routes to license (if enabled) or straight to ready — never finishes there directly', () => {
    expect(experienceSrc).toMatch(/setScene\(sceneAfterPersonalize\(settings\?\.licenseGateEnabled\)\)/)
  })

  it('license continues into ready, never back into personalize', () => {
    expect(experienceSrc).toMatch(/setScene\(sceneAfterLicense\(\)\)/)
    expect(experienceSrc).not.toMatch(/ActLicense settings=\{settings\} onContinue=\{\(\) => setScene\('personalize'\)\}/)
  })

  it('a ready scene renders ActReady, wired to the real finish() and the optional AI-settings link', () => {
    expect(experienceSrc).toMatch(/scene === 'ready'/)
    expect(experienceSrc).toMatch(/<ActReady mode=\{mode\} onFinish=\{finish\} onOpenAiSettings=\{onOpenAiSettings\} \/>/)
  })
})

describe('MQA-283 — Ready\'s honest empty-state line (Métis\'s equivalent of "restart your sessions")', () => {
  it('states plainly that nothing is captured until Listen is pressed and the room is told', () => {
    expect(experienceSrc).toMatch(
      /Métis is ready\. It starts listening only when you press Listen and tell the room — nothing is[\s\S]{0,20}captured before that\./
    )
  })

  it('never claims readiness with no caveat — the honest line always ships alongside the CTA', () => {
    const readyBlockStart = experienceSrc.indexOf("key=\"ready\"")
    expect(readyBlockStart).toBeGreaterThan(-1)
    const readyBlock = experienceSrc.slice(readyBlockStart, readyBlockStart + 2000)
    expect(readyBlock).toMatch(/Métis is ready\./)
    expect(readyBlock).toMatch(/Get started/)
  })
})

describe('MQA-283 — adding a personal AI provider from Ready is optional, never a gate', () => {
  it('the provider link only renders when onOpenAiSettings was actually passed in', () => {
    expect(experienceSrc).toMatch(/\{onOpenAiSettings && \(/)
    expect(experienceSrc).toMatch(/Add your own AI provider — optional, never required/)
  })

  it('the Get started CTA never depends on onOpenAiSettings, or on any provider state at all', () => {
    const ctaMatch = experienceSrc.match(/onClick=\{\(\) => void onFinish\(\)\}\s*\n\s*disabled=\{busy\}/)
    expect(ctaMatch).not.toBeNull()
  })
})

describe('MQA-283 — Replay onboarding in Settings re-arms the same gate a first run uses', () => {
  it('the button patches onboardingDone back to false — no separate replay state to keep in sync', () => {
    expect(settingsSrc).toMatch(/Replay onboarding/)
    expect(settingsSrc).toMatch(/patch\(\{ onboardingDone: false \}\)/)
  })

  it('does not reset any other setting — replay must not silently wipe unrelated config', () => {
    const idx = settingsSrc.indexOf('Replay onboarding from the start?')
    expect(idx).toBeGreaterThan(-1)
    const block = settingsSrc.slice(idx - 200, idx + 200)
    expect(block).toMatch(/patch\(\{ onboardingDone: false \}\)/)
    expect(block).not.toMatch(/onboardingDoneAt/)
  })
})
