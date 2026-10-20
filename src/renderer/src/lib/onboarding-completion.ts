import type { DustCliImport, ProfileRecoveryResult, PublicSettings, SignInResult } from '@shared/ipc'
import { isEncryptedProfileRecoveryMessage } from '@shared/encrypted-profile-recovery'

export const ONBOARDING_COMPLETION_ERROR =
  "Métis couldn't save your setup. Try again. If it keeps happening, contact support."

/** A resolved IPC can still mean main deliberately refused the mutation (for example, signed-out SSO). */
export const ONBOARDING_COMPLETION_NOT_SAVED_ERROR =
  "Métis couldn't confirm that your setup was saved. Sign in if required, then try again."

/** UI recovery only: never cancel or retry an in-flight write, which could duplicate a durable mutation. */
export const ONBOARDING_COMPLETION_STALL_MS = 12_000

/** Only the explicit fail-closed profile-key error can offer an archive-and-retry action. */
export function isEncryptedProfileRecoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return isEncryptedProfileRecoveryMessage(message)
}

/**
 * Keep archive failures truthful without exposing a user-data path or other native error details.
 * A failure after the archive has begun can leave preserved encrypted files in its recovery folder,
 * so only an explicit user cancellation may promise that nothing changed.
 */
export function encryptedProfileRecoveryFailureMessage(
  result: Pick<ProfileRecoveryResult, 'canceled' | 'error'>
): string {
  if (result.canceled) return 'Recovery canceled. Your encrypted profile was not changed.'
  if (result.error) {
    return 'Métis could not complete the profile archive. No data was deleted, but some encrypted files may be in the local recovery folder. You can try again or contact support.'
  }
  return 'Could not create a new local profile. Please try again or contact support.'
}

/** IPC rejection leaves the native archive outcome unknown, so do not make a data-state promise. */
export const ENCRYPTED_PROFILE_RECOVERY_UNCONFIRMED_MESSAGE =
  'Métis could not confirm the profile recovery. Restart Métis and contact support before trying again.'

export interface OnboardingCompletionState {
  busy: boolean
  error: string | null
}

export type OnboardingCompletionOutcome = 'completed' | 'failed' | 'blocked' | 'ignored'

export interface OnboardingCompletionFlow {
  attempt(finish: () => Promise<boolean>, afterSuccess?: () => void): Promise<OnboardingCompletionOutcome>
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
    async attempt(finish: () => Promise<boolean>, afterSuccess?: () => void): Promise<OnboardingCompletionOutcome> {
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
      } catch (caught) {
        // This exact message is produced locally only after main returned a public settings snapshot
        // that proves the write did not land (for example, an unsigned required-SSO seat). Keep its
        // concrete recovery route; every other native/IPC error remains sanitized.
        error =
          caught instanceof Error && caught.message === ONBOARDING_COMPLETION_NOT_SAVED_ERROR
            ? ONBOARDING_COMPLETION_NOT_SAVED_ERROR
            : ONBOARDING_COMPLETION_ERROR
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
  settingsPatch: Pick<PublicSettings, 'mode' | 'recordingConsent' | 'onboardingDone' | 'onboardingDoneAt'>
  patch: (patch: Partial<PublicSettings>) => Promise<PublicSettings>
  onCompleted: () => void
}): Promise<void> {
  const saved = await input.patch(input.settingsPatch)
  if (saved && saved.onboardingDone !== true) throw new Error(ONBOARDING_COMPLETION_NOT_SAVED_ERROR)
  input.onCompleted()
}

/** Slide 1's reading of signIn(). `ok: true` with `configured: false` is main's "SSO isn't set up on
 *  this device" short-circuit (auth.ts): no browser opened, no session created. Consuming that as
 *  success advanced the walkthrough with nothing to show for the click, leaving the user believing they
 *  were on their work account. Mirrors SignInWall's branch on the same return value. */
export type SsoVerdict = 'signed-in' | 'not-configured' | 'failed'
export function ssoSignInVerdict(r: SignInResult): SsoVerdict {
  if (!r.ok) return 'failed'
  return r.configured === false ? 'not-configured' : 'signed-in'
}

/** Step 5's Mantu Dust path. Pure + injected (like providerTileDisabledReason) so the ORDER is testable
 *  without a render harness: dustImportCli writes the key and workspace id in the MAIN process only and
 *  there is no settings push channel — the renderer refetches settings on window 'focus', which never
 *  fires on the import path since nothing steals focus (`dust status` runs hidden, the session prompt
 *  auto-allows). Selecting Dust before the import and never re-reading afterwards left step 6 holding a
 *  pre-import snapshot, i.e. an amber "add your key" row for a workspace that was already connected. */
export async function connectDust(deps: {
  /** patch({ provider: 'dust' }) + advance. Stays first so the user isn't parked on step 5 for the import. */
  select: () => void
  importCli: () => Promise<DustCliImport>
  /** Fire-and-forget native OAuth device-flow start — it opens the browser, so the focus refetch covers it.
   *  The user finishes (code + workspace pick) in Settings, where the full flow lives. */
  setupCli: () => void
  /** Re-reads settings from main; a patch answers with the fresh snapshot. */
  refreshSettings: () => Promise<void>
  /** False once onboarding unmounted or the user left the readiness step — a late refresh must not
   *  overwrite whatever provider they picked in the meantime. */
  stillLive: () => boolean
}): Promise<void> {
  deps.select()
  const imported = await deps.importCli()
  if (!imported.ok) deps.setupCli()
  if (!deps.stillLive()) return
  await deps.refreshSettings()
}
