/**
 * Act 6 (Ready) — the tail re-point (MQA-283). Pure scene-transition rules for the guided narrative's
 * LAST three hops, pulled out of OnboardingExperience.tsx so the "where does Continue/Start actually
 * land" claim is independently testable instead of only visible by reading JSX onClick handlers.
 *
 * The six acts now run in the VibeIsland-teardown's own canonical order — welcome -> demo -> config ->
 * vibe -> license -> ready — rather than the config -> license -> vibe order Act 5 (MQA-281/282)
 * originally shipped with:
 *
 *   hero -> problem -> reveal -> setup -> personalize -> [license, only if enabled] -> appearance -> ready -> finish
 *
 * `license` stays optional and OFF by default (settings.licenseGateEnabled) exactly as Act 5 shipped it;
 * moving it after `personalize` only changes WHEN it can appear, never whether it does. `ready` is the
 * new terminal act: the narrative finishes onboarding itself there (marks `onboardingDone`) instead of
 * handing off to the legacy provider/API-key step the way it used to — the embedded-Cloudflare-default
 * install (`src/main/embedded-cloudflare-key.ts`, MQA-273) already makes a fresh install `providerReady`
 * with zero user action, so forcing that step on every install was asking for configuration nobody
 * needed. Adding a personal provider key stays reachable, just as an OPTIONAL link from Ready (see
 * `ActReady` in OnboardingExperience.tsx), never a gate.
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
  | 'skip'

/** setup's Continue always lands on personalize now — license (when enabled) has moved to sit AFTER
 *  personalize instead of between setup and personalize. */
export function sceneAfterSetup(): OnboardingScene {
  return 'personalize'
}

/** personalize's Continue: the license act only when the self-hosted license gate is on, otherwise
 *  the appearance ask. Never the legacy provider/API-key step — that hop no longer exists in the
 *  narrative path (see module doc above). Ready stays after appearance. */
export function sceneAfterPersonalize(licenseGateEnabled: boolean | null | undefined): OnboardingScene {
  return licenseGateEnabled ? 'license' : 'appearance'
}

/** license's Continue lands on the appearance ask (then Ready). */
export function sceneAfterLicense(): OnboardingScene {
  return 'appearance'
}

/** Appearance Continue always lands on Ready. Tail beat, not a seventh guided act. */
export function sceneAfterAppearance(): OnboardingScene {
  return 'ready'
}
