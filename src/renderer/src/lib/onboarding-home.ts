/**
 * Platform home for the onboarding close — where Métis "lands" after the tour.
 *
 * Mac (Vibe-Island shape): rests in the notch as the auto-hide peek strip — "hides in your island".
 * Windows: same peek/reveal machinery, framed as a top-of-screen command strip (no notch to join).
 *
 * Pure copy + surface selection so ActReady / setup headers stay honest and unit-testable without DOM.
 */

export type OnboardingHomeSurface = 'island' | 'strip'

export function onboardingHomeSurface(isWin: boolean): OnboardingHomeSurface {
  return isWin ? 'strip' : 'island'
}

export interface OnboardingHomeCopy {
  /** Hero tagline under the wordmark. */
  heroTagline: string
  /** Setup scene supporting line. */
  setupHint: string
  /** Ready act eyebrow. */
  readyEyebrow: string
  /** Ready act headline. */
  readyTitle: string
  /** Ready act body (still carries the Listen-only honesty caveat). */
  readyBody: string
  /** Caption under the peek demo. */
  peekCaption: string
  /** Primary Ready CTA. */
  readyCta: string
  /** CTA label while the land/pin animation runs. */
  readyBusy: string
}

export function onboardingHomeCopy(surface: OnboardingHomeSurface): OnboardingHomeCopy {
  if (surface === 'island') {
    return {
      heroTagline: 'Your meeting copilot — hides in the Mac island.',
      setupHint: 'Real checks only. When you’re done, Métis rests in your island until you need it.',
      readyEyebrow: 'Ready to land',
      readyTitle: 'Métis hides in your island.',
      readyBody:
        'It rests in the notch like a second Dynamic Island — hover to open, never steals focus. Listening starts only when you press Listen and tell the room.',
      peekCaption: 'Your island · hover to open',
      readyCta: 'Hide in my island',
      readyBusy: 'Landing…'
    }
  }
  return {
    heroTagline: 'Your meeting copilot — pinned to the top of your screen.',
    setupHint: 'Real checks only. When you’re done, Métis pins as a slim command strip at the top.',
    readyEyebrow: 'Ready to pin',
    readyTitle: 'Métis lives at the top of your screen.',
    readyBody:
      'It collapses to a slim strip when idle, expands on hover, and never steals focus from your call. Listening starts only when you press Listen and tell the room.',
    peekCaption: 'Top strip · hover to open',
    readyCta: 'Pin to the top',
    readyBusy: 'Pinning…'
  }
}

/** Windows-only showcase beats under the setup capability rail — denser product pitch than Mac (no island story). */
export const WINDOWS_SETUP_MOMENTS: ReadonlyArray<{ title: string; blurb: string }> = [
  { title: 'Hear both sides', blurb: 'Mic + system audio, so the question never slips by.' },
  { title: 'Answer in your voice', blurb: 'What to say next, grounded in this meeting.' },
  { title: 'Stay on this PC', blurb: 'Transcription and brain stay local — nothing uploaded.' }
]

/** Delay before finishing onboarding after the land/pin animation starts (ms). */
export const READY_LAND_MS = 720
