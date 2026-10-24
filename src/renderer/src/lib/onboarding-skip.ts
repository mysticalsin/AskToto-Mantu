import { canSkipOnboarding, type OnboardingScene } from './onboarding-flow'

export type OnboardingSkipOutcome = 'skipped' | 'refused' | 'busy' | 'failed'

export interface OnboardingSkipDeps {
  scene: OnboardingScene
  consent: boolean
  /** Aborts an in-flight setup mic request so no permission prompt outlives the tour. */
  abortMic(): void
  /** Clears interview answers and drafts. Main keeps a completed interview and never archives assistants. */
  discardInterview(): Promise<unknown>
  /** The same audio teardown Ready's finish runs (lock, halt, stop music, dispose portal audio). */
  silenceAudio(): void
  /** The durable save of onboardingDone and consent, then the window exit only after the awaited save. */
  complete(): Promise<void>
}

/**
 * Skip setup (D-27, G56): one ordered cleanup so a skip never leaves half-set-up state behind. ASR and local
 * model downloads are deliberately not cancelled (atomic, resumable, needed by the app), and the appearance
 * choice stays because it is already a completed choice. A failed save leaves the stage open for a retry.
 */
export function createOnboardingSkip(): { run(deps: OnboardingSkipDeps): Promise<OnboardingSkipOutcome> } {
  let inFlight = false
  return {
    async run(deps) {
      if (!canSkipOnboarding({ scene: deps.scene, consent: deps.consent })) return 'refused'
      if (inFlight) return 'busy'
      inFlight = true
      try {
        deps.abortMic()
        try {
          await deps.discardInterview()
        } catch {
          // Signed out or unavailable: there is no interview state this owner can reach, so nothing to clear.
        }
        deps.silenceAudio()
        await deps.complete()
        return 'skipped'
      } catch {
        return 'failed'
      } finally {
        inFlight = false
      }
    }
  }
}
