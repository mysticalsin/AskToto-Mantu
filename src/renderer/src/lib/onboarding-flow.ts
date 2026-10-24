/**
 * Exclusive-tour hops. Independently testable so JSX onClick handlers cannot drift.
 * Contract: docs/design/ONBOARDING-FLOW.md (Tony 11:52–11:53pm Totos-Mac).
 *
 *   hero -> problem -> reveal -> appearance -> setup -> personalize -> [interview, signed in]
 *     -> [license, only if enabled] -> ready
 *
 * Appearance ("Where should Métis live?") sits right after the demo, then Your setup, then
 * personalize. License stays optional and OFF by default. Ready is the only finish.
 * There is no skip scene. Skip setup (D-27, G56) is a control, not a scene: it is offered only after
 * the permissions step and only with consent, and it runs the same cleanup and durable save as Ready.
 */

export type OnboardingScene =
  | 'hero'
  | 'problem'
  | 'reveal'
  | 'setup'
  | 'personalize'
  | 'interview'
  | 'license'
  | 'appearance'
  | 'ready'

/** Ready Get started is the only path that may persist onboardingDone. */
export function canMarkOnboardingDone(input: {
  scene: OnboardingScene | string
  asrReady: boolean
  consent: boolean
}): boolean {
  // P0 nuclear: ASR readiness is informational — never block finishing onboarding.
  return input.scene === 'ready' && input.consent
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

/** personalize's Continue: the role interview when it is available (signed in, partition open), then
 *  license only when the self-hosted gate is on, otherwise Ready. */
export function sceneAfterPersonalize(
  licenseGateEnabled: boolean | null | undefined,
  interviewAvailable = false
): OnboardingScene {
  if (interviewAvailable) return 'interview'
  return licenseGateEnabled ? 'license' : 'ready'
}

/** The interview's Continue (or Not now): license when the gate is on, otherwise Ready. */
export function sceneAfterInterview(licenseGateEnabled: boolean | null | undefined): OnboardingScene {
  return licenseGateEnabled ? 'license' : 'ready'
}

/** Scenes that may show Skip setup: everything after the permissions step, before Ready. */
export const SKIPPABLE_SCENES: readonly OnboardingScene[] = ['personalize', 'interview', 'license']

/** Skip needs consent too: recordingConsent has no runtime gate, so skip must never persist without it. */
export function canSkipOnboarding(input: { scene: OnboardingScene | string; consent: boolean }): boolean {
  return input.consent && (SKIPPABLE_SCENES as readonly string[]).includes(input.scene)
}

/** license's Continue lands on Ready. */
export function sceneAfterLicense(): OnboardingScene {
  return 'ready'
}
