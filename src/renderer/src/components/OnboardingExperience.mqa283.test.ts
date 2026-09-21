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
  it('OnboardingV2 no longer has a provider or legacy-full phase', () => {
    expect(experienceSrc).not.toMatch(/legacy-full/)
    expect(experienceSrc).not.toMatch(/setPhase\('provider'\)/)
    expect(experienceSrc).not.toMatch(/<Onboarding[\s>]/)
    expect(experienceSrc).toMatch(/<OnboardingExperience/)
  })

  it('OnboardingV2 marks onboardingDone itself inside the experience\'s onDone, not via a provider phase', () => {
    expect(experienceSrc).toMatch(/await persistOnboardingCompletion\(\{/)
    expect(experienceSrc).toMatch(/mode, recordingConsent, onboardingDone: true, onboardingDoneAt: Date\.now\(\)/)
    expect(experienceSrc).toMatch(/onCompleted: onDone/)
  })

  it('there is no Skip path and the live tree does not mount legacy Onboarding.tsx', () => {
    expect(experienceSrc).not.toMatch(/setScene\('skip'\)/)
    expect(experienceSrc).not.toMatch(/from '\.\/Onboarding'/)
    expect(experienceSrc).not.toMatch(/initialStep=\{phase === 'legacy-full' \? 1 : 5\}/)
  })

  it('reveal advances to appearance, then setup, then personalize', () => {
    expect(experienceSrc).toMatch(/setScene\(sceneAfterReveal\(\)\)/)
    expect(experienceSrc).not.toMatch(/onContinue=\{\(\) => \{\s*playHero\(\)\s*\n\s*setScene\('setup'\)/)
    expect(experienceSrc).toMatch(/setScene\(sceneAfterAppearance\(\)\)/)
    expect(experienceSrc).toMatch(/setScene\(sceneAfterSetup\(\)\)/)
    expect(experienceSrc).not.toMatch(/setScene\(settings\?\.licenseGateEnabled \? 'license' : 'personalize'\)/)
  })

  it('eager DemoScene so Act 2 never Suspense-hangs; fallback Continue still present', () => {
    // Tony HARD 2026-09-21: lazy DemoScene caused black hang after problem Continue; skip-to-appearance was the bad workaround.
    expect(experienceSrc).toMatch(/import \{ OnboardingDemoScene \} from '\.\/OnboardingDemoScene'/)
    expect(experienceSrc).not.toMatch(/const OnboardingDemoScene = lazy\(/)
    expect(experienceSrc).toMatch(/setScene\('reveal'\)/)
    const reveal = experienceSrc.slice(experienceSrc.indexOf("{scene === 'reveal'"), experienceSrc.indexOf("{scene === 'setup'"))
    expect(reveal).toMatch(/<Suspense/)
    expect(reveal).toMatch(/Continue/)
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
    expect(experienceSrc).toMatch(/<ActReady/)
    expect(experienceSrc).toMatch(/onFinish=\{finish\}/)
    expect(experienceSrc).toMatch(/onOpenAiSettings=\{onOpenAiSettings\}/)
    expect(experienceSrc).toMatch(/asrReady=\{asrReady\}/)
    expect(experienceSrc).toMatch(/aiReady=\{settings\?\.providerReady === true\}/)
  })

  it('routes both Ready actions through one retry-safe completion path', () => {
    expect(experienceSrc).toMatch(/createOnboardingCompletionFlow/)
    expect(experienceSrc).toMatch(/onClick=\{\(\) => attemptFinish\('answer'\)\}/)
    expect(experienceSrc).toMatch(/onClick=\{\(\) => attemptFinish\('settings'\)\}/)
    expect(experienceSrc).not.toMatch(/onClick=\{\(\) => void onFinish\(\)\}/)
    expect(experienceSrc).toMatch(/role="alert"/)
  })

  it('sends the post-save onboarding exit only after the durable settings invoke has resolved', () => {
    const v2 = experienceSrc.slice(experienceSrc.indexOf('export function OnboardingV2'))
    const save = v2.indexOf('await persistOnboardingCompletion({')
    const exit = v2.indexOf('window.toto.onboardingExit(destination)')
    expect(save).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(save)
  })

  it('keeps encrypted-profile recovery in the active Ready flow and retries only after it succeeds', () => {
    const v2 = experienceSrc.slice(experienceSrc.indexOf('export function OnboardingV2'))
    const ready = experienceSrc.slice(experienceSrc.indexOf('function ActReady'), experienceSrc.indexOf('function prefersReducedMotion'))
    expect(v2).toMatch(/recoverEncryptedProfile,\s*patch/)
    expect(v2).toMatch(/recoverEncryptedProfile=\{recoverEncryptedProfile\}/)
    expect(experienceSrc).toMatch(/interface OnboardingExperienceProps[\s\S]*?recoverEncryptedProfile\?:/)
    expect(experienceSrc).toMatch(/recoverEncryptedProfile=\{recoverEncryptedProfile\}/)
    expect(ready).toMatch(/await recoverEncryptedProfile\(\)/)
    expect(ready).toMatch(/if \(!result\.ok\)/)
    expect(ready.indexOf('await recoverEncryptedProfile()')).toBeLessThan(ready.indexOf("await attemptFinish('answer')"))
    expect(ready).not.toMatch(/patch\(/)
  })

  it('reopens the Ready stage when the awaited save rejects', () => {
    expect(experienceSrc).toMatch(
      /catch \(error\) \{\s*doneRef\.current = false\s*document\.querySelector\('\.onboard-stage'\)\?\.classList\.remove\('onboard-stage--portal-close'\)[\s\S]*?requestOnboardingPortalOpen\(\)/
    )
  })

  it('offers a restart recovery when a durable final save remains pending, without enabling a duplicate submit', () => {
    expect(experienceSrc).toMatch(/ONBOARDING_COMPLETION_STALL_MS/)
    expect(experienceSrc).toMatch(/const \[completionStalled, setCompletionStalled\] = useState\(false\)/)
    expect(experienceSrc).toMatch(/setTimeout\(\(\) => setCompletionStalled\(true\), ONBOARDING_COMPLETION_STALL_MS\)/)
    expect(experienceSrc).toMatch(/Don’t submit it again\. Restart Métis to check the saved result\./)
    expect(experienceSrc).toMatch(/window\.toto\.relaunch\(\)/)
    expect(experienceSrc).toMatch(/disabled=\{blocked\}/)
  })
})

describe('MQA-283 — Ready\'s honest empty-state line (Métis\'s equivalent of "restart your sessions")', () => {
  it('states plainly that nothing is captured until Listen is pressed and the room is told', () => {
    expect(experienceSrc).toMatch(/TELL_THE_ROOM_READY/)
    expect(experienceSrc).toMatch(/TELL_THE_ROOM_QUOTE/)
  })

  it('never claims readiness with no caveat — the honest line always ships alongside the CTA', () => {
    const readyBlockStart = experienceSrc.indexOf("key=\"ready\"")
    expect(readyBlockStart).toBeGreaterThan(-1)
    const readyBlock = experienceSrc.slice(readyBlockStart, readyBlockStart + 4000)
    expect(readyBlock).toMatch(/TELL_THE_ROOM_READY/)
    expect(readyBlock).toMatch(/TELL_THE_ROOM_QUOTE/)
    expect(readyBlock).toMatch(/Get started/)
  })
})

describe('MQA-283 — adding a personal AI provider from Ready is optional, never a gate', () => {
  it('the provider link only renders when onOpenAiSettings was actually passed in', () => {
    expect(experienceSrc).toMatch(/\{onOpenAiSettings && \(/)
    expect(experienceSrc).toMatch(/onboardingReadinessCopy\(asrReady, aiReady\)/)
    expect(experienceSrc).toMatch(/\{readinessCopy\.aiAction\}/)
    expect(experienceSrc).not.toMatch(/You'll add a provider key on the next step/)
  })

  it('the Get started CTA never depends on onOpenAiSettings, or on any provider state at all', () => {
    const ctaMatch = experienceSrc.match(/onClick=\{\(\) => attemptFinish\('answer'\)\}\s*\n\s*disabled=\{blocked\}/)
    expect(ctaMatch).not.toBeNull()
    expect(experienceSrc).toMatch(/const blocked = completion\.busy \|\| recoveryBusy \|\| !authReady/)
    expect(experienceSrc).toMatch(/if \(!authReady\) return 'blocked'/)
    expect(experienceSrc).not.toMatch(/const blocked = [^\n]*!asrReady/)
  })
})

describe('MQA-283 — Replay onboarding in Settings re-arms the same gate a first run uses', () => {
  it('the button patches onboardingDone back to false — no separate replay state to keep in sync', () => {
    expect(settingsSrc).toMatch(/Replay onboarding/)
    expect(settingsSrc).toMatch(/patch\(\{ onboardingDone: false \}\)/)
  })

  it('only enters onboarding after a confirmed save, and keeps a replay failure actionable', () => {
    const start = settingsSrc.indexOf('const replayOnboarding = async')
    const end = settingsSrc.indexOf('// App reuses the same Settings instance', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = settingsSrc.slice(start, end)
    expect(block).toMatch(/const saved = await patch\(\{ onboardingDone: false \}\)/)
    expect(block).toMatch(/saved\.onboardingDone !== false/)
    expect(block.indexOf('const saved = await patch({ onboardingDone: false })')).toBeLessThan(block.indexOf('haltAllOnboardingAudio()'))
    expect(block.indexOf('haltAllOnboardingAudio()')).toBeLessThan(block.indexOf('window.toto.onboardingEnter()'))
    expect(block).toMatch(/Métis couldn't start setup again\. Try again\./)
    expect(block).not.toMatch(/onboardingDoneAt/)
    expect(settingsSrc).toMatch(/role="alert"/)
  })
})
