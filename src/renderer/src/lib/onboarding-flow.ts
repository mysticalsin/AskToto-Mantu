/**
 * Exclusive-tour hops. Independently testable so JSX onClick handlers cannot drift.
 * Contract: docs/design/ONBOARDING-FLOW.md (Tony 11:52–11:53pm Totos-Mac).
 *
 *   hero -> problem -> reveal -> appearance -> setup -> personalize -> [license, only if enabled] -> ready
 *
 * Appearance ("Where should Métis live?") sits right after the demo, then Your setup, then
 * personalize. License stays optional and OFF by default. Ready is the only finish.
 * There is no skip scene.
 */

export type OnboardingScene =
  | 'hero'
  | 'problem'
  | 'reveal'
  | 'setup'
  | 'personalize'
  | 'license'
  | 'appearance'
  | 'ready'

/** Ready Get started is the only path that may persist onboardingDone. */
export function canMarkOnboardingDone(input: {
  scene: OnboardingScene | string
  asrReady: boolean
  consent: boolean
}): boolean {
  return input.scene === 'ready' && input.asrReady && input.consent
}

/** Demo Continue: ask where Métis lives before setup. */
export function sceneAfterReveal(): OnboardingScene {
  return 'appearance'
}

/** Appearance Continue lands on Your setup. */
export function sceneAfterAppearance(): OnboardingScene {
  return 'setup'
}

/** setup's Continue always lands on personalize. License (when enabled) sits after personalize. */
export function sceneAfterSetup(): OnboardingScene {
  return 'personalize'
}

/** personalize's Continue: license only when the self-hosted gate is on, otherwise Ready. */
export function sceneAfterPersonalize(licenseGateEnabled: boolean | null | undefined): OnboardingScene {
  return licenseGateEnabled ? 'license' : 'ready'
}

/** license's Continue lands on Ready. */
export function sceneAfterLicense(): OnboardingScene {
  return 'ready'
}
