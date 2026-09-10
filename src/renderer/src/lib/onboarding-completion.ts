import type { PublicSettings } from '@shared/ipc'

export const ONBOARDING_COMPLETION_ERROR =
  "Métis couldn't save your setup. Try again. If it keeps happening, contact support."

export interface OnboardingCompletionState {
  busy: boolean
  error: string | null
}

export type OnboardingCompletionOutcome = 'completed' | 'failed' | 'blocked' | 'ignored'

export interface OnboardingCompletionFlow {
  attempt(
    finish: () => Promise<boolean>,
    afterSuccess?: () => void
  ): Promise<OnboardingCompletionOutcome>
}

/** One Ready-screen lifetime: suppress concurrent/repeated completion and sanitize persistence errors. */
export function createOnboardingCompletionFlow(
  onState: (state: OnboardingCompletionState) => void
): OnboardingCompletionFlow {
  let busy = false
  let completed = false
  let error: string | null = null

  const publish = (): void => onState({ busy, error })

  return {
    async attempt(
      finish: () => Promise<boolean>,
      afterSuccess?: () => void
    ): Promise<OnboardingCompletionOutcome> {
      if (busy || completed) return 'ignored'

      busy = true
      error = null
      publish()

      let outcome: OnboardingCompletionOutcome
      try {
        if (await finish()) {
          completed = true
          outcome = 'completed'
        } else {
          outcome = 'blocked'
        }
      } catch {
        error = ONBOARDING_COMPLETION_ERROR
        outcome = 'failed'
      }

      busy = false
      publish()
      if (outcome === 'completed') afterSuccess?.()
      return outcome
    }
  }
}

/** Keep the durable write ahead of the host callback that exits onboarding or opens another surface. */
export async function persistOnboardingCompletion(input: {
  settingsPatch: Pick<
    PublicSettings,
    'mode' | 'recordingConsent' | 'onboardingDone' | 'onboardingDoneAt'
  >
  patch: (patch: Partial<PublicSettings>) => void | Promise<void>
  onCompleted: () => void
}): Promise<void> {
  await input.patch(input.settingsPatch)
  input.onCompleted()
}
