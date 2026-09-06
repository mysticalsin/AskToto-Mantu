/**
 * Renderer-side half of the Act 2 safety rule (MQA-278) — see @shared/demo-guard for the persistence-
 * boundary half (the reserved-tag gate `saveMeeting`/`saveNote`/`enqueueIngest` call).
 *
 * Answer.tsx's "Save note" and thumbs-rating buttons call `window.toto.saveNote` / `window.toto.
 * answerFeedback` directly — they have no prop to override that, and Act 2's onboarding demo mounts
 * the REAL `<Answer>` component (for its fact-check beat) with real click handlers still wired. Content
 * tagging can't help here: Answer doesn't tag anything, it just persists whatever `label`/`prompt`/
 * `text` it's handed. So this is a single, module-scoped "is a scripted demo on screen right now?" flag,
 * flipped by the demo scene's own mount/unmount effect (OnboardingExperience.tsx) — while it's true, the
 * save-shaped affordances on any REAL component mounted for the demo refuse to fire at all, regardless
 * of whether the content itself happens to be tagged. This is deliberately broader than the tag check:
 * it also covers "refuse real data while the demo is on screen" (e.g. a stray autosave callback from a
 * meeting the user somehow still had open) — the demo screen must never be a save opportunity, period.
 *
 * Defaults to false and is only ever flipped by the onboarding demo scene, so this has zero effect on
 * normal (non-onboarding) use of the app.
 */
let onboardingDemoActive = false

export function setOnboardingDemoActive(active: boolean): void {
  onboardingDemoActive = active
}

export function isOnboardingDemoActive(): boolean {
  return onboardingDemoActive
}
