/**
 * The credential lifecycle seam main calls at the three real boundaries (Métis 2.12 G20, CAP-35 / R092):
 *  - a session ends (sign-out, expiry, an admin revoking the seat): the `signOut` cleanup;
 *  - a person signs in: the account-switch check, then the caller's own continuation (enrolment);
 *  - the profile is reset (Settings > Recovery): the `reset` cleanup, before the encrypted profile is archived.
 *
 * It exists as a small pure factory so main's index.ts carries one call per boundary and the behaviour is tested
 * with fake dependencies. The production wiring is lifecycle/credential-lifecycle-wiring.ts. Nothing here ever
 * throws into its caller: a cleanup that cannot finish is reported in its audit receipt, and the app carries on.
 */
import type { CredentialTrigger } from '@shared/credential-inventory'
import type { OwnerReconcileOutcome } from './credential-account-switch'

export interface CredentialLifecycleDeps {
  cleanup(trigger: CredentialTrigger): Promise<{ failed: number }>
  reconcile(): Promise<OwnerReconcileOutcome>
}

export interface CredentialLifecycle {
  /** Fire and forget: runs the sign-out cleanup after any earlier one finished. */
  onSessionCleared(): void
  /** Resolves when every started sign-out cleanup has finished (tests and orderly shutdown). */
  flush(): Promise<void>
  /** Runs the account-switch check, then `after` whatever its result. */
  onSignedIn(after: () => void): Promise<void>
  onProfileReset(): Promise<void>
}

export function createCredentialLifecycle(deps: CredentialLifecycleDeps): CredentialLifecycle {
  let pending: Promise<void> = Promise.resolve()
  const quietly = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run()
    } catch {
      /* the cleanup audits its own receipt; a lifecycle hook must never break sign-in, sign-out or recovery */
    }
  }
  return {
    onSessionCleared() {
      pending = pending.then(() => quietly(() => deps.cleanup('signOut')))
    },
    flush: () => pending,
    async onSignedIn(after) {
      await quietly(() => deps.reconcile())
      after()
    },
    onProfileReset: () => quietly(() => deps.cleanup('reset'))
  }
}
